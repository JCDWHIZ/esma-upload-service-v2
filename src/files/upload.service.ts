import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { AppConfigService } from '../config/config.service.js';
import { UploadPolicy } from '../config/policies.js';
import { RequestContext } from '../core/request-context.js';
import { newId } from '../core/identifiers.js';
import { KeyService } from '../core/storage-key.service.js';
import { toManifest, type UploadManifestResponse } from '../core/manifest.js';
import {
  type FileRecord,
  type FileReplica,
  type FileVisibility,
} from '../core/types.js';
import {
  AppError,
  ForbiddenError,
  PolicyViolationError,
  QuotaExceededError,
  RetryableError,
  StorageUnavailableError,
} from '../core/errors/app-error.js';
import { AuthorizationService } from '../authz/authorization.service.js';
import { StorageRegistry } from '../storage/registry.js';
import type { DriverUploadResult, ProviderRef } from '../storage/types.js';
import { DatabaseService } from '../db/database.service.js';
import { FileRepository } from '../db/repositories/file.repository.js';
import { ReplicaRepository } from '../db/repositories/replica.repository.js';
import { UsageRepository } from '../db/repositories/usage.repository.js';
import { OutboxWriter } from '../events/outbox-writer.js';
import { createEnvelope } from '../events/envelope.js';
import { EVENT_TYPES } from '../events/catalog.js';
import type { IngestedFile } from '../ingest/types.js';
import {
  type IQuotaGate,
  NoOpQuotaGate,
  QUOTA_GATE,
} from './quota-gate.interface.js';

export interface UploadOptions {
  folder?: string;
  visibility?: FileVisibility;
  tags?: string[];
  attributes?: Record<string, string>;
  atomic?: boolean;
  idempotencyKey?: string;
}

export type UploadOutcome =
  | {
      success: true;
      fileId: string;
      manifest: UploadManifestResponse;
      fileRecord: FileRecord;
    }
  | {
      success: false;
      fileId?: string;
      error: AppError;
      filename: string;
    };

interface CompletedUpload {
  fileRecord: FileRecord;
  ref: ProviderRef;
  size: number;
  manifest: UploadManifestResponse;
}

@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);

  constructor(
    private readonly storageRegistry: StorageRegistry,
    private readonly keyService: KeyService,
    private readonly authzService: AuthorizationService,
    private readonly configService: AppConfigService,
    private readonly databaseService: DatabaseService,
    private readonly fileRepo: FileRepository,
    private readonly replicaRepo: ReplicaRepository,
    private readonly usageRepo: UsageRepository,
    private readonly outboxWriter: OutboxWriter,
    @Optional()
    @Inject(QUOTA_GATE)
    private readonly quotaGate: IQuotaGate = new NoOpQuotaGate(),
  ) {}

  /**
   * Upload a batch of ingested files according to upload policy and options.
   * Conforms to ARCH §7.1 and BACKEND_TASKS P2-06.
   */
  async upload(
    ctx: RequestContext,
    policy: UploadPolicy,
    files: IngestedFile[],
    options?: UploadOptions,
  ): Promise<UploadOutcome[]> {
    if (files.length === 0) {
      return [];
    }

    const atomic = options?.atomic ?? true;
    const completedUploads: CompletedUpload[] = [];
    const outcomes: UploadOutcome[] = [];

    for (const file of files) {
      try {
        const completed = await this.uploadSingleInternal(
          ctx,
          policy,
          file,
          options,
        );
        completedUploads.push(completed);
        outcomes.push({
          success: true,
          fileId: completed.fileRecord.id,
          manifest: completed.manifest,
          fileRecord: completed.fileRecord,
        });
      } catch (err: unknown) {
        const appErr =
          err instanceof AppError
            ? err
            : new StorageUnavailableError('File upload failed', { cause: err });

        if (atomic) {
          await this.rollbackBatch(ctx, completedUploads);
          throw appErr;
        }

        outcomes.push({
          success: false,
          error: appErr,
          filename: file.originalName,
        });
      }
    }

    return outcomes;
  }

  /**
   * Convenience single-file upload returning the manifest directly.
   */
  async uploadSingle(
    ctx: RequestContext,
    policy: UploadPolicy,
    file: IngestedFile,
    options?: UploadOptions,
  ): Promise<UploadManifestResponse> {
    const outcomes = await this.upload(ctx, policy, [file], options);
    const first = outcomes[0];
    if (!first.success) {
      throw first.error;
    }
    return first.manifest;
  }

  private async uploadSingleInternal(
    ctx: RequestContext,
    policy: UploadPolicy,
    file: IngestedFile,
    options?: UploadOptions,
  ): Promise<CompletedUpload> {
    // 1. Visibility determination & policy check
    const visibility = options?.visibility ?? policy.defaultVisibility;
    if (!policy.allowedVisibilities.includes(visibility)) {
      throw new PolicyViolationError(
        `Visibility "${visibility}" is not allowed for namespace "${policy.namespace}". Allowed: [${policy.allowedVisibilities.join(', ')}]`,
      );
    }

    // 2. Authorization check
    const decision = this.authzService.authorize(ctx, 'upload', {
      namespace: ctx.namespace,
      tenantId: ctx.tenantId,
      subTenantId: ctx.subTenantId,
      visibility,
    });
    if (!decision.allowed) {
      throw new ForbiddenError(decision.reason);
    }

    // 3. Reserve quota through QuotaGate seam
    await this.quotaGate.reserve(ctx, file.size);

    // 4. Generate UUIDv7 fileId & build storage key
    const fileId = newId();
    const storageKey = this.keyService.build(
      {
        namespace: ctx.namespace,
        tenantId: ctx.tenantId,
        subTenantId: ctx.subTenantId,
      },
      {
        folder: options?.folder,
      },
      fileId,
      file.detectedMime,
    );

    // 5. Legacy public_id mapping for namespaces that need it
    let legacyPublicId: string | null = null;
    if (
      ctx.namespace === 'esma-tenant' ||
      ctx.namespace === 'esma-admin' ||
      policy.cloudinaryRootFolder
    ) {
      const isImage = file.detectedMime.startsWith('image/');
      legacyPublicId = this.keyService.toLegacyPublicId(
        {
          namespace: ctx.namespace,
          cloudinaryRootFolder: policy.cloudinaryRootFolder,
        },
        storageKey,
        isImage ? 'image' : 'raw',
      );
    }

    // 6. Upload to primary driver with up to 2 retries on RetryableError
    const primaryDriver = this.storageRegistry.getPrimary();
    let uploadResult: DriverUploadResult | null = null;
    let lastError: unknown;
    const maxAttempts = 3;

    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          uploadResult = await primaryDriver.upload({
            key: storageKey,
            source: () => file.openReadStream(),
            size: file.size,
            sha256: file.sha256,
            mimetype: file.detectedMime,
            visibility,
            tags: options?.tags,
            attributes: options?.attributes,
          });
          break;
        } catch (err: unknown) {
          lastError = err;
          if (err instanceof RetryableError && attempt < maxAttempts) {
            if (err.retryAfterMs && err.retryAfterMs > 0) {
              await new Promise((resolve) =>
                setTimeout(resolve, err.retryAfterMs),
              );
            }
            continue;
          }
          throw err;
        }
      }

      if (!uploadResult) {
        throw lastError instanceof AppError
          ? lastError
          : new StorageUnavailableError('Primary driver upload failed', {
              cause: lastError,
            });
      }
    } catch (driverErr: unknown) {
      await this.quotaGate.release(ctx, file.size).catch(() => {});
      throw driverErr;
    }

    // 7. Database transaction
    const db = this.databaseService?.getDb();
    if (!db) {
      // DB connection is unavailable: compensate primary upload immediately
      try {
        await primaryDriver.delete(uploadResult.ref);
      } catch (delErr: unknown) {
        this.logger.error(
          `Compensation failed: could not delete orphaned object ${uploadResult.ref.key} on ${uploadResult.ref.provider}: ${String(delErr)}`,
        );
      }
      await this.quotaGate.release(ctx, file.size).catch(() => {});
      throw new StorageUnavailableError('Database service is unavailable');
    }

    let fileRecord: FileRecord;
    let replicaRecord: FileReplica;

    try {
      const txResult = await db.transaction().execute(async (trx) => {
        // Adjust tenant usage and enforce quota
        const reserved = await this.usageRepo.tryReserve(
          ctx.namespace,
          ctx.tenantId,
          BigInt(file.size),
          1,
          trx,
        );
        if (!reserved) {
          throw new QuotaExceededError(
            `Tenant storage quota exceeded for tenant "${ctx.tenantId}" in namespace "${ctx.namespace}"`,
          );
        }

        // Insert into files table
        const inserted = await this.fileRepo.insert(
          {
            id: fileId,
            namespace: ctx.namespace,
            tenantId: ctx.tenantId,
            subTenantId: ctx.subTenantId ?? null,
            folder: options?.folder ?? '',
            storageKey,
            originalFilename: file.originalName,
            mimetype: file.detectedMime,
            declaredMimetype: file.declaredMime,
            sizeBytes: BigInt(file.size),
            sha256: file.sha256,
            visibility,
            status: 'ACTIVE',
            scanStatus: policy.requireVirusScan ? 'PENDING' : 'NOT_REQUIRED',
            replicationStatus: 'NOT_REQUIRED',
            primaryProvider: primaryDriver.name,
            uploadedBy: ctx.actor.id,
            tags: options?.tags ?? [],
            attributes: options?.attributes ?? {},
            legacyPublicId,
            idempotencyKey: options?.idempotencyKey ?? null,
            correlationId: ctx.correlationId,
          },
          trx,
        );

        // Insert primary replica record
        const replicas = await this.replicaRepo.insertMany(
          [
            {
              fileId,
              provider: primaryDriver.name,
              role: 'primary',
              status: 'AVAILABLE',
              providerKey: uploadResult.ref.key,
              providerMeta: uploadResult.ref.meta ?? {},
              url: uploadResult.url ?? null,
              etag: uploadResult.etag ?? null,
              syncedAt: new Date(),
            },
          ],
          trx,
        );

        // Outbox event (EVENTS_ENABLED is now true by default per P4-04)
        if (this.configService.eventsEnabled) {
          const uploadedEnvelope = createEnvelope({
            eventType: EVENT_TYPES.FILE_UPLOADED,
            partitionKey: fileId,
            context: ctx,
            payload: {
              fileId,
              size: file.size,
              mimetype: file.detectedMime,
              primaryProvider: primaryDriver.name,
            },
          });
          await this.outboxWriter.enqueue(trx, uploadedEnvelope);
        }

        return { file: inserted, replica: replicas[0] };
      });

      fileRecord = txResult.file;
      replicaRecord = txResult.replica;
    } catch (txErr: unknown) {
      // Compensation: best-effort delete primary object
      try {
        await primaryDriver.delete(uploadResult.ref);
      } catch (delErr: unknown) {
        this.logger.error(
          `Compensation failed: could not delete orphaned object ${uploadResult.ref.key} on ${uploadResult.ref.provider}: ${String(delErr)}`,
        );
      }
      await this.quotaGate.release(ctx, file.size).catch(() => {});

      if (txErr instanceof QuotaExceededError) {
        throw txErr;
      }

      throw new StorageUnavailableError(
        'Failed to commit upload transaction to database',
        { cause: txErr },
      );
    }

    const manifest = toManifest(
      fileRecord,
      [replicaRecord],
      this.configService.appBaseUrl,
    );

    return {
      fileRecord,
      ref: uploadResult.ref,
      size: file.size,
      manifest,
    };
  }

  private async rollbackBatch(
    ctx: RequestContext,
    completed: CompletedUpload[],
  ): Promise<void> {
    const primaryDriver = this.storageRegistry.getPrimary();

    for (const item of [...completed].reverse()) {
      try {
        await primaryDriver.delete(item.ref);
      } catch (delErr: unknown) {
        this.logger.error(
          `Compensation failed during batch rollback for ${item.ref.key}: ${String(delErr)}`,
        );
      }

      const db = this.databaseService?.getDb();
      if (db) {
        try {
          await db.transaction().execute(async (trx) => {
            await this.fileRepo.hardDelete(item.fileRecord.id, trx);
            await this.usageRepo.release(
              ctx.namespace,
              ctx.tenantId,
              BigInt(item.size),
              1,
              trx,
            );
          });
        } catch (dbErr: unknown) {
          this.logger.error(
            `Database compensation failed during batch rollback for ${item.fileRecord.id}: ${String(dbErr)}`,
          );
        }
      }

      await this.quotaGate.release(ctx, item.size).catch(() => {});
    }
  }
}
