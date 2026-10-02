import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IdempotencyService } from '../../src/files/idempotency.service.js';
import type { IdempotencyRepository } from '../../src/db/repositories/idempotency.repository.js';
import type { AppConfigService } from '../../src/config/config.service.js';
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
} from '../../src/core/errors/app-error.js';

describe('IdempotencyService (P6-03)', () => {
  let idempotencyService: IdempotencyService;
  let mockRepo: Partial<IdempotencyRepository>;
  let mockConfig: Partial<AppConfigService>;
  const store = new Map<string, any>();

  beforeEach(() => {
    store.clear();

    mockConfig = {
      idempotencyKeyTtlHours: 24,
    };

    mockRepo = {
      findByKey: vi.fn().mockImplementation(async (tenantId: string, key: string) => {
        const fullKey = `${tenantId}:${key}`;
        return store.get(fullKey) ?? null;
      }),
      createInProgress: vi.fn().mockImplementation(async (params) => {
        const fullKey = `${params.tenantId}:${params.key}`;
        if (store.has(fullKey)) {
          return false;
        }
        store.set(fullKey, {
          tenantId: params.tenantId,
          key: params.key,
          requestHash: params.requestHash,
          status: 'IN_PROGRESS',
          responseStatus: null,
          responseBody: null,
          fileId: null,
          createdAt: new Date(),
          expiresAt: params.expiresAt,
        });
        return true;
      }),
      markCompleted: vi.fn().mockImplementation(async (tenantId, key, status, body, fileId) => {
        const fullKey = `${tenantId}:${key}`;
        const existing = store.get(fullKey);
        if (existing) {
          existing.status = 'COMPLETED';
          existing.responseStatus = status;
          existing.responseBody = body;
          existing.fileId = fileId ?? null;
        }
      }),
      deleteExpired: vi.fn().mockImplementation(async (now = new Date()) => {
        let deleted = 0;
        for (const [k, val] of store.entries()) {
          if (val.expiresAt < now) {
            store.delete(k);
            deleted++;
          }
        }
        return deleted;
      }),
      deleteByKey: vi.fn().mockImplementation(async (tenantId: string, key: string) => {
        const fullKey = `${tenantId}:${key}`;
        const existed = store.has(fullKey);
        store.delete(fullKey);
        return existed;
      }),
    };

    idempotencyService = new IdempotencyService(
      mockRepo as IdempotencyRepository,
      mockConfig as AppConfigService,
    );
  });

  describe('computeFingerprint', () => {
    it('generates consistent sha256 fingerprint regardless of tag ordering', () => {
      const f1 = idempotencyService.computeFingerprint(
        'hash123',
        'documents',
        'tenant',
        ['tagA', 'tagB'],
      );
      const f2 = idempotencyService.computeFingerprint(
        'hash123',
        'documents',
        'tenant',
        ['tagB', 'tagA'],
      );

      expect(f1).toBe(f2);
      expect(typeof f1).toBe('string');
      expect(f1.length).toBe(64);
    });

    it('generates different fingerprints for different file hashes or folders', () => {
      const f1 = idempotencyService.computeFingerprint('hash1', 'folderA', 'private');
      const f2 = idempotencyService.computeFingerprint('hash2', 'folderA', 'private');
      const f3 = idempotencyService.computeFingerprint('hash1', 'folderB', 'private');

      expect(f1).not.toBe(f2);
      expect(f1).not.toBe(f3);
    });
  });

  describe('acquireOrCheck & recordCompleted', () => {
    it('returns status NEW for a fresh idempotency key', async () => {
      const result = await idempotencyService.acquireOrCheck(
        'tenant-1',
        'key-100',
        'fp-abc',
      );

      expect(result).toEqual({ status: 'NEW' });
      expect(mockRepo.createInProgress).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        key: 'key-100',
        requestHash: 'fp-abc',
        expiresAt: expect.any(Date),
      });
    });

    it('throws IdempotencyInProgressError when key is IN_PROGRESS', async () => {
      await idempotencyService.acquireOrCheck('tenant-1', 'key-100', 'fp-abc');

      await expect(
        idempotencyService.acquireOrCheck('tenant-1', 'key-100', 'fp-abc'),
      ).rejects.toThrow(IdempotencyInProgressError);
    });

    it('returns REPLAYED when key is COMPLETED with matching fingerprint', async () => {
      await idempotencyService.acquireOrCheck('tenant-1', 'key-100', 'fp-abc');
      const manifest = { id: 'file-123', originalFilename: 'doc.pdf' };
      await idempotencyService.recordCompleted('tenant-1', 'key-100', 201, manifest, 'file-123');

      const replayed = await idempotencyService.acquireOrCheck(
        'tenant-1',
        'key-100',
        'fp-abc',
      );

      expect(replayed).toEqual({
        status: 'REPLAYED',
        responseStatus: 201,
        responseBody: manifest,
        fileId: 'file-123',
      });
    });

    it('throws IdempotencyConflictError when key is COMPLETED with different fingerprint', async () => {
      await idempotencyService.acquireOrCheck('tenant-1', 'key-100', 'fp-abc');
      await idempotencyService.recordCompleted('tenant-1', 'key-100', 201, { success: true });

      await expect(
        idempotencyService.acquireOrCheck('tenant-1', 'key-100', 'fp-different'),
      ).rejects.toThrow(IdempotencyConflictError);
    });

    it('releases in-progress key on releaseKey allowing new attempts', async () => {
      await idempotencyService.acquireOrCheck('tenant-1', 'key-err', 'fp-err');
      await idempotencyService.releaseKey('tenant-1', 'key-err');

      const reattempt = await idempotencyService.acquireOrCheck(
        'tenant-1',
        'key-err',
        'fp-err',
      );
      expect(reattempt).toEqual({ status: 'NEW' });
    });

    it('reclaims stale IN_PROGRESS lease older than 5 minutes', async () => {
      await idempotencyService.acquireOrCheck('tenant-1', 'key-stale', 'fp-stale');
      const fullKey = 'tenant-1:key-stale';
      const record = store.get(fullKey);
      // Simulate key created 10 minutes ago
      record.createdAt = new Date(Date.now() - 10 * 60 * 1000);

      const reclaimed = await idempotencyService.acquireOrCheck(
        'tenant-1',
        'key-stale',
        'fp-stale',
      );
      expect(reclaimed).toEqual({ status: 'NEW' });
    });
  });
});
