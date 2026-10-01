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
  type NewFileReplica,
  type Provider,
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
import { StoragePlacementService } from '../storage/placement.service.js';
import type {
  DriverUploadResult,
  IStorageDriver,
  ProviderName,
  ProviderRef,
} from '../storage/types.js';
import { DatabaseService } from '../db/database.service.js';
import { FileRepository } from '../db/repositories/file.repository.js';
import { ReplicaRepository } from '../db/repositories/replica.repository.js';
import { UsageRepository } from '../db/repositories/usage.repository.js';
import { OutboxWriter } from '../events/outbox-writer.js';
import { createEnvelope } from '../events/envelope.js';
import { EVENT_TYPES } from '../events/catalog.js';
import { deriveReplicationStatus } from '../core/replication-state.js';
import type { IngestedFile } from '../ingest/types.js';
import {
  type IQuotaGate,
  NoOpQuotaGate,
  QUOTA_GATE,
} from './quota-gate.interface.js';

export interface UploadMetrics {
  primaryFailovers: number;
}

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
  private readonly metrics: UploadMetrics = {
    primaryFailovers: 0,
  };

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
    @Optional()
    private readonly storagePlacement?: StoragePlacementService,
  ) {}

  public getMetrics(): Readonly<UploadMetrics> {
    return { ...this.metrics };
  }

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

    // 6. Plan placement candidates (primary candidates + secondary targets)
    const placementPlan = this.storagePlacement
      ? this.storagePlacement.plan(ctx, policy, {
          size: file.size,
          detectedMime: file.detectedMime,
          visibility,
        })
      : {
          primaryCandidates: [this.storageRegistry.getPrimary().name],
          secondaries: [] as ProviderName[],
        };

    if (placementPlan.primaryCandidates.length === 0) {
      throw new StorageUnavailableError(
        'No primary storage driver candidate is available for upload',
      );
    }

    const preferredPrimary = placementPlan.primaryCandidates[0];
    let primaryDriver: IStorageDriver | null = null;
    let uploadResult: DriverUploadResult | null = null;
    let lastError: unknown;
    const perDriverMaxRetries = 1;

    try {
      for (const candidateName of placementPlan.primaryCandidates) {
        if (!this.storageRegistry.has(candidateName)) {
          continue;
        }

        const candidateDriver = this.storageRegistry.get(candidateName);
        let candidateSuccess = false;
        const candidateStartTime = Date.now();

        for (let attempt = 1; attempt <= perDriverMaxRetries + 1; attempt++) {
          try {
            uploadResult = await candidateDriver.upload({
              key: storageKey,
              source: () => file.openReadStream(),
              size: file.size,
              sha256: file.sha256,
              mimetype: file.detectedMime,
              visibility,
              tags: options?.tags,
              attributes: options?.attributes,
            });
            primaryDriver = candidateDriver;
            candidateSuccess = true;

            const duration = Date.now() - candidateStartTime;
            this.logger.debug(
              `Uploaded file ${fileId} to primary candidate "${candidateName}" in ${duration}ms`,
            );

            if (candidateName !== preferredPrimary) {
              this.metrics.primaryFailovers++;
              this.logger.warn(
                `Primary storage failed over from "${preferredPrimary}" to "${candidateName}" for file ${fileId}`,
              );
            }
            break;
          } catch (err: unknown) {
            lastError = err;
            if (
              err instanceof RetryableError &&
              attempt <= perDriverMaxRetries
            ) {
              if (err.retryAfterMs && err.retryAfterMs > 0) {
                await new Promise((resolve) =>
                  setTimeout(resolve, err.retryAfterMs),
                );
              }
              continue;
            }
            this.logger.warn(
              `Candidate primary driver "${candidateName}" failed: ${err instanceof Error ? err.message : String(err)}. Checking next candidate...`,
            );
            break;
          }
        }

        if (candidateSuccess && uploadResult && primaryDriver) {
          break;
        }
      }

      if (!uploadResult || !primaryDriver) {
        throw lastError instanceof AppError
          ? lastError
          : new StorageUnavailableError(
              'All primary storage candidates failed',
              {
                cause: lastError,
              },
            );
      }
    } catch (driverErr: unknown) {
      await this.quotaGate.release(ctx, file.size).catch(() => {});
      throw driverErr;
    }

    // 7. Determine planned secondaries & skipped providers
    const plannedSecondaries = placementPlan.secondaries.filter(
      (s) => s !== primaryDriver.name,
    );

    let skippedProviders: Provider[] = [];
    try {
      const topology = this.storageRegistry.getTopology();
      if (topology && Array.isArray(topology.secondaries)) {
        skippedProviders = topology.secondaries.filter(
          (p) => p !== primaryDriver.name && !plannedSecondaries.includes(p),
        );
      }
    } catch {
      // Single-driver mode or topology not initialized
    }

    // 8. Database transaction
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
    let allReplicas: FileReplica[];

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

        // Build replica records to insert (primary AVAILABLE + secondaries QUEUED)
        const replicaRecordsToInsert: NewFileReplica[] = [
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
        ];

        for (const secondaryName of plannedSecondaries) {
          let secondaryProviderKey = storageKey;
          if (secondaryName === 'cloudinary') {
            if (this.storageRegistry.has('cloudinary')) {
              const cDriver = this.storageRegistry.get('cloudinary');
              if (
                cDriver &&
                typeof (cDriver as unknown as { computePublicId?: unknown })
                  .computePublicId === 'function'
              ) {
                const res = (
                  cDriver as unknown as {
                    computePublicId: (
                      k: string,
                      m?: string,
                    ) => {
                      publicId: string;
                    };
                  }
                ).computePublicId(storageKey, file.detectedMime);
                secondaryProviderKey = res.publicId;
              } else if (legacyPublicId) {
                secondaryProviderKey = legacyPublicId;
              }
            } else if (legacyPublicId) {
              secondaryProviderKey = legacyPublicId;
            }
          }

          replicaRecordsToInsert.push({
            fileId,
            provider: secondaryName,
            role: 'secondary',
            status: 'QUEUED',
            providerKey: secondaryProviderKey,
            providerMeta: {},
            url: null,
            etag: null,
            syncedAt: null,
          });
        }

        const derivedReplicationStatus = deriveReplicationStatus(
          replicaRecordsToInsert.map((r) => ({
            role: r.role,
            status: r.status ?? 'QUEUED',
          })),
        );

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
            replicationStatus: derivedReplicationStatus,
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

        // Insert replica records
        const insertedReplicas = await this.replicaRepo.insertMany(
          replicaRecordsToInsert,
          trx,
        );

        // Outbox events
        if (this.configService.eventsEnabled) {
          // 1. file.uploaded event
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

          // 2. file.replicate event per planned secondary
          for (const secondaryName of plannedSecondaries) {
            const replicateEnvelope = createEnvelope({
              eventType: EVENT_TYPES.FILE_REPLICATE,
              partitionKey: fileId,
              context: ctx,
              payload: {
                fileId,
                targetProvider: secondaryName,
              },
            });
            await this.outboxWriter.enqueue(trx, replicateEnvelope);
          }

          // 3. file.scan event when virus scanning is required (P5-07)
          if (policy.requireVirusScan) {
            const scanEnvelope = createEnvelope({
              eventType: EVENT_TYPES.FILE_SCAN,
              partitionKey: fileId,
              context: ctx,
              payload: {
                fileId,
              },
            });
            await this.outboxWriter.enqueue(trx, scanEnvelope);
          }
        }

        return { file: inserted, replicas: insertedReplicas };
      });

      fileRecord = txResult.file;
      allReplicas = txResult.replicas;
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
      allReplicas,
      this.configService.appBaseUrl,
      { skippedProviders },
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
    for (const item of [...completed].reverse()) {
      try {
        const driver = this.storageRegistry.has(item.ref.provider)
          ? this.storageRegistry.get(item.ref.provider)
          : this.storageRegistry.getPrimary();
        await driver.delete(item.ref);
      } catch (delErr: unknown) {
        this.logger.error(
          `Compensation failed during batch rollback for ${item.ref.key} on ${item.ref.provider}: ${String(delErr)}`,
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
