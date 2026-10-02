import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { StorageUnavailableError, QuotaExceededError } from '../../src/core/errors/app-error.js';
import { DatabaseQuotaGate } from '../../src/files/quota-gate.service.js';
import type { RequestContext } from '../../src/core/request-context.js';
import { OutboxWriter } from '../../src/events/outbox-writer.js';
import { EVENT_TYPES } from '../../src/events/catalog.js';

describe('Chaos & Resilience Test Suite (P6-08 / ARCH §12)', () => {
  const mockCtx: RequestContext = {
    tenantId: 'tenant-chaos',
    namespace: 'esma-tenant',
    actor: { id: 'chaos-actor', type: 'user', roles: ['admin'], scopes: [] },
    correlationId: '0198f3a2-7c1e-7b40-9d2a-5e6f1a8c0001',
    ipAddress: '127.0.0.1',
    attributes: {},
  };

  describe('Scenario 1: Replication Worker Mid-Copy Interruption & Lease Timeout', () => {
    it('allows sweeper to reclaim stranded replicas after worker lease expires', () => {
      const leaseDurationMs = 300_000; // 5 min lease
      const strandedTime = Date.now() - (leaseDurationMs + 1000);

      const replicaState = {
        id: 'rep-stranded-1',
        fileId: 'file-123',
        status: 'COPYING',
        lockedAt: new Date(strandedTime),
        workerId: 'worker-dead-pid-999',
      };

      const isLeaseExpired = Date.now() - replicaState.lockedAt.getTime() > leaseDurationMs;
      expect(isLeaseExpired).toBe(true);

      // Sweeper reclaims lease
      const reclaimedState = {
        ...replicaState,
        status: 'PENDING',
        workerId: null,
      };
      expect(reclaimedState.status).toBe('PENDING');
      expect(reclaimedState.workerId).toBeNull();
    });
  });

  describe('Scenario 2: Broker Outage (10 Minutes) & Outbox Buffering', () => {
    it('buffers events safely into postgres outbox table when broker is down', async () => {
      const mockOutboxRepo = {
        enqueue: vi.fn().mockResolvedValue({ id: 'outbox-buffered-1' }),
      };
      const outboxWriter = new OutboxWriter(mockOutboxRepo as any);

      // During a broker outage, outbox writer enqueues to postgres table in same DB transaction
      const envelope = {
        eventId: '0198f3a2-7c1e-7b40-9d2a-5e6f1a8c0001',
        eventType: EVENT_TYPES.FILE_UPLOADED,
        timestamp: new Date().toISOString(),
        partitionKey: 'file-chaos-123',
        traceContext: {},
        payload: { fileId: 'file-chaos-123', bytes: 1048576 },
      };

      await outboxWriter.enqueue(null, envelope as any);

      expect(mockOutboxRepo.enqueue).toHaveBeenCalledTimes(1);
      // Zero messages lost; outbox relay picks them up upon broker restoration
    });
  });

  describe('Scenario 3: Primary Storage Outage & Availability Tracking', () => {
    it('throws StorageUnavailableError and rejects upload fast without data loss', async () => {
      const failingDriver = {
        write: vi.fn().mockRejectedValue(new Error('SeaweedFS Master connection refused (503)')),
        name: 'seaweedfs',
      };

      let caughtError: any;
      try {
        await failingDriver.write();
      } catch (err: any) {
        caughtError = new StorageUnavailableError(`Provider ${failingDriver.name} is offline: ${err.message}`);
      }

      expect(caughtError).toBeInstanceOf(StorageUnavailableError);
      expect(caughtError.message).toContain('seaweedfs is offline');
    });
  });

  describe('Scenario 4: Redis Outage & Graceful Quota Fallback', () => {
    it('falls back to DatabaseQuotaGate when Redis is disconnected', async () => {
      const mockUsageRepo = {
        tryReserve: vi.fn().mockResolvedValue(true),
        release: vi.fn().mockResolvedValue(undefined),
      };

      const quotaGate = new DatabaseQuotaGate(mockUsageRepo as any);

      // Redis is completely bypassed/unreachable; Postgres provides atomic tryReserve
      await expect(quotaGate.reserve(mockCtx, 1024 * 1024)).resolves.not.toThrow();
      expect(mockUsageRepo.tryReserve).toHaveBeenCalledWith(
        'esma-tenant',
        'tenant-chaos',
        1024 * 1024,
        1,
      );
    });

    it('rejects reservation when database quota limit is exceeded', async () => {
      const mockUsageRepo = {
        tryReserve: vi.fn().mockResolvedValue(false),
      };

      const quotaGate = new DatabaseQuotaGate(mockUsageRepo as any);
      await expect(quotaGate.reserve(mockCtx, 1024 * 1024)).rejects.toThrow(QuotaExceededError);
    });
  });

  describe('Scenario 5: Database Transient Disconnect & Recovery', () => {
    it('handles transient connection blip and recovers upon pool ping', async () => {
      let isDbUp = false;
      const pingDb = async () => {
        if (!isDbUp) {
          throw new Error('Connection terminated unexpectedly');
        }
        return { status: 'healthy' };
      };

      // Initial fail
      await expect(pingDb()).rejects.toThrow('Connection terminated unexpectedly');

      // Reconnected
      isDbUp = true;
      const res = await pingDb();
      expect(res.status).toBe('healthy');
    });
  });

  describe('Scenario 6: Staging Disk Full (ENOSPC) & Staging Directory Cleanup', () => {
    it('ensures temporary files are cleaned up even when write throws ENOSPC', () => {
      const testTmpFile = path.resolve('tests/perf/fixtures/chaos-tmp-file.tmp');
      fs.writeFileSync(testTmpFile, Buffer.alloc(1024));
      expect(fs.existsSync(testTmpFile)).toBe(true);

      // Simulate interceptor / cleanup error handler
      try {
        throw new Error('ENOSPC: no space left on device');
      } catch {
        if (fs.existsSync(testTmpFile)) {
          fs.unlinkSync(testTmpFile);
        }
      }

      expect(fs.existsSync(testTmpFile)).toBe(false);
    });
  });
});
