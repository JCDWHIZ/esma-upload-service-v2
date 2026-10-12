import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { DatabaseService } from '../db/database.service.js';
import { OutboxRepository } from '../db/repositories/outbox.repository.js';
import { v7 as uuidv7 } from 'uuid';

export interface UsageReportResult {
  organizationsProcessed: number;
  driftsDetected: number;
  eventsEmitted: number;
}

@Injectable()
export class TenantUsageReconciler {
  private readonly logger = new Logger(TenantUsageReconciler.name);

  constructor(
    private readonly dbService: DatabaseService,
    private readonly outboxRepo: OutboxRepository,
  ) {}

  /**
   * Run the daily usage reconciliation and emit storage.bytes and storage.files events
   * to esma.platform.usage.v1 for the previous UTC day (UR-12).
   */
  async runDailyReconciliation(targetDate?: Date): Promise<UsageReportResult> {
    const db = this.dbService.getDb();
    if (!db) {
      this.logger.warn('Database disabled, skipping usage reconciliation');
      return { organizationsProcessed: 0, driftsDetected: 0, eventsEmitted: 0 };
    }

    const now = targetDate ?? new Date();
    const yesterday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
    const periodStart = new Date(Date.UTC(yesterday.getUTCFullYear(), yesterday.getUTCMonth(), yesterday.getUTCDate(), 0, 0, 0)).toISOString();
    const periodEnd = new Date(Date.UTC(yesterday.getUTCFullYear(), yesterday.getUTCMonth(), yesterday.getUTCDate(), 23, 59, 59)).toISOString();

    const activeStats = await sql<{
      tenant_id: string;
      active_bytes: string;
      active_files: string;
    }>`
      SELECT
        tenant_id,
        COALESCE(SUM(size_bytes), 0)::text AS active_bytes,
        COUNT(*)::text AS active_files
      FROM files
      WHERE status = 'ACTIVE'
      GROUP BY tenant_id
    `.execute(db);

    let organizationsProcessed = 0;
    let driftsDetected = 0;
    let eventsEmitted = 0;

    for (const row of activeStats.rows) {
      const orgId = row.tenant_id;
      const actualBytes = BigInt(row.active_bytes || '0');
      const actualFiles = BigInt(row.active_files || '0');
      organizationsProcessed++;

      const currentUsage = await db
        .selectFrom('tenant_usage')
        .selectAll()
        .where('tenant_id', '=', orgId)
        .execute();

      const totalRecordedBytes = currentUsage.reduce(
        (sum, u) => sum + BigInt(u.bytes_used ?? '0'),
        0n,
      );
      const totalRecordedFiles = currentUsage.reduce(
        (sum, u) => sum + BigInt(u.file_count ?? '0'),
        0n,
      );

      if (totalRecordedBytes !== actualBytes || totalRecordedFiles !== actualFiles) {
        driftsDetected++;
        this.logger.warn(
          `Usage drift detected for org ${orgId}: actual bytes=${actualBytes} (recorded=${totalRecordedBytes}), actual files=${actualFiles} (recorded=${totalRecordedFiles}). Reconciling.`,
        );

        await sql`
          INSERT INTO tenant_usage (namespace, tenant_id, bytes_used, file_count, updated_at)
          VALUES ('default', ${orgId}, ${actualBytes.toString()}::bigint, ${actualFiles.toString()}::bigint, now())
          ON CONFLICT (namespace, tenant_id)
          DO UPDATE SET
            bytes_used = ${actualBytes.toString()}::bigint,
            file_count = ${actualFiles.toString()}::bigint,
            updated_at = now()
        `.execute(db);
      }

      const usageDate = yesterday.toISOString().slice(0, 10);
      const occurredAt = (targetDate ?? new Date()).toISOString();

      const bytesEvent = {
        eventId: `files|${orgId}|storage.bytes|${usageDate}|1`,
        occurredAt,
        eventType: 'USAGE_REPORTED',
        organizationId: orgId,
        usageDate,
        meter: 'storage.bytes',
        aggregation: 'LAST',
        quantity: Number(actualBytes),
        unit: 'bytes',
        source: 'esma-upload-service',
      };

      const filesEvent = {
        eventId: `files|${orgId}|storage.files|${usageDate}|1`,
        occurredAt,
        eventType: 'USAGE_REPORTED',
        organizationId: orgId,
        usageDate,
        meter: 'storage.files',
        aggregation: 'LAST',
        quantity: Number(actualFiles),
        unit: 'files',
        source: 'esma-upload-service',
      };

      await this.outboxRepo.enqueue({
        topic: 'esma.platform.usage.v1',
        partitionKey: orgId,
        eventType: 'USAGE_REPORTED',
        envelope: bytesEvent,
      });

      await this.outboxRepo.enqueue({
        topic: 'esma.platform.usage.v1',
        partitionKey: orgId,
        eventType: 'USAGE_REPORTED',
        envelope: filesEvent,
      });

      eventsEmitted += 2;

      // UR-23: Egress metering for the day
      const egressRow = await sql<{ bytes_served: string }>`
        SELECT COALESCE(SUM(bytes_served), 0)::text as bytes_served
        FROM tenant_daily_egress
        WHERE tenant_id = ${orgId} AND usage_date = ${usageDate}::date
      `.execute(db);

      const egressBytes = Number(egressRow.rows[0]?.bytes_served || '0');
      const egressEvent = {
        eventId: `files|${orgId}|storage.egress.bytes|${usageDate}|1`,
        occurredAt,
        eventType: 'USAGE_REPORTED',
        organizationId: orgId,
        usageDate,
        meter: 'storage.egress.bytes',
        aggregation: 'SUM',
        quantity: egressBytes,
        unit: 'bytes',
        source: 'esma-upload-service',
      };

      await this.outboxRepo.enqueue({
        topic: 'esma.platform.usage.v1',
        partitionKey: orgId,
        eventType: 'USAGE_REPORTED',
        envelope: egressEvent,
      });

      eventsEmitted++;
    }

    return {
      organizationsProcessed,
      driftsDetected,
      eventsEmitted,
    };
  }

  /**
   * Recalculates tenant usage from active records in files table and reconciles tenant_usage.
   */
  async reconcileTenant(
    namespace: string,
    tenantId: string,
  ): Promise<{
    namespace: string;
    tenantId: string;
    recordedBytes: bigint;
    actualBytes: bigint;
    driftBytes: bigint;
    recordedFileCount: bigint;
    actualFileCount: bigint;
    driftFileCount: bigint;
    reconciled: boolean;
  }> {
    const db = this.dbService.getDb();
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
        AND status = 'ACTIVE'
    `.execute(db);

    const actualBytes = BigInt(actualRow.rows[0]?.total_bytes ?? 0);
    const actualFileCount = BigInt(actualRow.rows[0]?.file_count ?? 0);

    const currentUsage = await db
      .selectFrom('tenant_usage')
      .selectAll()
      .where('namespace', '=', namespace)
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();

    const recordedBytes = BigInt(currentUsage?.bytes_used ?? 0);
    const recordedFileCount = BigInt(currentUsage?.file_count ?? 0);

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
