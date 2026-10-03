import { Injectable, Logger } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { StorageRegistry } from '../storage/registry.js';
import type { SeaweedFSStorageDriver } from '../storage/drivers/seaweedfs.driver.js';
import { FileRepository } from '../db/repositories/file.repository.js';
import { ReplicaRepository } from '../db/repositories/replica.repository.js';
import { UsageRepository } from '../db/repositories/usage.repository.js';
import { OutboxRepository } from '../db/repositories/outbox.repository.js';
import { PolicyRegistry } from '../config/policy-registry.js';
import { AuthorizationService } from '../authz/authorization.service.js';
import { evaluateBranchAccess } from '../authz/branch-access.js';
import { KeyService } from '../core/storage-key.service.js';
import { AppConfigService } from '../config/config.service.js';
import { DatabaseService } from '../db/database.service.js';
import { toManifest, type UploadManifestResponse } from '../core/manifest.js';
import type { RequestContext } from '../core/request-context.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PayloadTooLargeError,
  PolicyViolationError,
  QuotaExceededError,
  StorageUnavailableError,
  UnsupportedMediaTypeError,
  ValidationError,
} from '../core/errors/app-error.js';
import type {
  InitiatePresignedUploadDto,
  InitiatePresignedUploadResponse,
  CompletePresignedUploadDto,
} from './dto/presigned-upload.dto.js';

@Injectable()
export class PresignedUploadService {
  private readonly logger = new Logger(PresignedUploadService.name);

  constructor(
    private readonly storageRegistry: StorageRegistry,
    private readonly fileRepo: FileRepository,
    private readonly replicaRepo: ReplicaRepository,
    private readonly usageRepo: UsageRepository,
    private readonly outboxRepo: OutboxRepository,
    private readonly policyRegistry: PolicyRegistry,
    private readonly authzService: AuthorizationService,
    private readonly configService: AppConfigService,
    private readonly databaseService: DatabaseService,
  ) {}

  /**
   * Initiates direct-to-storage presigned PUT flow:
   * 1. Validates branch access and MIME allowlist.
   * 2. Checks and reserves tenant quota.
   * 3. Generates deterministic storage key and S3 presigned PUT URL.
   * 4. Persists PENDING_UPLOAD record with TTL.
   */
  async initiate(
    ctx: RequestContext,
    request: InitiatePresignedUploadDto,
  ): Promise<InitiatePresignedUploadResponse> {
    if (!request.filename || request.filename.trim().length === 0) {
      throw new ValidationError('filename is required');
    }
    if (typeof request.sizeBytes !== 'number' || request.sizeBytes <= 0) {
      throw new ValidationError('sizeBytes must be a positive number');
    }
    if (!request.mimeType || request.mimeType.trim().length === 0) {
      throw new ValidationError('mimeType is required');
    }

    const targetBranchId = request.branchId ?? ctx.subTenantId;

    // 1. Validate branch authority
    const branchDecision = evaluateBranchAccess({
      targetBranchId,
      branchGrants: ctx.actor.branchGrants ?? [],
      isSchoolAdmin: Boolean(ctx.actor.isSchoolAdmin),
      isPlatformAdmin: Boolean(ctx.actor.isPlatformAdmin),
    });
    if (!branchDecision.allowed) {
      throw new ForbiddenError(branchDecision.reason ?? 'Branch access denied');
    }

    // 2. Upload policy check
    const policy = this.policyRegistry.get(ctx.namespace);
    if (!policy.allowedMimeTypes.includes(request.mimeType)) {
      throw new UnsupportedMediaTypeError(
        `Media type "${request.mimeType}" is not allowed for namespace "${policy.namespace}"`,
        {
          detail: `Allowed types: ${policy.allowedMimeTypes.join(', ')}`,
        },
      );
    }

    if (request.sizeBytes > policy.maxFileSizeBytes) {
      throw new PayloadTooLargeError(
        `File size (${request.sizeBytes} bytes) exceeds maximum allowable size of ${policy.maxFileSizeBytes} bytes`,
        {
          detail: `Size: ${request.sizeBytes} bytes, limit: ${policy.maxFileSizeBytes} bytes`,
        },
      );
    }

    const visibility = request.visibility ?? policy.defaultVisibility;
    if (!policy.allowedVisibilities.includes(visibility)) {
      throw new PolicyViolationError(
        `Visibility "${visibility}" is not allowed for namespace "${policy.namespace}". Allowed: [${policy.allowedVisibilities.join(', ')}]`,
      );
    }

    // 3. Authorization check
    const decision = this.authzService.authorize(ctx, 'upload', {
      namespace: ctx.namespace,
      tenantId: ctx.tenantId,
      subTenantId: targetBranchId,
      visibility,
    });
    if (!decision.allowed) {
      throw new ForbiddenError(decision.reason ?? 'Upload access denied');
    }

    // 4. Resolve SeaweedFS S3 storage driver
    const seaweedDriver = this.storageRegistry.get('seaweedfs') as
      SeaweedFSStorageDriver | undefined;
    if (!seaweedDriver || !seaweedDriver.isConfigured()) {
      throw new StorageUnavailableError(
        'SeaweedFS S3 storage driver is not available or configured',
      );
    }

    // 5. Reserve quota upfront
    const reserved = await this.usageRepo.tryReserve(
      ctx.namespace,
      ctx.tenantId,
      BigInt(request.sizeBytes),
      1,
    );
    if (!reserved) {
      throw new QuotaExceededError(
        `Tenant storage quota exceeded for tenant "${ctx.tenantId}" in namespace "${ctx.namespace}"`,
      );
    }

    // 6. Build storage key and TTL
    const fileId = uuidv7();
    const storageKey = KeyService.build(
      {
        namespace: ctx.namespace,
        tenantId: ctx.tenantId,
        subTenantId: targetBranchId,
      },
      {
        folder: request.folder,
      },
      fileId,
      request.mimeType,
    );

    const ttlSeconds = request.expiresInSeconds ?? 900;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    // 7. Mint presigned PUT URL
    let presigned: {
      uploadUrl: string;
      requiredHeaders: Record<string, string>;
    };
    try {
      presigned = await seaweedDriver.getPresignedUploadUrl(
        storageKey,
        request.mimeType,
        ttlSeconds,
      );
    } catch (err: unknown) {
      await this.usageRepo
        .release(ctx.namespace, ctx.tenantId, BigInt(request.sizeBytes), 1)
        .catch(() => {});
      throw err;
    }

    // 8. Insert PENDING_UPLOAD record into DB
    try {
      await this.fileRepo.insert({
        id: fileId,
        namespace: ctx.namespace,
        tenantId: ctx.tenantId,
        subTenantId: targetBranchId ?? null,
        folder: request.folder ?? '',
        storageKey,
        originalFilename: request.filename,
        mimetype: request.mimeType,
        declaredMimetype: request.mimeType,
        sizeBytes: BigInt(request.sizeBytes),
        sha256: null,
        visibility,
        status: 'PENDING_UPLOAD',
        scanStatus: policy.requireVirusScan ? 'PENDING' : 'NOT_REQUIRED',
        replicationStatus: 'NOT_REQUIRED',
        primaryProvider: 'seaweedfs',
        uploadedBy: ctx.actor.id,
        tags: request.tags ?? [],
        attributes: request.attributes ?? {},
        legacyPublicId: null,
        idempotencyKey: null,
        correlationId: ctx.correlationId,
        expiresAt,
      });
    } catch (dbErr: unknown) {
      await this.usageRepo
        .release(ctx.namespace, ctx.tenantId, BigInt(request.sizeBytes), 1)
        .catch(() => {});
      throw dbErr;
    }

    return {
      fileId,
      uploadUrl: presigned.uploadUrl,
      requiredHeaders: presigned.requiredHeaders,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Completes direct upload flow:
   * 1. Confirms object existence and byte size via HeadObject on SeaweedFS.
   * 2. In one transaction: transitions status to ACTIVE, registers primary replica,
   *    adjusts quota delta, and enqueues file.uploaded outbox event.
   * 3. Returns standard manifest.
   */
  async complete(
    ctx: RequestContext,
    fileId: string,
    options?: CompletePresignedUploadDto,
  ): Promise<UploadManifestResponse> {
    const file = await this.fileRepo.findById(fileId);
    if (!file || file.status === 'DELETED' || file.status === 'DELETING') {
      throw new NotFoundError(`File "${fileId}" not found`);
    }

    // Tenant isolation: return 404 on cross-tenant discovery attempt
    if (file.tenantId !== ctx.tenantId || file.namespace !== ctx.namespace) {
      throw new NotFoundError(`File "${fileId}" not found`);
    }

    // Branch authorization if file is branch-scoped
    if (file.subTenantId) {
      const branchDecision = evaluateBranchAccess({
        targetBranchId: file.subTenantId,
        branchGrants: ctx.actor.branchGrants ?? [],
        isSchoolAdmin: Boolean(ctx.actor.isSchoolAdmin),
        isPlatformAdmin: Boolean(ctx.actor.isPlatformAdmin),
      });
      if (!branchDecision.allowed) {
        throw new ForbiddenError(
          branchDecision.reason ?? 'Branch access denied',
        );
      }
    }

    // Authorization check
    const decision = this.authzService.authorize(ctx, 'upload', {
      namespace: file.namespace,
      tenantId: file.tenantId,
      subTenantId: file.subTenantId,
      visibility: file.visibility,
    });
    if (!decision.allowed) {
      throw new ForbiddenError(decision.reason ?? 'Upload access denied');
    }

    // Idempotent completion check
    if (file.status === 'ACTIVE') {
      const replicas = await this.replicaRepo.listByFile(file.id);
      return toManifest(file, replicas, this.configService.appBaseUrl);
    }

    if (file.status !== 'PENDING_UPLOAD') {
      throw new ConflictError(
        `File is in invalid status "${file.status}" for upload completion`,
      );
    }

    // Verify SeaweedFS S3 object existence and get real content length
    const seaweedDriver = this.storageRegistry.get('seaweedfs') as
      SeaweedFSStorageDriver | undefined;
    if (!seaweedDriver || !seaweedDriver.isConfigured()) {
      throw new StorageUnavailableError(
        'SeaweedFS S3 storage driver is not available',
      );
    }

    const stat = await seaweedDriver.stat({
      provider: 'seaweedfs',
      key: file.storageKey,
    });

    if (!stat) {
      throw new StorageUnavailableError(
        `Storage object "${file.storageKey}" not found in SeaweedFS S3`,
      );
    }

    const actualSize = stat.size;
    const sizeDelta = BigInt(actualSize) - file.sizeBytes;

    const db = this.databaseService.getDb();
    if (!db) {
      throw new StorageUnavailableError('Database service is unavailable');
    }

    const txResult = await db.transaction().execute(async (trx) => {
      // Adjust quota delta if actual file size differs from reserved size
      if (sizeDelta > 0n) {
        const reservedExtra = await this.usageRepo.tryReserve(
          ctx.namespace,
          ctx.tenantId,
          sizeDelta,
          0,
          trx,
        );
        if (!reservedExtra) {
          throw new QuotaExceededError(
            `Tenant storage quota exceeded for actual file size (${actualSize} bytes)`,
          );
        }
      } else if (sizeDelta < 0n) {
        await this.usageRepo.release(
          ctx.namespace,
          ctx.tenantId,
          -sizeDelta,
          0,
          trx,
        );
      }

      // Update file status to ACTIVE and nullify expiresAt
      const updatedFile = await this.fileRepo.updateStatus(
        file.id,
        file.version,
        {
          status: 'ACTIVE',
          sizeBytes: actualSize,
          sha256: options?.sha256 ?? file.sha256,
          expiresAt: null,
        },
        trx,
      );

      // Insert primary replica record
      const replicas = await this.replicaRepo.insertMany(
        [
          {
            fileId: file.id,
            provider: 'seaweedfs',
            role: 'primary',
            status: 'AVAILABLE',
            providerKey: file.storageKey,
            providerMeta: {
              etag: stat.etag ?? options?.clientEtag,
              contentType: stat.contentType,
            },
            url: null,
            etag: stat.etag ?? options?.clientEtag ?? null,
            syncedAt: new Date(),
          },
        ],
        trx,
      );

      // Outbox event for asynchronous replication to secondary drivers
      if (this.configService.eventsEnabled) {
        await this.outboxRepo.enqueue(
          {
            topic: 'file.uploaded',
            partitionKey: file.id,
            eventType: 'file.uploaded',
            envelope: {
              fileId: file.id,
              namespace: file.namespace,
              tenantId: file.tenantId,
              subTenantId: file.subTenantId,
              folder: file.folder,
              storageKey: file.storageKey,
              originalFilename: file.originalFilename,
              mimetype: file.mimetype,
              sizeBytes: actualSize,
              sha256: updatedFile.sha256 ?? file.sha256,
              visibility: file.visibility,
              primaryProvider: 'seaweedfs',
              createdAt: file.createdAt.toISOString(),
            },
          },
          trx,
        );
      }

      return { file: updatedFile, replica: replicas[0] };
    });

    return toManifest(
      txResult.file,
      [txResult.replica],
      this.configService.appBaseUrl,
    );
  }

  /**
   * Sweeps abandoned PENDING_UPLOAD files where expiresAt < now - gracePeriod:
   * - Deletes uncommitted S3 key (best effort)
   * - Releases reserved quota
   * - Sets file status to DELETED
   */
  async sweepExpired(
    gracePeriodSeconds = 300,
  ): Promise<{ sweptCount: number }> {
    const cutoff = new Date(Date.now() - gracePeriodSeconds * 1000);
    const expired = await this.fileRepo.findExpiredPendingUploads(cutoff);
    let sweptCount = 0;

    const seaweedDriver = this.storageRegistry.get('seaweedfs') as
      SeaweedFSStorageDriver | undefined;

    const db = this.databaseService.getDb();
    if (!db) {
      return { sweptCount: 0 };
    }

    for (const item of expired) {
      try {
        if (seaweedDriver && seaweedDriver.isConfigured()) {
          await seaweedDriver
            .delete({
              provider: 'seaweedfs',
              key: item.storageKey,
            })
            .catch((delErr: unknown) => {
              this.logger.warn(
                `Failed to delete uncommitted S3 key ${item.storageKey}: ${String(delErr)}`,
              );
            });
        }

        await db.transaction().execute(async (trx) => {
          await this.usageRepo.release(
            item.namespace,
            item.tenantId,
            item.sizeBytes,
            1,
            trx,
          );

          await this.fileRepo.updateStatus(
            item.id,
            item.version,
            {
              status: 'DELETED',
            },
            trx,
          );
        });

        sweptCount++;
      } catch (err: unknown) {
        this.logger.warn(
          `Failed to sweep expired pending upload ${item.id}: ${String(err)}`,
        );
      }
    }

    return { sweptCount };
  }
}
