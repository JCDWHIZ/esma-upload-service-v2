/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/require-await, @typescript-eslint/no-unused-vars, @typescript-eslint/unbound-method */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SweeperService } from '../../src/workers/sweeper.service.js';
import type { AppConfigService } from '../../src/config/config.service.js';
import type { DatabaseService } from '../../src/db/database.service.js';
import type { FileRepository } from '../../src/db/repositories/file.repository.js';
import type { ReplicaRepository } from '../../src/db/repositories/replica.repository.js';
import type { OutboxRepository } from '../../src/db/repositories/outbox.repository.js';
import type { OutboxWriter } from '../../src/events/outbox-writer.js';
import type { FileRecord, FileReplica } from '../../src/core/types.js';

const mocks = vi.hoisted(() => ({
  lockAcquired: true,
}));

vi.mock('kysely', async (importOriginal) => {
  const actual = await importOriginal<typeof import('kysely')>();
  return {
    ...actual,
    sql: Object.assign(
      (..._args: any[]) => ({
        execute: async () => ({ rows: [{ locked: mocks.lockAcquired }] }),
      }),
      actual.sql,
    ),
  };
});

describe('SweeperService [P4-10]', () => {
  let sweeper: SweeperService;
  let mockConfig: AppConfigService;
  let mockDbService: DatabaseService;
  let mockFileRepo: FileRepository;
  let mockReplicaRepo: ReplicaRepository;
  let mockOutboxRepo: OutboxRepository;
  let mockOutboxWriter: OutboxWriter;

  let enqueuedOutboxEvents: unknown[];
  let mockFile: FileRecord;
  let mockReplica: FileReplica;

  beforeEach(() => {
    mocks.lockAcquired = true;
    enqueuedOutboxEvents = [];

    mockFile = {
      id: 'f-sweep-1',
      namespace: 'esma-tenant',
      tenantId: 'school-100',
      subTenantId: null,
      folder: 'docs',
      storageKey: 'tenants/school-100/docs/f-sweep-1.pdf',
      originalFilename: 'doc.pdf',
      mimetype: 'application/pdf',
      declaredMimetype: 'application/pdf',
      sizeBytes: 1024n,
      sha256: 'hash123',
      visibility: 'tenant',
      status: 'ACTIVE',
      scanStatus: 'NOT_REQUIRED',
      replicationStatus: 'QUEUED',
      primaryProvider: 'local',
      uploadedBy: 'u-1',
      tags: [],
      attributes: {},
      legacyPublicId: null,
      idempotencyKey: null,
      correlationId: 'corr-sweep',
      expiresAt: null,
      version: 1,
      deletedAt: null,
      createdAt: new Date(Date.now() - 3600000),
      updatedAt: new Date(Date.now() - 3600000),
    };

    mockReplica = {
      fileId: 'f-sweep-1',
      provider: 'seaweedfs',
      role: 'secondary',
      status: 'QUEUED',
      providerKey: 'tenants/school-100/docs/f-sweep-1.pdf',
      providerMeta: {},
      url: null,
      etag: null,
      attempts: 0,
      lastError: null,
      syncedAt: null,
      createdAt: new Date(Date.now() - 3600000),
      updatedAt: new Date(Date.now() - 3600000),
    };

    mockConfig = {
      sweepIntervalSeconds: 60,
      sweepQueuedAfterMinutes: 10,
      sweepLeaseTimeoutMinutes: 15,
      sweepDeletingAfterMinutes: 10,
      redriveAfterHours: 1,
      redriveMaxTimes: 3,
      tombstoneRetentionDays: 30,
      outboxRetentionHours: 72,
      stagingDir: '/tmp/test-staging',
      stagingMaxAgeMinutes: 60,
    } as unknown as AppConfigService;

    const mockKyselyDb = {
      transaction: () => ({
        execute: async (fn: (trx: any) => Promise<any>) => fn({}),
      }),
    };

    mockDbService = {
      getDb: () => mockKyselyDb as any,
    } as unknown as DatabaseService;

    // Helper mock sql execute for advisory lock
    vi.spyOn(mockDbService, 'getDb').mockReturnValue({
      transaction: () => ({
        execute: async (fn: (trx: any) => Promise<any>) => {
          return fn({});
        },
      }),
    } as any);

    mockFileRepo = {
      findById: vi.fn().mockImplementation(async (id: string) => {
        if (id === mockFile.id) return { ...mockFile };
        return null;
      }),
      findStaleByStatus: vi.fn().mockImplementation(async (status: string) => {
        if (mockFile.status === status) return [{ ...mockFile }];
        return [];
      }),
      hardDeleteTombstones: vi.fn().mockResolvedValue(2),
    } as unknown as FileRepository;

    mockReplicaRepo = {
      findQueuedWithoutUnpublishedOutbox: vi
        .fn()
        .mockImplementation(async () => {
          if (mockReplica.status === 'QUEUED') return [{ ...mockReplica }];
          return [];
        }),
      findStale: vi.fn().mockImplementation(async (status: string) => {
        if (mockReplica.status === status) return [{ ...mockReplica }];
        return [];
      }),
      findFailedOlderThan: vi.fn().mockImplementation(async () => {
        if (mockReplica.status === 'FAILED') return [{ ...mockReplica }];
        return [];
      }),
      retry: vi
        .fn()
        .mockImplementation(async (_id: string, _provider: string) => {
          mockReplica.status = 'QUEUED';
          return true;
        }),
      redrive: vi
        .fn()
        .mockImplementation(async (_id: string, _provider: string) => {
          mockReplica.status = 'QUEUED';
          mockReplica.attempts = 0;
          return true;
        }),
    } as unknown as ReplicaRepository;

    mockOutboxRepo = {
      deletePublishedOlderThan: vi.fn().mockResolvedValue(5),
    } as unknown as OutboxRepository;

    mockOutboxWriter = {
      enqueue: vi.fn().mockImplementation(async (_trx, envelope) => {
        enqueuedOutboxEvents.push(envelope);
      }),
    } as unknown as OutboxWriter;

    sweeper = new SweeperService(
      mockConfig,
      mockDbService,
      mockFileRepo,
      mockReplicaRepo,
      mockOutboxRepo,
      mockOutboxWriter,
    );
  });

  afterEach(() => {
    sweeper.stop();
  });

  it('re-enqueues file.replicate for stuck QUEUED replicas [P4-10]', async () => {
    const reenqueued = await sweeper.sweepStuckQueued();

    expect(reenqueued).toBe(1);
    expect(enqueuedOutboxEvents).toHaveLength(1);
    const env = enqueuedOutboxEvents[0] as any;
    expect(env.eventType).toBe('file.replicate');
    expect(env.partitionKey).toBe('f-sweep-1');
  });

  it('resets stale IN_PROGRESS leases back to QUEUED and re-enqueues file.replicate [P4-10]', async () => {
    mockReplica.status = 'IN_PROGRESS';

    const resetCount = await sweeper.sweepStaleLeases();

    expect(resetCount).toBe(1);
    expect(mockReplica.status).toBe('QUEUED');
    expect(mockReplicaRepo.retry).toHaveBeenCalledWith(
      'f-sweep-1',
      'seaweedfs',
      'Lease expired by sweeper',
      expect.anything(),
    );
    expect(enqueuedOutboxEvents).toHaveLength(1);
  });

  it('re-enqueues file.purge for stuck DELETING files [P4-10]', async () => {
    mockFile.status = 'DELETING';

    const reenqueued = await sweeper.sweepStuckDeleting();

    expect(reenqueued).toBe(1);
    expect(enqueuedOutboxEvents).toHaveLength(1);
    const env = enqueuedOutboxEvents[0] as any;
    expect(env.eventType).toBe('file.purge');
    expect(env.partitionKey).toBe('f-sweep-1');
  });

  it('auto-redrives FAILED replicas when REDRIVE_AFTER_HOURS > 0 [P4-10]', async () => {
    mockReplica.status = 'FAILED';
    mockReplica.attempts = 2;

    const redriven = await sweeper.sweepAutoRedrive();

    expect(redriven).toBe(1);
    expect(mockReplicaRepo.redrive).toHaveBeenCalledWith(
      'f-sweep-1',
      'seaweedfs',
      expect.anything(),
    );
    expect(enqueuedOutboxEvents).toHaveLength(1);
  });

  it('hard-deletes DELETED tombstones and cleans outbox in sweepTombstones / sweepOutbox [P4-10]', async () => {
    const tombstonesCount = await sweeper.sweepTombstones();
    const outboxCount = await sweeper.sweepOutbox();

    expect(tombstonesCount).toBe(2);
    expect(outboxCount).toBe(5);
    expect(mockFileRepo.hardDeleteTombstones).toHaveBeenCalled();
    expect(mockOutboxRepo.deletePublishedOlderThan).toHaveBeenCalled();
  });

  it('skips sweep execution when advisory lock acquisition fails (multi-node leader election) [P4-10]', async () => {
    mocks.lockAcquired = false;

    const count = await sweeper.sweepStuckQueued();
    expect(count).toBe(0);
    expect(enqueuedOutboxEvents).toHaveLength(0);
  });

  it('runs dry-run mode reporting count without mutating state or enqueuing events [P4-10]', async () => {
    const count = await sweeper.sweepStuckQueued(true);

    expect(count).toBe(1);
    expect(enqueuedOutboxEvents).toHaveLength(0);
  });

  it('executes full sweep cycle returning aggregated results [P4-10]', async () => {
    const summary = await sweeper.runSweepCycle();

    expect(summary).toBeDefined();
    expect(typeof summary.stuckQueuedReenqueued).toBe('number');
    expect(typeof summary.tombstonesHardDeleted).toBe('number');
  });
});
