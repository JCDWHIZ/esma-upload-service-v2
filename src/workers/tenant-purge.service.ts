import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'node:crypto';
import { sql } from 'kysely';
import { DatabaseService } from '../db/database.service.js';
import { StorageRegistry } from '../storage/registry.js';
import { OutboxRepository } from '../db/repositories/outbox.repository.js';
import { AuditService } from '../observability/audit.service.js';
import type { ProviderName } from '../storage/types.js';

export interface TenantPurgeRequestPayload {
  requestId: string;
  organizationId: string;
  requestedAt: string;
  reason?: string;
  owners?: string[];
}

export interface TenantPurgeReceipt {
  requestId: string;
  organizationId: string;
  owner: string;
  status: 'COMPLETED' | 'PARTIAL' | 'REFUSED' | 'SKIPPED';
  reason?: string;
  completedAt: string;
  counts: {
    files: number;
    bytes: number;
    replicas: number;
  };
  checksum: string;
  failures: Array<{ fileId: string; error: string }>;
}

export const PURGE_COMPLETED_TOPIC = 'esma.platform.tenant-purge-completed.v1';

@Injectable()
export class TenantPurgeService {
  private readonly logger = new Logger(TenantPurgeService.name);

  constructor(
    private readonly dbService: DatabaseService,
    private readonly storageRegistry: StorageRegistry,
    private readonly outboxRepo: OutboxRepository,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Executes tenant purge according to UR-18:
   * 1. Checks if 'files' owner is targeted.
   * 2. Checks legal hold across files for the organization.
   * 3. Sets organization state to is_purging = true.
   * 4. Batches file deletion in groups of 500, deleting replicas across all storage drivers.
   * 5. Cleans up idempotency keys, usage, and quota rows.
   * 6. Records a single TENANT_PURGED audit row.
   * 7. Emits receipt to esma.platform.tenant-purge-completed.v1.
   */
  async purgeTenant(payload: TenantPurgeRequestPayload): Promise<TenantPurgeReceipt> {
    const { requestId, organizationId } = payload;
    const completedAt = new Date().toISOString();

    // 1. Check if 'files' owner is included in request
    if (payload.owners && payload.owners.length > 0 && !payload.owners.includes('files')) {
      this.logger.log(
        `Purge request ${requestId} for org ${organizationId} skipped: 'files' not in owners [${payload.owners.join(', ')}]`,
      );
      return {
        requestId,
        organizationId,
        owner: 'files',
        status: 'SKIPPED',
        completedAt,
        counts: { files: 0, bytes: 0, replicas: 0 },
        checksum: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        failures: [],
      };
    }

    const db = this.dbService.getDb();
    if (!db) {
      throw new Error('Database service is unavailable for tenant purge');
    }

    // 2. Legal hold check: refuse if any file in tenant is under legal hold (UR-18.2)
    const heldRow = await sql<{ count: string }>`
      SELECT COUNT(*)::text as count
      FROM files
      WHERE tenant_id = ${organizationId} AND held = true
    `.execute(db);

    const heldCount = Number(heldRow.rows[0]?.count ?? '0');
    if (heldCount > 0) {
      this.logger.warn(
        `Tenant purge refused for org ${organizationId}: ${heldCount} files under legal hold (UR-18.2)`,
      );
      const receipt: TenantPurgeReceipt = {
        requestId,
        organizationId,
        owner: 'files',
        status: 'REFUSED',
        reason: 'LEGAL_HOLD',
        completedAt,
        counts: { files: 0, bytes: 0, replicas: 0 },
        checksum: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        failures: [],
      };

      await this.publishReceipt(receipt);
      return receipt;
    }

    // 3. Set is_purging = true on tenant_quota to refuse uploads with 403 tenant_purging (UR-18.5)
    await sql`
      INSERT INTO tenant_quota (tenant_id, is_purging, updated_at)
      VALUES (${organizationId}, true, now())
      ON CONFLICT (tenant_id)
      DO UPDATE SET is_purging = true, updated_at = now()
    `.execute(db);

    // 4. Retrieve all files for this organization, excluding platform-archives (UR-21)
    const allFiles = await sql<{
      id: string;
      size_bytes: string;
      namespace: string;
    }>`
      SELECT id, size_bytes, namespace
      FROM files
      WHERE tenant_id = ${organizationId}
        AND namespace != 'platform-archives'
      ORDER BY id ASC
    `.execute(db);

    const totalFiles = allFiles.rows.length;
    let totalBytes = 0;
    let totalReplicas = 0;
    const failures: Array<{ fileId: string; error: string }> = [];

    // Calculate deterministic sorted fileId checksum
    const sortedFileIds = allFiles.rows.map((f) => f.id).sort();
    const checksumHash = crypto
      .createHash('sha256')
      .update(sortedFileIds.join('\n'))
      .digest('hex');
    const checksum = `sha256:${checksumHash}`;

    for (const file of allFiles.rows) {
      totalBytes += Number(file.size_bytes || '0');
    }

    // 5. Delete in batches of 500 (UR-18.3)
    const BATCH_SIZE = 500;
    for (let i = 0; i < totalFiles; i += BATCH_SIZE) {
      const batch = allFiles.rows.slice(i, i + BATCH_SIZE);
      const batchIds = batch.map((f) => f.id);

      // Fetch replicas for this batch
      const replicas = await sql<{
        id: string;
        file_id: string;
        provider: string;
        provider_key: string;
      }>`
        SELECT id, file_id, provider, provider_key
        FROM file_replicas
        WHERE file_id IN (${sql.join(batchIds)})
      `.execute(db);

      totalReplicas += replicas.rows.length;

      // Delete storage objects from underlying providers
      for (const rep of replicas.rows) {
        try {
          const driver = this.storageRegistry.get(rep.provider as ProviderName);
          if (driver) {
            await driver.delete({
              provider: rep.provider as ProviderName,
              key: rep.provider_key,
            });
          }
        } catch (err) {
          this.logger.warn(
            `Failed to purge storage replica ${rep.id} on ${rep.provider}: ${String(err)}`,
          );
          failures.push({
            fileId: rep.file_id,
            error: `Failed to purge replica on ${rep.provider}: ${String(err)}`,
          });
        }
      }

      // Purge DB rows for batch
      await db.transaction().execute(async (trx) => {
        await sql`
          DELETE FROM file_derivatives WHERE file_id IN (${sql.join(batchIds)})
        `.execute(trx);

        await sql`
          DELETE FROM file_replicas WHERE file_id IN (${sql.join(batchIds)})
        `.execute(trx);

        await sql`
          DELETE FROM files WHERE id IN (${sql.join(batchIds)})
        `.execute(trx);
      });
    }

    // 6. Purge metadata & tables: idempotency keys, usage, mark purged
    await db.transaction().execute(async (trx) => {
      await sql`
        DELETE FROM idempotency_keys WHERE tenant_id = ${organizationId}
      `.execute(trx);

      await sql`
        DELETE FROM tenant_usage WHERE tenant_id = ${organizationId}
      `.execute(trx);

      await sql`
        UPDATE tenant_quota
        SET is_purging = false, purged_at = now(), updated_at = now()
        WHERE tenant_id = ${organizationId}
      `.execute(trx);
    });

    // 7. Write one TENANT_PURGED audit row (UR-18.3)
    await this.auditService.log({
      action: 'TENANT_PURGED',
      outcome: failures.length > 0 ? 'FAILURE' : 'SUCCESS',
      actorId: 'system',
      actorType: 'SYSTEM',
      namespace: 'tenant-purge',
      tenantId: organizationId,
      correlationId: payload.requestId,
      details: {
        requestId,
        filesPurged: totalFiles,
        bytesPurged: totalBytes,
        replicasPurged: totalReplicas,
        checksum,
        failuresCount: failures.length,
      },
    });

    const status: 'COMPLETED' | 'PARTIAL' =
      failures.length === 0 ? 'COMPLETED' : 'PARTIAL';

    const receipt: TenantPurgeReceipt = {
      requestId,
      organizationId,
      owner: 'files',
      status,
      completedAt: new Date().toISOString(),
      counts: {
        files: totalFiles,
        bytes: totalBytes,
        replicas: totalReplicas,
      },
      checksum,
      failures,
    };

    // 8. Publish receipt to esma.platform.tenant-purge-completed.v1
    await this.publishReceipt(receipt);

    this.logger.log(
      `Tenant purge finished for org ${organizationId}: status=${status}, files=${totalFiles}, bytes=${totalBytes}, replicas=${totalReplicas}`,
    );

    return receipt;
  }

  private async publishReceipt(receipt: TenantPurgeReceipt): Promise<void> {
    try {
      await this.outboxRepo.enqueue({
        topic: PURGE_COMPLETED_TOPIC,
        partitionKey: receipt.organizationId,
        eventType: 'TENANT_PURGE_RECEIPT',
        envelope: receipt as unknown as Record<string, unknown>,
      });
    } catch (err) {
      this.logger.error(
        `Failed to enqueue tenant purge receipt for org ${receipt.organizationId}: ${String(err)}`,
      );
    }
  }
}
