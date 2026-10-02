import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DatabaseQuotaGate } from '../../src/files/quota-gate.service.js';
import type { UsageRepository } from '../../src/db/repositories/usage.repository.js';
import type { RequestContext } from '../../src/core/request-context.js';
import { QuotaExceededError } from '../../src/core/errors/app-error.js';

describe('DatabaseQuotaGate (P6-02)', () => {
  let quotaGate: DatabaseQuotaGate;
  let mockUsageRepo: Partial<UsageRepository>;

  const mockContext: RequestContext = {
    correlationId: 'corr-quota-1',
    namespace: 'default',
    tenantId: 'tenant-123',
    ipAddress: '127.0.0.1',
    attributes: {},
    actor: {
      id: 'actor-1',
      type: 'user',
      roles: ['user'],
      scopes: [],
    },
  };

  beforeEach(() => {
    mockUsageRepo = {
      tryReserve: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(undefined),
    };

    quotaGate = new DatabaseQuotaGate(mockUsageRepo as UsageRepository);
  });

  it('reserves space successfully when quota is available', async () => {
    await expect(
      quotaGate.reserve(mockContext, 1048576),
    ).resolves.not.toThrow();

    expect(mockUsageRepo.tryReserve).toHaveBeenCalledWith(
      'default',
      'tenant-123',
      1048576,
      1,
    );
  });

  it('throws QuotaExceededError when space reservation fails', async () => {
    (mockUsageRepo.tryReserve as ReturnType<typeof vi.fn>).mockResolvedValue(
      false,
    );

    await expect(quotaGate.reserve(mockContext, 1048576)).rejects.toThrow(
      QuotaExceededError,
    );
  });

  it('releases reserved space on failure or delete', async () => {
    await quotaGate.release(mockContext, 1048576);

    expect(mockUsageRepo.release).toHaveBeenCalledWith(
      'default',
      'tenant-123',
      1048576,
      1,
    );
  });

  it('bypasses reservation when tenantId is absent in context', async () => {
    const noTenantContext: RequestContext = {
      correlationId: 'corr-system',
      namespace: 'system',
      tenantId: '',
      ipAddress: '127.0.0.1',
      attributes: {},
      actor: {
        id: 'system',
        type: 'service',
        roles: ['system'],
        scopes: [],
      },
    };

    await quotaGate.reserve(noTenantContext, 1000);
    expect(mockUsageRepo.tryReserve).not.toHaveBeenCalled();
  });
});
