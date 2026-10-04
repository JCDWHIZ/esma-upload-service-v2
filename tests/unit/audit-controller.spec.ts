import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AuditController } from '../../src/observability/audit.controller.js';
import type { AuditRepository } from '../../src/db/repositories/audit.repository.js';
import type { AuditLogEntry } from '../../src/core/types.js';

describe('AuditController (P6-01)', () => {
  let controller: AuditController;
  let mockAuditRepo: Partial<AuditRepository>;

  const sampleAudit: AuditLogEntry = {
    id: 'audit-999',
    occurredAt: new Date('2026-10-02T10:00:00Z'),
    action: 'FILE_UPLOAD',
    outcome: 'SUCCESS',
    actorId: 'user-777',
    actorType: 'user',
    roles: ['editor'],
    namespace: 'default',
    tenantId: 'tenant-100',
    fileId: 'file-200',
    ipAddress: '192.168.1.1',
    userAgent: 'Mozilla/5.0',
    correlationId: 'corr-555',
    details: { filename: 'report.pdf' },
  };

  beforeEach(() => {
    mockAuditRepo = {
      query: vi.fn().mockResolvedValue({
        items: [sampleAudit],
        nextCursor: 'cursor-next',
        hasMore: true,
      }),
    };

    controller = new AuditController(mockAuditRepo as AuditRepository);
  });

  it('GET /api/v1/admin/audit queries audit log records with filters and limit', async () => {
    const res = await controller.list({
      namespace: 'default',
      tenantId: 'tenant-100',
      action: 'FILE_UPLOAD',
      outcome: 'SUCCESS',
      limit: 25,
    });

    expect(mockAuditRepo.query).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: 'default',
        tenantId: 'tenant-100',
        action: 'FILE_UPLOAD',
        outcome: 'SUCCESS',
      }),
      undefined,
      25,
    );

    expect(res.items).toHaveLength(1);
    expect(res.nextCursor).toBe('cursor-next');
    expect(res.hasMore).toBe(true);
  });

  it('GET /api/v1/admin/audit parses date filters correctly', async () => {
    const fromIso = '2026-10-01T00:00:00.000Z';
    const toIso = '2026-10-02T23:59:59.999Z';

    await controller.list({
      from: fromIso,
      to: toIso,
      limit: 50,
    });

    expect(mockAuditRepo.query).toHaveBeenCalledWith(
      expect.objectContaining({
        from: new Date(fromIso),
        to: new Date(toIso),
      }),
      undefined,
      50,
    );
  });
});
