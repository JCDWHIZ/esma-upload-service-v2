import { describe, it, expect, beforeEach, vi } from 'vitest';
import { QuotaController } from '../../src/admin/quota.controller.js';
import type { UsageRepository } from '../../src/db/repositories/usage.repository.js';
import type { TenantUsageReconciler } from '../../src/admin/tenant-usage-reconciler.service.js';
import type { TenantUsage } from '../../src/core/types.js';

describe('QuotaController (P6-02)', () => {
  let controller: QuotaController;
  let mockUsageRepo: Partial<UsageRepository>;
  let mockReconciler: Partial<TenantUsageReconciler>;

  const sampleUsage: TenantUsage = {
    namespace: 'default',
    tenantId: 'tenant-456',
    bytesUsed: 500000n,
    fileCount: 10n,
    maxBytes: 10000000n,
    maxFiles: 100n,
    updatedAt: new Date('2026-10-02T10:00:00Z'),
  };

  beforeEach(() => {
    mockUsageRepo = {
      get: vi.fn().mockResolvedValue(sampleUsage),
      setQuota: vi.fn().mockResolvedValue({
        ...sampleUsage,
        maxBytes: 20000000n,
      }),
    };

    mockReconciler = {
      reconcileTenant: vi.fn().mockResolvedValue({
        namespace: 'default',
        tenantId: 'tenant-456',
        recordedBytes: 500000n,
        actualBytes: 500000n,
        driftBytes: 0n,
        recordedFileCount: 10n,
        actualFileCount: 10n,
        driftFileCount: 0n,
        reconciled: false,
      }),
    };

    controller = new QuotaController(
      mockUsageRepo as UsageRepository,
      mockReconciler as TenantUsageReconciler,
    );
  });

  it('GET /api/v1/admin/tenants/:tenantId/quota returns tenant quota and usage', async () => {
    const res = await controller.getQuota('tenant-456', 'default');

    expect(mockUsageRepo.get).toHaveBeenCalledWith('default', 'tenant-456');
    expect(res.tenantId).toBe('tenant-456');
    expect(res.bytesUsed).toBe('500000');
    expect(res.maxBytes).toBe('10000000');
  });

  it('PATCH /api/v1/admin/tenants/:tenantId/quota updates tenant maxBytes', async () => {
    const res = await controller.setQuota('tenant-456', {
      namespace: 'default',
      maxBytes: 20000000,
    });

    expect(mockUsageRepo.setQuota).toHaveBeenCalledWith(
      'default',
      'tenant-456',
      20000000,
      null,
    );

    expect(res.message).toContain('updated successfully');
    expect(res.quota.maxBytes).toBe('20000000');
  });

  it('POST /api/v1/admin/tenants/:tenantId/reconcile triggers drift reconciliation', async () => {
    const res = await controller.reconcile('tenant-456', 'default');

    expect(mockReconciler.reconcileTenant).toHaveBeenCalledWith(
      'default',
      'tenant-456',
    );
    expect(res.message).toContain('in sync');
    expect(res.result.driftBytes).toBe('0');
  });
});
