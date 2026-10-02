import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AuditService } from '../../src/observability/audit.service.js';
import type { AppConfigService } from '../../src/config/config.service.js';
import type { AuditRepository } from '../../src/db/repositories/audit.repository.js';
import type { OutboxWriter } from '../../src/events/outbox-writer.js';
import type { AuditEvent } from '../../src/authz/audit-sink.js';
import type { AuditLogEntry, NewAuditLogEntry } from '../../src/core/types.js';

describe('AuditService (P6-01)', () => {
  let auditService: AuditService;
  let mockConfig: Partial<AppConfigService>;
  let mockAuditRepo: Partial<AuditRepository>;
  let mockOutboxWriter: Partial<OutboxWriter>;

  const sampleEntry: AuditLogEntry = {
    id: 'audit-123',
    occurredAt: new Date('2026-10-02T12:00:00Z'),
    action: 'AUTH_READ',
    outcome: 'SUCCESS',
    actorId: 'user-1',
    actorType: 'user',
    roles: ['admin'],
    namespace: 'test-ns',
    tenantId: 'tenant-1',
    fileId: 'file-100',
    ipAddress: '127.0.0.1',
    userAgent: 'vitest',
    correlationId: 'corr-123',
    details: { foo: 'bar' },
  };

  beforeEach(() => {
    vi.useFakeTimers();

    mockConfig = {
      auditReads: 'all',
      auditSampleRate: 0.1,
      auditStream: false,
    };

    mockAuditRepo = {
      insert: vi.fn().mockImplementation((entry: NewAuditLogEntry) =>
        Promise.resolve({
          ...sampleEntry,
          ...entry,
          id: entry.id ?? 'generated-id',
          occurredAt: entry.occurredAt ?? new Date(),
        }),
      ),
      query: vi.fn().mockResolvedValue({
        items: [sampleEntry],
        nextCursor: null,
        hasMore: false,
      }),
    };

    mockOutboxWriter = {
      enqueue: vi.fn().mockResolvedValue({ id: 'outbox-1' }),
    };

    auditService = new AuditService(
      mockConfig as AppConfigService,
      mockAuditRepo as AuditRepository,
      undefined,
      mockOutboxWriter as OutboxWriter,
    );

    auditService.onModuleInit();
  });

  afterEach(async () => {
    await auditService.onModuleDestroy();
    vi.useRealTimers();
  });

  it('records authorization DENY decision synchronously', async () => {
    const denyEvent: AuditEvent = {
      action: 'delete',
      decision: {
        allowed: false,
        reason: 'Insufficient privileges',
        ruleId: 'rule-deny',
      },
      actorId: 'user-deny',
      actorType: 'user',
      namespace: 'ns-1',
      tenantId: 'tenant-1',
      correlationId: 'corr-deny',
      timestamp: new Date(),
    };

    await auditService.record(denyEvent);

    expect(mockAuditRepo.insert).toHaveBeenCalledTimes(1);
    expect(mockAuditRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'AUTH_DENIED',
        outcome: 'DENIED',
        actorId: 'user-deny',
        namespace: 'ns-1',
        details: expect.objectContaining({
          reason: 'Insufficient privileges',
        }) as Record<string, unknown>,
      }),
      undefined,
    );
  });

  it('records authorization ALLOW decision asynchronously in batch queue', async () => {
    const allowEvent: AuditEvent = {
      action: 'read',
      decision: {
        allowed: true,
        reason: 'Authorized',
        ruleId: 'rule-allow',
      },
      actorId: 'user-allow',
      actorType: 'user',
      namespace: 'ns-1',
      tenantId: 'tenant-1',
      timestamp: new Date(),
    };

    await auditService.record(allowEvent);

    // Initial recordAsync does not flush immediately since queue < 50
    expect(mockAuditRepo.insert).not.toHaveBeenCalled();

    // Advance timer by 500ms to trigger flush
    await vi.advanceTimersByTimeAsync(500);

    expect(mockAuditRepo.insert).toHaveBeenCalledTimes(1);
    expect(mockAuditRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'AUTH_READ',
        outcome: 'SUCCESS',
        actorId: 'user-allow',
      }),
    );
  });

  it('sanitizes sensitive details recursively (passwords, tokens, keys)', async () => {
    await auditService.recordSync({
      action: 'USER_LOGIN',
      outcome: 'SUCCESS',
      actorId: 'user-secret',
      actorType: 'user',
      namespace: 'ns-1',
      details: {
        username: 'alice',
        password: 'super-secret-password',
        authToken: 'bearer-xyz',
        nested: {
          apiKey: 'key-12345',
          safeField: 'hello',
        },
      },
    });

    expect(mockAuditRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        details: {
          username: 'alice',
          password: '[REDACTED]',
          authToken: '[REDACTED]',
          nested: {
            apiKey: '[REDACTED]',
            safeField: 'hello',
          },
        },
      }),
      undefined,
    );
  });

  it('enqueues outbox event when auditStream is enabled', async () => {
    mockConfig.auditStream = true;

    await auditService.recordSync({
      action: 'FILE_UPLOAD',
      outcome: 'SUCCESS',
      actorId: 'uploader-1',
      actorType: 'user',
      namespace: 'ns-1',
      fileId: 'file-999',
    });

    expect(mockOutboxWriter.enqueue).toHaveBeenCalledTimes(1);
    expect(mockOutboxWriter.enqueue).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        eventType: 'file.processed',
      }),
      'audit',
    );
  });

  it('ignores read audit entries when auditReads is off', async () => {
    mockConfig.auditReads = 'off';

    auditService.recordAsync({
      action: 'FILE_READ',
      outcome: 'SUCCESS',
      actorId: 'reader-1',
      actorType: 'user',
      namespace: 'ns-1',
    });

    await vi.advanceTimersByTimeAsync(500);

    expect(mockAuditRepo.insert).not.toHaveBeenCalled();
  });

  it('flushes queue when length reaches 50 items', async () => {
    for (let i = 0; i < 50; i++) {
      auditService.recordAsync({
        action: `READ_${i}`,
        outcome: 'SUCCESS',
        actorId: 'reader',
        actorType: 'user',
        namespace: 'ns-1',
      });
    }

    await vi.waitFor(() => {
      expect(mockAuditRepo.insert).toHaveBeenCalledTimes(50);
    });
  });
});
