import { Injectable, Logger, Optional } from '@nestjs/common';
import { AppConfigService } from '../config/config.service.js';
import { RequestContext } from '../core/request-context.js';
import {
  AppError,
  ForbiddenError,
  LegalHoldError,
  NotFoundError,
  StorageUnavailableError,
  ValidationError,
} from '../core/errors/app-error.js';
import { DomainEventPublisher } from '../events/domain-event.publisher.js';
import { AuthorizationService } from '../authz/authorization.service.js';
import { StorageRegistry } from '../storage/registry.js';
import type { ProviderRef } from '../storage/types.js';
import { DatabaseService } from '../db/database.service.js';
import { FileRepository } from '../db/repositories/file.repository.js';
import { ReplicaRepository } from '../db/repositories/replica.repository.js';
import { UsageRepository } from '../db/repositories/usage.repository.js';
import { OutboxRepository } from '../db/repositories/outbox.repository.js';
import { OutboxWriter } from '../events/outbox-writer.js';
import { createEnvelope } from '../events/envelope.js';
import { EVENT_TYPES } from '../events/catalog.js';

export interface BulkDeleteResultItem {
  fileId: string;
  success: boolean;
  error?: string;
  code?: string;
}

export interface BulkDeleteResponse {
  total: number;
  deletedCount: number;
  failedCount: number;
  results: BulkDeleteResultItem[];
}

@Injectable()
export class DeleteService {
  private readonly logger = new Logger(DeleteService.name);

  constructor(
    private readonly storageRegistry: StorageRegistry,
    private readonly authzService: AuthorizationService,
    private readonly configService: AppConfigService,
    private readonly databaseService: DatabaseService,
    private readonly fileRepo: FileRepository,
    private readonly replicaRepo: ReplicaRepository,
    private readonly usageRepo: UsageRepository,
    private readonly outboxRepo: OutboxRepository,
    private readonly outboxWriter: OutboxWriter,
    @Optional()
    private readonly domainEventPublisher?: DomainEventPublisher,
  ) {}

  /**
   * Deletes a file and its replicas.
   * Conforms to ARCH §7.3 and BACKEND_TASKS P2-08.
   *
   * 1. Authorize caller against file metadata and tenant boundaries.
   * 2. In one transaction:
   *    - Set file status to DELETING
   *    - Set QUEUED replicas to DELETED, and other active replicas to DELETING
   *    - Decrement tenant usage
   *    - Enqueue 'file.purge' outbox event if events are enabled
   * 3. Inline purge phase (until P4-09 worker):
   *    - Call driver.delete() for each DELETING replica
   *    - Mark replica DELETED on success
   *    - On driver failure, leave in DELETING status for sweeper / retry
   *    - If all replicas deleted, finalize file status to DELETED
   *
   * Operation is safe and idempotent on repeated calls.
   */
  async delete(ctx: RequestContext, fileId: string): Promise<void> {
    const file = await this.fileRepo.findById(fileId);
    if (!file) {
      throw new NotFoundError(`File '${fileId}' not found`);
    }

    // Tenant isolation: callers outside the tenant boundary must receive 404
    if (!this.authzService.canAccessTenant(ctx, file.tenantId)) {
      throw new NotFoundError(`File '${fileId}' not found`);
    }

    // Authorize caller for 'delete' action
    const decision = this.authzService.authorize(ctx, 'delete', {
      namespace: file.namespace,
      tenantId: file.tenantId,
      subTenantId: file.subTenantId,
      uploadedBy: file.uploadedBy,
      visibility: file.visibility,
    });
    if (!decision.allowed) {
      throw new ForbiddenError(decision.reason);
    }

    // UR-21: Deleting files in platform-archives requires platform.files.admin
    if (file.namespace === 'platform-archives') {
      const perms = ctx.actor.permissions ?? [];
      const hasAdmin =
        perms.includes('platform.files.admin') ||
        perms.includes('*') ||
        ctx.actor.isPlatformAdmin === true;
      if (!hasAdmin) {
        throw new ForbiddenError(
          'Deleting files in platform-archives namespace requires platform.files.admin permission',
        );
      }
    }

    // UR-14.4: Legal hold check
    if (file.held) {
      throw new LegalHoldError(
        `File '${fileId}' is under legal hold and cannot be deleted`,
      );
    }

    // Idempotent: file is already fully deleted
    if (file.status === 'DELETED') {
      return;
    }

    const db = this.databaseService.getDb();
    if (!db) {
      throw new StorageUnavailableError('Database service is unavailable');
    }

    // If file is not yet in DELETING status, perform atomic state transition and decrement quota
    if (file.status !== 'DELETING') {
      await db.transaction().execute(async (trx) => {
        // Transition files.status = 'DELETING'
        await this.fileRepo.markDeleting(fileId, trx);

        // Transition replicas
        const replicas = await this.replicaRepo.listByFile(fileId, trx);
        for (const replica of replicas) {
          if (replica.status === 'QUEUED') {
            await this.replicaRepo.markDeleted(fileId, replica.provider, trx);
          } else if (replica.status !== 'DELETED') {
            await this.replicaRepo.markDeleting(fileId, replica.provider, trx);
          }
        }

        // Decrement tenant usage
        await this.usageRepo.release(
          file.namespace,
          file.tenantId,
          file.sizeBytes,
          1,
          trx,
        );

        // Enqueue outbox event if enabled (using typed envelope per P4-04)
        if (this.configService.eventsEnabled) {
          const purgeEnvelope = createEnvelope({
            eventType: EVENT_TYPES.FILE_PURGE,
            partitionKey: fileId,
            context: ctx,
            payload: { fileId },
          });
          await this.outboxWriter.enqueue(trx, purgeEnvelope);

          if (this.domainEventPublisher) {
            await this.domainEventPublisher.publish(trx, {
              eventType: 'file.deleted.v1',
              organizationId: file.tenantId,
              context: ctx,
              data: {
                fileId,
                namespace: file.namespace,
                reason: 'USER',
              },
            });
          }
        }
      });
    }

    // If PURGE_INLINE is enabled or events are disabled, execute inline purge (for environments without a worker)
    if (this.configService.purgeInline || !this.configService.eventsEnabled) {
      await this.executeInlinePurge(ctx, fileId);
    }
  }

  /**
   * Executes driver-level inline purge across all DELETING replicas.
   * Used when PURGE_INLINE=true or when events are disabled.
   */
  private async executeInlinePurge(
    ctx: RequestContext,
    fileId: string,
  ): Promise<void> {
    const replicas = await this.replicaRepo.listByFile(fileId);
    const deletingReplicas = replicas.filter((r) => r.status === 'DELETING');

    let allReplicasPurged = true;
    for (const replica of deletingReplicas) {
      try {
        const driver = this.storageRegistry.get(replica.provider);
        const ref: ProviderRef = {
          provider: replica.provider,
          key: replica.providerKey,
          meta: replica.providerMeta,
        };
        await driver.delete(ref);
        await this.replicaRepo.markDeleted(fileId, replica.provider);
      } catch (err: unknown) {
        allReplicasPurged = false;
        this.logger.error(
          `Failed to purge replica on ${replica.provider} for file ${fileId}: ${String(err)}`,
          {
            correlationId: ctx.correlationId,
            fileId,
            provider: replica.provider,
          },
        );
      }
    }

    // Purge image derivatives on primary storage provider (P5-08)
    const file = await this.fileRepo.findById(fileId);
    if (file?.derivatives && typeof file.derivatives === 'object') {
      try {
        const primaryDriver = this.storageRegistry.get(file.primaryProvider);
        for (const [varName, deriv] of Object.entries(file.derivatives)) {
          if (deriv && typeof deriv === 'object' && deriv.key) {
            try {
              await primaryDriver.delete({
                provider: file.primaryProvider,
                key: deriv.key,
              });
            } catch (derivErr: unknown) {
              this.logger.warn(
                `Failed to purge derivative "${varName}" for file ${fileId}: ${String(derivErr)}`,
              );
            }
          }
        }
      } catch (err: unknown) {
        this.logger.warn(
          `Could not access primary driver to purge derivatives for file ${fileId}: ${String(err)}`,
        );
      }
    }

    if (allReplicasPurged) {
      await this.fileRepo.markDeleted(fileId);
    } else {
      this.logger.warn(
        `File ${fileId} left in DELETING status due to replica driver deletion failure`,
        {
          correlationId: ctx.correlationId,
          fileId,
        },
      );
    }
  }

  /**
   * Bulk deletes a list of file IDs (up to 100).
   * Returns per-ID results.
   */
  async bulkDelete(
    ctx: RequestContext,
    fileIds: string[],
  ): Promise<BulkDeleteResponse> {
    if (!Array.isArray(fileIds) || fileIds.length === 0) {
      throw new ValidationError(
        'fileIds must be a non-empty array of file IDs',
      );
    }

    if (fileIds.length > 100) {
      throw new ValidationError(
        'Cannot bulk delete more than 100 files at once',
      );
    }

    const results: BulkDeleteResultItem[] = [];
    let deletedCount = 0;
    let failedCount = 0;

    for (const fileId of fileIds) {
      try {
        await this.delete(ctx, fileId);
        results.push({ fileId, success: true });
        deletedCount++;
      } catch (err: unknown) {
        failedCount++;
        if (err instanceof AppError) {
          results.push({
            fileId,
            success: false,
            error: err.message,
            code: err.code,
          });
        } else {
          results.push({
            fileId,
            success: false,
            error: String(err),
            code: 'INTERNAL_ERROR',
          });
        }
      }
    }

    return {
      total: fileIds.length,
      deletedCount,
      failedCount,
      results,
    };
  }

  /**
   * Bulk deletes files matching an owner (UR-06).
   * Deletes all matching files synchronously up to 1,000.
   */
  async deleteByOwner(
    ctx: RequestContext,
    ownerType: string,
    ownerId: string,
    namespace?: string,
  ): Promise<{ deleted: number }> {
    if (!ownerType || !ownerId) {
      throw new ValidationError('ownerType and ownerId are required');
    }

    const tenantId = ctx.tenantId;
    if (!tenantId) {
      throw new ValidationError('Tenant context is required');
    }

    const files = await this.fileRepo.findByOwner(
      tenantId,
      ownerType,
      ownerId,
      namespace,
      1000,
    );

    let deleted = 0;
    for (const file of files) {
      try {
        await this.delete(ctx, file.id);
        deleted++;
      } catch (err: unknown) {
        this.logger.warn(
          `Failed to delete file ${file.id} in deleteByOwner: ${String(err)}`,
        );
      }
    }

    return { deleted };
  }
}
