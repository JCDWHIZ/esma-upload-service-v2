import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { DatabaseService } from '../db/database.service.js';
import { AppConfigService } from '../config/config.service.js';
import { DomainEventPublisher } from '../events/domain-event.publisher.js';
import { AuditService } from '../observability/audit.service.js';
import {
  QuotaExceededError,
  TenantPurgingError,
  TenantSuspendedError,
} from '../core/errors/app-error.js';
import type { RequestContext } from '../core/request-context.js';

export interface EffectiveQuotaResult {
  tenantId: string;
  effectiveQuotaBytes: number;
  planQuotaBytes: number | null;
  overrideQuotaBytes: number | null;
  overrideReason: string | null;
  overrideExpiresAt: Date | null;
  isSuspended: boolean;
  isPurging: boolean;
  usedBytes: number;
}

@Injectable()
export class TenantQuotaService {
  private readonly logger = new Logger(TenantQuotaService.name);

  constructor(
    private readonly dbService: DatabaseService,
    private readonly configService: AppConfigService,
    private readonly domainEventPublisher: DomainEventPublisher,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Retrieves the effective quota, current usage, and suspension state for a tenant (UR-13, UR-18).
   */
  async getEffectiveQuota(tenantId: string): Promise<EffectiveQuotaResult> {
    const db = this.dbService.getDb();
    const dbExecutor = db as unknown as
      { getExecutor?: () => unknown } | undefined;
    if (!db || typeof dbExecutor?.getExecutor !== 'function') {
      const defaultBytes = this.configService.defaultTenantQuotaBytes;
      return {
        tenantId,
        effectiveQuotaBytes: defaultBytes,
        planQuotaBytes: null,
        overrideQuotaBytes: null,
        overrideReason: null,
        overrideExpiresAt: null,
        isSuspended: false,
        isPurging: false,
        usedBytes: 0,
      };
    }

    const quotaRow = await sql<{
      tenant_id: string;
      plan_quota_bytes: string | number | null;
      override_quota_bytes: string | number | null;
      override_reason: string | null;
      override_expires_at: Date | string | null;
      is_suspended: boolean;
      is_purging?: boolean;
    }>`
      SELECT tenant_id, plan_quota_bytes, override_quota_bytes, override_reason, override_expires_at, is_suspended, is_purging
      FROM tenant_quota
      WHERE tenant_id = ${tenantId}
    `.execute(db);

    const usageRow = await sql<{
      total_used: string | number;
    }>`
      SELECT COALESCE(SUM(bytes_used), 0) AS total_used
      FROM tenant_usage
      WHERE tenant_id = ${tenantId}
    `.execute(db);

    const usedBytes = Number(usageRow.rows[0]?.total_used ?? 0);
    const row = quotaRow.rows[0];

    const planQuotaBytes =
      row?.plan_quota_bytes !== null && row?.plan_quota_bytes !== undefined
        ? Number(row.plan_quota_bytes)
        : null;

    const rawOverride =
      row?.override_quota_bytes !== null &&
      row?.override_quota_bytes !== undefined
        ? Number(row.override_quota_bytes)
        : null;

    const overrideExpiresAt = row?.override_expires_at
      ? new Date(row.override_expires_at)
      : null;

    const isOverrideActive =
      rawOverride !== null &&
      (overrideExpiresAt === null || overrideExpiresAt.getTime() > Date.now());

    const overrideQuotaBytes = isOverrideActive ? rawOverride : null;
    const isSuspended = Boolean(row?.is_suspended);
    const isPurging = Boolean(row?.is_purging);

    const defaultBytes = this.configService.defaultTenantQuotaBytes;
    const effectiveQuotaBytes =
      overrideQuotaBytes ?? planQuotaBytes ?? defaultBytes;

    return {
      tenantId,
      effectiveQuotaBytes,
      planQuotaBytes,
      overrideQuotaBytes,
      overrideReason: row?.override_reason ?? null,
      overrideExpiresAt,
      isSuspended,
      isPurging,
      usedBytes,
    };
  }

  /**
   * Enforces upload quota and suspension check before an upload occurs (UR-13.4, UR-13.6, UR-18.5, UR-21).
   * Checks content size, emits threshold events, throws 403 on suspension/purging and 507 on quota exceeded.
   */
  async checkUploadQuota(
    tenantId: string,
    requestedBytes: number,
    ctx?: RequestContext,
  ): Promise<void> {
    // UR-21: platform-archives is excluded from tenant quota
    if (ctx?.namespace === 'platform-archives') {
      return;
    }

    const quota = await this.getEffectiveQuota(tenantId);

    // UR-18.5: Purging check: 403 tenant_purging
    if (quota.isPurging) {
      throw new TenantPurgingError(
        `Organization '${tenantId}' is currently undergoing a purge operation`,
      );
    }

    // 1. Suspension check: 403 tenant_suspended (UR-13.6)
    if (quota.isSuspended) {
      throw new TenantSuspendedError(
        `Organization '${tenantId}' is suspended and cannot upload files`,
      );
    }

    const { usedBytes, effectiveQuotaBytes } = quota;
    const newTotalBytes = usedBytes + requestedBytes;

    // 2. Quota check: 507 quota_exceeded (UR-13.4)
    if (newTotalBytes > effectiveQuotaBytes) {
      throw new QuotaExceededError('Tenant storage quota has been exceeded', {
        quotaBytes: effectiveQuotaBytes,
        usedBytes,
        requestedBytes,
      });
    }

    // 3. Threshold crossing detection: 80%, 95%, 100% (UR-13.5)
    if (effectiveQuotaBytes > 0) {
      const prevPct = Math.floor((usedBytes / effectiveQuotaBytes) * 100);
      const newPct = Math.floor((newTotalBytes / effectiveQuotaBytes) * 100);

      const thresholds: Array<80 | 95 | 100> = [80, 95, 100];
      for (const th of thresholds) {
        if (prevPct < th && newPct >= th) {
          void this.domainEventPublisher.publish(null, {
            eventType: 'file.quota.threshold.v1',
            organizationId: tenantId,
            context: ctx,
            data: {
              thresholdPercent: th,
              usedBytes: newTotalBytes,
              quotaBytes: effectiveQuotaBytes,
            },
          });
        }
      }
    }
  }

  /**
   * Sets or clears an administrative quota override with reason and optional expiry (UR-13.3).
   * Audited.
   */
  async setOverride(
    tenantId: string,
    overrideBytes: number | null,
    reason: string,
    expiresAt?: Date | null,
    ctx?: RequestContext,
  ): Promise<EffectiveQuotaResult> {
    const db = this.dbService.getDb();
    if (db) {
      await sql`
        INSERT INTO tenant_quota (tenant_id, override_quota_bytes, override_reason, override_expires_at, updated_at)
        VALUES (${tenantId}, ${overrideBytes}, ${reason}, ${expiresAt ?? null}, now())
        ON CONFLICT (tenant_id)
        DO UPDATE SET
          override_quota_bytes = EXCLUDED.override_quota_bytes,
          override_reason = EXCLUDED.override_reason,
          override_expires_at = EXCLUDED.override_expires_at,
          updated_at = now()
      `.execute(db);
    }

    // Write audit row
    await this.auditService.recordSync({
      action: 'QUOTA_OVERRIDE_UPDATED',
      outcome: 'SUCCESS',
      actorId: ctx?.actor.id ?? 'system',
      actorType: ctx?.actor.type ?? 'user',
      namespace: ctx?.namespace ?? 'generic',
      tenantId,
      correlationId: ctx?.correlationId,
      details: {
        overrideQuotaBytes: overrideBytes,
        reason,
        expiresAt: expiresAt?.toISOString() ?? null,
      },
    });

    return this.getEffectiveQuota(tenantId);
  }

  /**
   * Consumes tenant-entitlement-changed event to upsert commercial plan quota (UR-13.1).
   */
  async handleEntitlementChanged(
    organizationId: string,
    planQuotaBytes: number | null,
  ): Promise<void> {
    const db = this.dbService.getDb();
    if (db) {
      await sql`
        INSERT INTO tenant_quota (tenant_id, plan_quota_bytes, updated_at)
        VALUES (${organizationId}, ${planQuotaBytes}, now())
        ON CONFLICT (tenant_id)
        DO UPDATE SET
          plan_quota_bytes = EXCLUDED.plan_quota_bytes,
          updated_at = now()
      `.execute(db);
      this.logger.log(
        `Updated plan quota for tenant ${organizationId} to ${String(planQuotaBytes)} bytes`,
      );
    }
  }

  /**
   * Consumes tenant-lifecycle event (suspended, resumed) (UR-13.6).
   */
  async handleTenantLifecycle(
    organizationId: string,
    status: 'suspended' | 'resumed' | 'offboarded',
  ): Promise<void> {
    const db = this.dbService.getDb();
    if (!db) return;

    if (status === 'suspended') {
      await sql`
        INSERT INTO tenant_quota (tenant_id, is_suspended, suspended_at, updated_at)
        VALUES (${organizationId}, true, now(), now())
        ON CONFLICT (tenant_id)
        DO UPDATE SET
          is_suspended = true,
          suspended_at = now(),
          updated_at = now()
      `.execute(db);
      this.logger.log(`Tenant ${organizationId} marked as suspended`);
    } else if (status === 'resumed') {
      await sql`
        INSERT INTO tenant_quota (tenant_id, is_suspended, suspended_at, updated_at)
        VALUES (${organizationId}, false, null, now())
        ON CONFLICT (tenant_id)
        DO UPDATE SET
          is_suspended = false,
          suspended_at = null,
          updated_at = now()
      `.execute(db);
      this.logger.log(`Tenant ${organizationId} resumed from suspension`);
    }
  }
}
