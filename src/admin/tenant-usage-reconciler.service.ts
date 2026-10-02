import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { DatabaseService } from '../db/database.service.js';
import { UsageRepository } from '../db/repositories/usage.repository.js';

export interface ReconciliationResult {
  namespace: string;
  tenantId: string;
  recordedBytes: bigint;
  actualBytes: bigint;
  driftBytes: bigint;
  recordedFileCount: bigint;
  actualFileCount: bigint;
  driftFileCount: bigint;
  reconciled: boolean;
}

@Injectable()
export class TenantUsageReconciler {
  private readonly logger = new Logger(TenantUsageReconciler.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly usageRepo: UsageRepository,
  ) {}

  /**
   * Recalculates tenant usage from active records in `files` table and reconciles `tenant_usage`.
   */
  async reconcileTenant(
    namespace: string,
    tenantId: string,
  ): Promise<ReconciliationResult> {
    const db = this.databaseService.getDb();
    if (!db) {
      throw new Error('Database service is unavailable');
    }

    const actualRow = await sql<{
      total_bytes: string | number | bigint;
      file_count: string | number | bigint;
    }>`
      SELECT
        COALESCE(SUM(size_bytes), 0) AS total_bytes,
        COUNT(*) AS file_count
      FROM files
      WHERE namespace = ${namespace}
        AND tenant_id = ${tenantId}
        AND status != 'DELETED'
    `.execute(db);

    const actualBytes = BigInt(actualRow.rows[0]?.total_bytes ?? 0);
    const actualFileCount = BigInt(actualRow.rows[0]?.file_count ?? 0);

    const currentUsage = await this.usageRepo.get(namespace, tenantId);
    const recordedBytes = currentUsage?.bytesUsed ?? 0n;
    const recordedFileCount = currentUsage?.fileCount ?? 0n;

    const driftBytes = actualBytes - recordedBytes;
    const driftFileCount = actualFileCount - recordedFileCount;
    const isDrift = driftBytes !== 0n || driftFileCount !== 0n;

    if (isDrift) {
      this.logger.warn(
        `Usage drift detected for tenant ${tenantId} in ${namespace}: bytes drift=${driftBytes}, file count drift=${driftFileCount}. Reconciling...`,
      );

      await sql`
        INSERT INTO tenant_usage (namespace, tenant_id, bytes_used, file_count, updated_at)
        VALUES (${namespace}, ${tenantId}, ${String(actualBytes)}::bigint, ${String(actualFileCount)}::bigint, now())
        ON CONFLICT (namespace, tenant_id)
        DO UPDATE SET
          bytes_used = EXCLUDED.bytes_used,
          file_count = EXCLUDED.file_count,
          updated_at = now()
      `.execute(db);
    }

    return {
      namespace,
      tenantId,
      recordedBytes,
      actualBytes,
      driftBytes,
      recordedFileCount,
      actualFileCount,
      driftFileCount,
      reconciled: isDrift,
    };
  }
}
