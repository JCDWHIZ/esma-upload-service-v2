import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../db/database.service.js';
import { StorageRegistry } from '../storage/registry.js';
import { OutboxWriter } from '../events/outbox-writer.js';
import { createEnvelope } from '../events/envelope.js';
import { EVENT_TYPES } from '../events/catalog.js';

export interface HardDeleteOptions {
  fileId: string;
  operator?: string;
  reason?: string;
  dryRun?: boolean;
}

export interface HardDeleteResult {
  fileId: string;
  replicasDeleted: number;
  dbRecordsDeleted: boolean;
  auditEventEnqueued: boolean;
}

@Injectable()
export class HardDeleteService {
  private readonly logger = new Logger(HardDeleteService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly storageRegistry: StorageRegistry,
    private readonly outboxWriter: OutboxWriter,
  ) {}

  async hardDeleteFile(options: HardDeleteOptions): Promise<HardDeleteResult> {
    const database = this.db.getDb();
    if (!database) {
      throw new Error('Database service is unavailable');
    }

    const {
      fileId,
      operator = 'admin-cli',
      reason = 'Legal Erasure / GDPR Request',
      dryRun = false,
    } = options;

    this.logger.log(
      `Starting hard-delete for file "${fileId}" (operator: "${operator}", reason: "${reason}")${dryRun ? ' [DRY-RUN]' : ''}`,
    );

    const file = await database
      .selectFrom('files')
      .select(['id', 'tenant_id', 'namespace', 'status'])
      .where('id', '=', fileId)
      .executeTakeFirst();

    if (!file) {
      throw new NotFoundException(`File with ID "${fileId}" not found`);
    }

    const replicas = await database
      .selectFrom('file_replicas')
      .select(['provider', 'provider_key', 'status'])
      .where('file_id', '=', fileId)
      .execute();

    let replicasDeletedCount = 0;

    // 1. Purge objects across all physical storage providers
    for (const replica of replicas) {
      if (this.storageRegistry.has(replica.provider as any)) {
        const driver = this.storageRegistry.get(replica.provider as any);
        if (dryRun) {
          this.logger.log(
            `[DRY-RUN] Would delete physical storage key "${replica.provider_key}" on provider "${replica.provider}"`,
          );
          replicasDeletedCount++;
        } else {
          try {
            await driver.delete({
              provider: replica.provider as any,
              key: replica.provider_key,
            });
            replicasDeletedCount++;
            this.logger.log(
              `Purged storage object "${replica.provider_key}" on provider "${replica.provider}"`,
            );
          } catch (err: unknown) {
            this.logger.error(
              `Failed to delete physical object "${replica.provider_key}" on provider "${replica.provider}": ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    }

    if (dryRun) {
      this.logger.log(
        `[DRY-RUN] Would enqueue "file.erased" audit event and delete DB records for file "${fileId}"`,
      );
      return {
        fileId,
        replicasDeleted: replicasDeletedCount,
        dbRecordsDeleted: false,
        auditEventEnqueued: false,
      };
    }

    // 2. Perform DB deletion & audit log enqueue within a single transaction
    await database.transaction().execute(async (trx) => {
      // Enqueue audit record in outbox
      const envelope = createEnvelope({
        eventType: EVENT_TYPES.FILE_ERASED,
        partitionKey: file.id,
        payload: {
          fileId: file.id,
          tenantId: file.tenant_id,
          namespace: file.namespace,
          operator,
          reason,
          erasedAt: new Date().toISOString(),
        },
        namespace: file.namespace,
        tenantId: file.tenant_id,
      });

      await this.outboxWriter.enqueue(trx, envelope);

      // Delete replicas
      await trx
        .deleteFrom('file_replicas')
        .where('file_id', '=', fileId)
        .execute();

      // Delete file record
      await trx.deleteFrom('files').where('id', '=', fileId).execute();
    });

    this.logger.log(
      `Hard-delete completed successfully for file "${fileId}". Replicas purged: ${replicasDeletedCount}`,
    );

    return {
      fileId,
      replicasDeleted: replicasDeletedCount,
      dbRecordsDeleted: true,
      auditEventEnqueued: true,
    };
  }
}
