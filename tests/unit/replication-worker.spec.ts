/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-call, @typescript-eslint/require-await */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import * as crypto from 'node:crypto';
import { ReplicationWorker } from '../../src/workers/replication.worker.js';
import { FakeStorageDriver } from '../helpers/storage-driver.mock.js';
import { StorageRegistry } from '../../src/storage/registry.js';
import { MemoryBroker } from '../../src/events/memory-broker.js';
import {
  EVENT_TYPES,
  type FileReplicatePayload,
} from '../../src/events/catalog.js';
import {
  createEnvelope,
  type EventEnvelope,
} from '../../src/events/envelope.js';
import {
  PermanentError,
  RetryableError,
} from '../../src/core/errors/app-error.js';
import type {
  FileRecord,
  FileReplica,
  Provider,
} from '../../src/core/types.js';
import type { AppConfigService } from '../../src/config/config.service.js';
import type { DatabaseService } from '../../src/db/database.service.js';
import type { FileRepository } from '../../src/db/repositories/file.repository.js';
import type { ReplicaRepository } from '../../src/db/repositories/replica.repository.js';
import type { OutboxWriter } from '../../src/events/outbox-writer.js';

describe('ReplicationWorker (P4-07)', () => {
  let worker: ReplicationWorker;
  let seaweedDriver: FakeStorageDriver;
  let localDriver: FakeStorageDriver;
  let cloudinaryDriver: FakeStorageDriver;
  let storageRegistry: StorageRegistry;
  let broker: MemoryBroker;

  let mockFile: FileRecord;
  let mockReplicas: FileReplica[];
  let enqueuedOutboxEvents: EventEnvelope[];

  let mockDbService: DatabaseService;
  let mockFileRepo: FileRepository;
  let mockReplicaRepo: ReplicaRepository;
  let mockOutboxWriter: OutboxWriter;
  let mockConfigService: AppConfigService;

  const content = Buffer.from('hello replication world payload');
  const expectedSha256 = crypto
    .createHash('sha256')
    .update(content)
    .digest('hex');

  beforeEach(async () => {
    seaweedDriver = new FakeStorageDriver('seaweedfs');
    localDriver = new FakeStorageDriver('local');
    cloudinaryDriver = new FakeStorageDriver('cloudinary');

    // Seed file in primary driver (seaweedfs)
    await seaweedDriver.upload({
      key: 'esma-tenant/school-1/photo.jpg',
      source: () => Readable.from(content),
      size: content.length,
      sha256: expectedSha256,
      mimetype: 'image/jpeg',
      visibility: 'tenant',
    });

    const driversMap: Record<string, FakeStorageDriver> = {
      seaweedfs: seaweedDriver,
      local: localDriver,
      cloudinary: cloudinaryDriver,
    };

    storageRegistry = {
      get: (name: string) => {
        const d = driversMap[name];
        if (!d) throw new Error(`Unknown driver ${name}`);
        return d;
      },
      has: (name: string) => Boolean(driversMap[name]),
    } as unknown as StorageRegistry;

    broker = new MemoryBroker();
    await broker.initialize();

    mockFile = {
      id: 'f-repl-100',
      namespace: 'esma-tenant',
      tenantId: 'school-1',
      subTenantId: null,
      folder: 'photos',
      storageKey: 'esma-tenant/school-1/photo.jpg',
      originalFilename: 'photo.jpg',
      mimetype: 'image/jpeg',
      declaredMimetype: 'image/jpeg',
      sizeBytes: BigInt(content.length),
      sha256: expectedSha256,
      visibility: 'tenant',
      status: 'ACTIVE',
      scanStatus: 'NOT_REQUIRED',
      replicationStatus: 'QUEUED',
      primaryProvider: 'seaweedfs',
      uploadedBy: 'u-1',
      tags: ['avatar'],
      attributes: { env: 'test' },
      legacyPublicId: null,
      idempotencyKey: null,
      correlationId: 'corr-repl-100',
      expiresAt: null,
      version: 1,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockReplicas = [
      {
        fileId: 'f-repl-100',
        provider: 'seaweedfs',
        role: 'primary',
        status: 'AVAILABLE',
        providerKey: 'esma-tenant/school-1/photo.jpg',
        providerMeta: {},
        url: 'http://seaweedfs/photo.jpg',
        etag: 'etag-1',
        attempts: 1,
        lastError: null,
        syncedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        fileId: 'f-repl-100',
        provider: 'local',
        role: 'secondary',
        status: 'QUEUED',
        providerKey: 'esma-tenant/school-1/photo.jpg',
        providerMeta: {},
        url: null,
        etag: null,
        attempts: 0,
        lastError: null,
        syncedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    enqueuedOutboxEvents = [];

    mockFileRepo = {
      findById: vi.fn().mockImplementation(async (id: string) => {
        if (id === mockFile.id) return { ...mockFile };
        return null;
      }),
    } as unknown as FileRepository;

    mockReplicaRepo = {
      listByFile: vi.fn().mockImplementation(async () => {
        return mockReplicas.map((r) => ({ ...r }));
      }),
      claim: vi
        .fn()
        .mockImplementation(async (_fileId: string, provider: Provider) => {
          const replica = mockReplicas.find((r) => r.provider === provider);
          if (replica && replica.status === 'QUEUED') {
            replica.status = 'IN_PROGRESS';
            return true;
          }
          return false;
        }),
      complete: vi
        .fn()
        .mockImplementation(
          async (_fileId: string, provider: Provider, meta: any) => {
            const replica = mockReplicas.find((r) => r.provider === provider);
            if (replica) {
              replica.status = 'AVAILABLE';
              replica.syncedAt = new Date();
              if (meta?.url) replica.url = meta.url;
              if (meta?.etag) replica.etag = meta.etag;
              return true;
            }
            return false;
          },
        ),
      retry: vi
        .fn()
        .mockImplementation(
          async (_fileId: string, provider: Provider, error: string) => {
            const replica = mockReplicas.find((r) => r.provider === provider);
            if (replica) {
              replica.status = 'QUEUED';
              replica.attempts++;
              replica.lastError = error;
              return true;
            }
            return false;
          },
        ),
      fail: vi
        .fn()
        .mockImplementation(
          async (_fileId: string, provider: Provider, error: string) => {
            const replica = mockReplicas.find((r) => r.provider === provider);
            if (replica) {
              replica.status = 'FAILED';
              replica.attempts++;
              replica.lastError = error;
              return true;
            }
            return false;
          },
        ),
      markDeleted: vi
        .fn()
        .mockImplementation(async (_fileId: string, provider: Provider) => {
          const replica = mockReplicas.find((r) => r.provider === provider);
          if (replica) {
            replica.status = 'DELETED';
            return true;
          }
          return false;
        }),
    } as unknown as ReplicaRepository;

    const mockKyselyDb = {
      updateTable: () => ({
        set: () => ({
          where: () => ({
            execute: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
      transaction: () => ({
        execute: async (fn: (trx: any) => Promise<any>) => fn({}),
      }),
    };

    mockDbService = {
      getDb: () => mockKyselyDb as any,
    } as unknown as DatabaseService;

    mockOutboxWriter = {
      enqueue: vi.fn().mockImplementation(async (_trx, envelope) => {
        enqueuedOutboxEvents.push(envelope);
      }),
    } as unknown as OutboxWriter;

    mockConfigService = {
      replicationConcurrency: 4,
      replicationMaxAttempts: 3,
      consumerHandlerTimeoutMs: 5000,
      consumerShutdownTimeoutMs: 5000,
    } as unknown as AppConfigService;

    worker = new ReplicationWorker(
      mockConfigService,
      mockDbService,
      mockFileRepo,
      mockReplicaRepo,
      storageRegistry,
      mockOutboxWriter,
      broker,
    );
  });

  afterEach(async () => {
    await worker.stop();
  });

  it('successfully replicates a queued secondary replica and publishes file.replicated', async () => {
    const envelope = createEnvelope<FileReplicatePayload>({
      eventType: EVENT_TYPES.FILE_REPLICATE,
      partitionKey: mockFile.id,
      payload: {
        fileId: mockFile.id,
        targetProvider: 'local',
      },
    });

    const outcome = await worker.handleReplication(envelope, 1, 3);
    expect(outcome.kind).toBe('ack');

    // Target driver should now have the object
    const stat = await localDriver.stat({
      provider: 'local',
      key: mockFile.storageKey,
    });
    expect(stat).toBeDefined();
    expect(stat?.size).toBe(content.length);

    // Replica should be marked AVAILABLE
    const secondary = mockReplicas.find((r) => r.provider === 'local');
    expect(secondary?.status).toBe('AVAILABLE');

    // Outbox should contain file.replicated
    expect(enqueuedOutboxEvents.length).toBe(1);
    expect(enqueuedOutboxEvents[0].eventType).toBe(EVENT_TYPES.FILE_REPLICATED);
    expect(enqueuedOutboxEvents[0].payload).toEqual({
      fileId: mockFile.id,
      provider: 'local',
    });
    expect(worker.metrics.replicated).toBe(1);
  });

  it('acknowledges duplicate delivery harmlessly when replica is already AVAILABLE', async () => {
    // Set secondary replica already AVAILABLE
    const secondary = mockReplicas.find((r) => r.provider === 'local')!;
    secondary.status = 'AVAILABLE';

    const envelope = createEnvelope<FileReplicatePayload>({
      eventType: EVENT_TYPES.FILE_REPLICATE,
      partitionKey: mockFile.id,
      payload: {
        fileId: mockFile.id,
        targetProvider: 'local',
      },
    });

    const outcome = await worker.handleReplication(envelope, 1, 3);
    expect(outcome.kind).toBe('ack');
    expect(mockReplicaRepo.claim).not.toHaveBeenCalled();
    expect(enqueuedOutboxEvents.length).toBe(0);
  });

  it('acknowledges cleanly if CAS claim fails (another worker claimed it)', async () => {
    // Force claim to return false
    (mockReplicaRepo.claim as any).mockResolvedValueOnce(false);

    const envelope = createEnvelope<FileReplicatePayload>({
      eventType: EVENT_TYPES.FILE_REPLICATE,
      partitionKey: mockFile.id,
      payload: {
        fileId: mockFile.id,
        targetProvider: 'local',
      },
    });

    const outcome = await worker.handleReplication(envelope, 1, 3);
    expect(outcome.kind).toBe('ack');
    expect(enqueuedOutboxEvents.length).toBe(0);
  });

  it('handles transient secondary failure by requeueing and throwing retryable error', async () => {
    // Secondary driver fails upload with a retryable error
    localDriver.failNext(new RetryableError('Temporary disk full'));

    const envelope = createEnvelope<FileReplicatePayload>({
      eventType: EVENT_TYPES.FILE_REPLICATE,
      partitionKey: mockFile.id,
      payload: {
        fileId: mockFile.id,
        targetProvider: 'local',
      },
    });

    await expect(worker.handleReplication(envelope, 1, 3)).rejects.toThrow(
      RetryableError,
    );

    expect(mockReplicaRepo.retry).toHaveBeenCalledWith(
      mockFile.id,
      'local',
      'Temporary disk full',
    );
    expect(worker.metrics.retried).toBe(1);
  });

  it('marks replica FAILED and enqueues file.replication_failed when max attempts exceeded', async () => {
    localDriver.failNext(new RetryableError('Connection timeout'));

    const envelope = createEnvelope<FileReplicatePayload>({
      eventType: EVENT_TYPES.FILE_REPLICATE,
      partitionKey: mockFile.id,
      payload: {
        fileId: mockFile.id,
        targetProvider: 'local',
      },
    });

    // Attempt 3 of 3 (maxAttempts)
    await expect(worker.handleReplication(envelope, 3, 3)).rejects.toThrow(
      PermanentError,
    );

    const secondary = mockReplicas.find((r) => r.provider === 'local');
    expect(secondary?.status).toBe('FAILED');

    expect(enqueuedOutboxEvents.length).toBe(1);
    expect(enqueuedOutboxEvents[0].eventType).toBe(
      EVENT_TYPES.FILE_REPLICATION_FAILED,
    );
    expect(enqueuedOutboxEvents[0].payload).toEqual({
      fileId: mockFile.id,
      provider: 'local',
      error: 'Exceeded max attempts (3): Connection timeout',
    });
    expect(worker.metrics.failed).toBe(1);
  });

  it('aborts copy and cleans up target if file becomes deleted mid-copy (F-23)', async () => {
    // Mock findById: initially ACTIVE, but when refreshed after stream upload it is DELETED
    let findCount = 0;
    (mockFileRepo.findById as any).mockImplementation(async () => {
      findCount++;
      if (findCount === 1) return { ...mockFile };
      // Second check: file deleted by client
      return { ...mockFile, status: 'DELETED' };
    });

    const envelope = createEnvelope<FileReplicatePayload>({
      eventType: EVENT_TYPES.FILE_REPLICATE,
      partitionKey: mockFile.id,
      payload: {
        fileId: mockFile.id,
        targetProvider: 'local',
      },
    });

    const outcome = await worker.handleReplication(envelope, 1, 3);
    expect(outcome.kind).toBe('ack');

    // Should have deleted written target object
    const targetStat = await localDriver.stat({
      provider: 'local',
      key: mockFile.storageKey,
    });
    expect(targetStat).toBeNull();

    // Replica marked DELETED
    const secondary = mockReplicas.find((r) => r.provider === 'local');
    expect(secondary?.status).toBe('DELETED');
    expect(mockReplicaRepo.complete).not.toHaveBeenCalled();
  });

  it('detects sha256 mismatch, increments data corruption alert, and marks FAILED', async () => {
    // Provide a file record with an mismatched expected SHA-256
    mockFile.sha256 =
      '0000000000000000000000000000000000000000000000000000000000000000';

    const envelope = createEnvelope<FileReplicatePayload>({
      eventType: EVENT_TYPES.FILE_REPLICATE,
      partitionKey: mockFile.id,
      payload: {
        fileId: mockFile.id,
        targetProvider: 'local',
      },
    });

    await expect(worker.handleReplication(envelope, 1, 3)).rejects.toThrow(
      PermanentError,
    );

    expect(worker.metrics.dataCorruptionAlerts).toBe(1);
    expect(worker.metrics.failed).toBe(1);

    const secondary = mockReplicas.find((r) => r.provider === 'local');
    expect(secondary?.status).toBe('FAILED');

    expect(enqueuedOutboxEvents.length).toBe(1);
    expect(enqueuedOutboxEvents[0].eventType).toBe(
      EVENT_TYPES.FILE_REPLICATION_FAILED,
    );
  });
});
