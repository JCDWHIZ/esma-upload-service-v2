import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/config.service.js';
import { RequestContext } from '../core/request-context.js';
import {
  AppError,
  ForbiddenError,
  NotFoundError,
  StorageUnavailableError,
  ValidationError,
} from '../core/errors/app-error.js';
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
        }
      });
    }

    // Inline purge phase: delete physical objects across replica drivers
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
}
