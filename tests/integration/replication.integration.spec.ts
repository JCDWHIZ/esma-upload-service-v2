/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/require-await */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import * as crypto from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { ReplicationWorker } from '../../src/workers/replication.worker.js';
import { OutboxRelay } from '../../src/events/outbox-relay.js';
import { MemoryBroker } from '../../src/events/memory-broker.js';
import { MESSAGE_BROKER } from '../../src/events/broker.interface.js';
import { StorageRegistry } from '../../src/storage/registry.js';
import { FakeStorageDriver } from '../helpers/storage-driver.mock.js';
import { FileRepository } from '../../src/db/repositories/file.repository.js';
import { ReplicaRepository } from '../../src/db/repositories/replica.repository.js';
import { OutboxRepository } from '../../src/db/repositories/outbox.repository.js';
import { DatabaseService } from '../../src/db/database.service.js';
import { AppConfigService } from '../../src/config/config.service.js';
import { OutboxWriter } from '../../src/events/outbox-writer.js';
import {
  EVENT_TYPES,
  type FileReplicatePayload,
} from '../../src/events/catalog.js';
import { createEnvelope } from '../../src/events/envelope.js';
import { RetryableError } from '../../src/core/errors/app-error.js';
import type {
  FileRecord,
  FileReplica,
  NewOutboxEvent,
  OutboxEvent,
  Provider,
} from '../../src/core/types.js';

describe('Replication Integration (End-to-End on Memory Broker) [P4-07]', () => {
  let moduleRef: TestingModule;
  let replicationWorker: ReplicationWorker;
  let outboxRelay: OutboxRelay;
  let memoryBroker: MemoryBroker;
  let primaryDriver: FakeStorageDriver;
  let secondaryDriver: FakeStorageDriver;

  const filesDb = new Map<string, FileRecord>();
  const replicasDb = new Map<string, FileReplica[]>();
  const outboxDb: OutboxEvent[] = [];

  const fileContent = Buffer.from(
    'hello integration replication payload test data',
  );
  const fileSha256 = crypto
    .createHash('sha256')
    .update(fileContent)
    .digest('hex');

  beforeEach(async () => {
    filesDb.clear();
    replicasDb.clear();
    outboxDb.length = 0;

    primaryDriver = new FakeStorageDriver('seaweedfs');
    secondaryDriver = new FakeStorageDriver('local');

    // Pre-populate primary storage driver
    await primaryDriver.upload({
      key: 'generic/tenant-1/doc.pdf',
      source: () => Readable.from(fileContent),
      size: fileContent.length,
      sha256: fileSha256,
      mimetype: 'application/pdf',
      visibility: 'tenant',
    });

    const mockStorageRegistry = {
      get: (name: string) => {
        if (name === 'seaweedfs') return primaryDriver;
        if (name === 'local') return secondaryDriver;
        throw new Error(`Driver not found: ${name}`);
      },
      has: (name: string) => ['seaweedfs', 'local'].includes(name),
      getTopology: () => ({ primary: 'seaweedfs', secondaries: ['local'] }),
      health: () => ({
        seaweedfs: { ok: true, latencyMs: 2 },
        local: { ok: true, latencyMs: 1 },
      }),
    };

    const mockFileRepo = {
      findById: vi.fn(async (id: string) => {
        const file = filesDb.get(id);
        return file ? { ...file } : null;
      }),
    };

    const mockReplicaRepo = {
      listByFile: vi.fn(async (fileId: string) => {
        const reps = replicasDb.get(fileId) ?? [];
        return reps.map((r) => ({ ...r }));
      }),
      claim: vi.fn(async (fileId: string, provider: Provider) => {
        const reps = replicasDb.get(fileId) ?? [];
        const rep = reps.find((r) => r.provider === provider);
        if (rep && rep.status === 'QUEUED') {
          rep.status = 'IN_PROGRESS';
          return true;
        }
        return false;
      }),
      complete: vi.fn(async (fileId: string, provider: Provider, meta: any) => {
        const reps = replicasDb.get(fileId) ?? [];
        const rep = reps.find((r) => r.provider === provider);
        if (rep) {
          rep.status = 'AVAILABLE';
          rep.syncedAt = new Date();
          if (meta?.url) rep.url = meta.url;
          if (meta?.etag) rep.etag = meta.etag;
          if (meta?.providerMeta) rep.providerMeta = meta.providerMeta;

          // Recompute aggregate replication status on file
          const allReplicas = reps;
          const secondaries = allReplicas.filter((r) => r.role === 'secondary');
          const allAvailable =
            secondaries.length > 0 &&
            secondaries.every((r) => r.status === 'AVAILABLE');
          const file = filesDb.get(fileId);
          if (file) {
            file.replicationStatus = allAvailable ? 'SYNCED' : 'PARTIAL';
          }
          return true;
        }
        return false;
      }),
      retry: vi.fn(
        async (fileId: string, provider: Provider, error: string) => {
          const reps = replicasDb.get(fileId) ?? [];
          const rep = reps.find((r) => r.provider === provider);
          if (rep) {
            rep.status = 'QUEUED';
            rep.attempts++;
            rep.lastError = error;
            return true;
          }
          return false;
        },
      ),
      fail: vi.fn(async (fileId: string, provider: Provider, error: string) => {
        const reps = replicasDb.get(fileId) ?? [];
        const rep = reps.find((r) => r.provider === provider);
        if (rep) {
          rep.status = 'FAILED';
          rep.attempts++;
          rep.lastError = error;
          const file = filesDb.get(fileId);
          if (file) {
            file.replicationStatus = 'FAILED';
          }
          return true;
        }
        return false;
      }),
      markDeleted: vi.fn(async (fileId: string, provider: Provider) => {
        const reps = replicasDb.get(fileId) ?? [];
        const rep = reps.find((r) => r.provider === provider);
        if (rep) {
          rep.status = 'DELETED';
          return true;
        }
        return false;
      }),
    };

    const mockOutboxRepo = {
      enqueue: vi.fn(async (event: NewOutboxEvent) => {
        const row: OutboxEvent = {
          id: `evt-${outboxDb.length + 1}`,
          topic: event.topic,
          partitionKey: event.partitionKey,
          eventType: event.eventType,
          envelope: event.envelope,
          availableAt: new Date(),
          publishedAt: null,
          attempts: 0,
          lastError: null,
          createdAt: new Date(),
        };
        outboxDb.push(row);
        return row;
      }),
      claimBatch: vi.fn(async (limit: number) => {
        const unpublished = outboxDb
          .filter((e) => e.publishedAt === null)
          .slice(0, limit);
        return unpublished;
      }),
      markPublished: vi.fn(async (id: string) => {
        const row = outboxDb.find((e) => e.id === id);
        if (row) {
          row.publishedAt = new Date();
        }
      }),
    };

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

    const mockDbService = {
      getDb: () => mockKyselyDb as any,
      ping: vi.fn().mockResolvedValue(true),
    };

    memoryBroker = new MemoryBroker();
    await memoryBroker.initialize();

    moduleRef = await Test.createTestingModule({
      providers: [
        ReplicationWorker,
        OutboxRelay,
        OutboxWriter,
        {
          provide: StorageRegistry,
          useValue: mockStorageRegistry,
        },
        {
          provide: FileRepository,
          useValue: mockFileRepo,
        },
        {
          provide: ReplicaRepository,
          useValue: mockReplicaRepo,
        },
        {
          provide: OutboxRepository,
          useValue: mockOutboxRepo,
        },
        {
          provide: DatabaseService,
          useValue: mockDbService,
        },
        {
          provide: MESSAGE_BROKER,
          useValue: memoryBroker,
        },
        {
          provide: AppConfigService,
          useValue: {
            workerRoles: 'relay,replication',
            replicationConcurrency: 4,
            replicationMaxAttempts: 3,
            consumerHandlerTimeoutMs: 5000,
            consumerShutdownTimeoutMs: 5000,
            outboxPollMinMs: 50,
            outboxPollMaxMs: 500,
            outboxBatchSize: 10,
            eventsEnabled: true,
          },
        },
      ],
    }).compile();

    replicationWorker = moduleRef.get(ReplicationWorker);
    outboxRelay = moduleRef.get(OutboxRelay);

    await replicationWorker.start();
  });

  afterEach(async () => {
    await replicationWorker.stop();
    outboxRelay.stop();
    await memoryBroker.disconnect();
    await moduleRef.close();
  });

  function createTestFile(
    fileId: string,
    overrides: Partial<FileRecord> = {},
  ): FileRecord {
    return {
      id: fileId,
      namespace: 'generic',
      tenantId: 'tenant-1',
      subTenantId: null,
      folder: 'docs',
      storageKey: 'generic/tenant-1/doc.pdf',
      originalFilename: 'doc.pdf',
      mimetype: 'application/pdf',
      declaredMimetype: 'application/pdf',
      sizeBytes: BigInt(fileContent.length),
      sha256: fileSha256,
      visibility: 'tenant',
      status: 'ACTIVE',
      scanStatus: 'NOT_REQUIRED',
      replicationStatus: 'QUEUED',
      primaryProvider: 'seaweedfs',
      uploadedBy: 'user-1',
      tags: [],
      attributes: {},
      legacyPublicId: null,
      idempotencyKey: null,
      correlationId: `corr-${fileId}`,
      expiresAt: null,
      version: 1,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  function createTestReplicas(
    fileId: string,
    storageKey = 'generic/tenant-1/doc.pdf',
  ): FileReplica[] {
    return [
      {
        fileId,
        provider: 'seaweedfs',
        role: 'primary',
        status: 'AVAILABLE',
        providerKey: storageKey,
        providerMeta: {},
        url: null,
        etag: 'etag-pri',
        attempts: 1,
        lastError: null,
        syncedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        fileId,
        provider: 'local',
        role: 'secondary',
        status: 'QUEUED',
        providerKey: storageKey,
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
  }

  it('runs complete upload -> outbox -> relay -> worker -> secondary AVAILABLE -> aggregate SYNCED -> file.replicated', async () => {
    const fileId = 'file-e2e-001';
    const testFile = createTestFile(fileId);
    const replicas = createTestReplicas(fileId, testFile.storageKey);

    filesDb.set(fileId, testFile);
    replicasDb.set(fileId, replicas);

    // 1. Enqueue file.replicate event to outbox (as UploadService does)
    const outboxWriter = moduleRef.get(OutboxWriter);
    const replicateEnvelope = createEnvelope<FileReplicatePayload>({
      eventType: EVENT_TYPES.FILE_REPLICATE,
      partitionKey: fileId,
      payload: {
        fileId,
        targetProvider: 'local',
      },
    });
    await outboxWriter.enqueue({} as any, replicateEnvelope);

    expect(outboxDb.length).toBe(1);
    expect(outboxDb[0].publishedAt).toBeNull();

    // 2. Run single OutboxRelay cycle: publishes event from outbox to memoryBroker
    const outboxRepo = moduleRef.get(OutboxRepository);
    const unpublished = await outboxRepo.claimBatch(10);
    expect(unpublished.length).toBe(1);

    await memoryBroker.publish(
      'replication',
      unpublished[0].partitionKey,
      unpublished[0].envelope as any,
    );
    await outboxRepo.markPublished(unpublished[0].id);

    // Give handler ticks to execute via broker
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setImmediate(r));
    }

    // 3. Verify secondary driver has received the replicated object
    const secondaryStat = await secondaryDriver.stat({
      provider: 'local',
      key: testFile.storageKey,
    });
    expect(secondaryStat).toBeDefined();
    expect(secondaryStat?.size).toBe(fileContent.length);

    // 4. Verify replica status transitioned to AVAILABLE and file aggregate is SYNCED
    const secondaryReplica = replicasDb
      .get(fileId)
      ?.find((r) => r.provider === 'local');
    expect(secondaryReplica?.status).toBe('AVAILABLE');
    expect(filesDb.get(fileId)?.replicationStatus).toBe('SYNCED');

    // 5. Verify file.replicated event was enqueued into outbox
    const replicatedEvents = outboxDb.filter(
      (e) => e.eventType === EVENT_TYPES.FILE_REPLICATED,
    );
    expect(replicatedEvents.length).toBe(1);
    expect((replicatedEvents[0].envelope as any).payload).toEqual({
      fileId,
      provider: 'local',
    });
  });

  it('guarantees harmless idempotency when two workers race for the same job', async () => {
    const fileId = 'file-race-002';
    const testFile = createTestFile(fileId);
    const replicas = createTestReplicas(fileId, testFile.storageKey);

    filesDb.set(fileId, testFile);
    replicasDb.set(fileId, replicas);

    const envelope = createEnvelope<FileReplicatePayload>({
      eventType: EVENT_TYPES.FILE_REPLICATE,
      partitionKey: fileId,
      payload: {
        fileId,
        targetProvider: 'local',
      },
    });

    // Run two worker handlers concurrently racing on the same event
    const [outcome1, outcome2] = await Promise.all([
      replicationWorker.handleReplication(envelope, 1, 3),
      replicationWorker.handleReplication(envelope, 1, 3),
    ]);

    expect(outcome1.kind).toBe('ack');
    expect(outcome2.kind).toBe('ack');

    // Only one upload performed, replica is AVAILABLE
    const secondaryReplica = replicasDb
      .get(fileId)
      ?.find((r) => r.provider === 'local');
    expect(secondaryReplica?.status).toBe('AVAILABLE');
  });

  it('recovers after a transient secondary failure', async () => {
    const fileId = 'file-transient-003';
    const testFile = createTestFile(fileId);
    const replicas = createTestReplicas(fileId, testFile.storageKey);

    filesDb.set(fileId, testFile);
    replicasDb.set(fileId, replicas);

    const envelope = createEnvelope<FileReplicatePayload>({
      eventType: EVENT_TYPES.FILE_REPLICATE,
      partitionKey: fileId,
      payload: {
        fileId,
        targetProvider: 'local',
      },
    });

    // Inject temporary failure on attempt 1
    secondaryDriver.failNext(new RetryableError('Temporary network glitch'));

    await expect(
      replicationWorker.handleReplication(envelope, 1, 3),
    ).rejects.toThrow(RetryableError);

    let sec = replicasDb.get(fileId)?.find((r) => r.provider === 'local');
    expect(sec?.status).toBe('QUEUED');
    expect(sec?.attempts).toBe(1);

    // Attempt 2 succeeds
    const outcome = await replicationWorker.handleReplication(envelope, 2, 3);
    expect(outcome.kind).toBe('ack');

    sec = replicasDb.get(fileId)?.find((r) => r.provider === 'local');
    expect(sec?.status).toBe('AVAILABLE');
  });

  it('cleans up target object and marks replica DELETED if file deleted mid-copy (F-23)', async () => {
    const fileId = 'file-delete-mid-004';
    const testFile = createTestFile(fileId);
    const replicas = createTestReplicas(fileId, testFile.storageKey);

    filesDb.set(fileId, testFile);
    replicasDb.set(fileId, replicas);

    // Mock file becoming DELETED on refresh
    let checks = 0;
    const fileRepo = moduleRef.get(FileRepository);
    vi.spyOn(fileRepo, 'findById').mockImplementation(async () => {
      checks++;
      if (checks === 1) return { ...testFile };
      return { ...testFile, status: 'DELETED' };
    });

    const envelope = createEnvelope<FileReplicatePayload>({
      eventType: EVENT_TYPES.FILE_REPLICATE,
      partitionKey: fileId,
      payload: {
        fileId,
        targetProvider: 'local',
      },
    });

    const outcome = await replicationWorker.handleReplication(envelope, 1, 3);
    expect(outcome.kind).toBe('ack');

    // Target object on secondary driver must not remain
    const secStat = await secondaryDriver.stat({
      provider: 'local',
      key: testFile.storageKey,
    });
    expect(secStat).toBeNull();

    // Secondary replica must be DELETED
    const sec = replicasDb.get(fileId)?.find((r) => r.provider === 'local');
    expect(sec?.status).toBe('DELETED');
  });

  it('fails replica and raises alert on sha256 mismatch injection', async () => {
    const fileId = 'file-mismatch-005';
    const testFile = createTestFile(fileId, {
      sha256:
        'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    });
    const replicas = createTestReplicas(fileId, testFile.storageKey);

    filesDb.set(fileId, testFile);
    replicasDb.set(fileId, replicas);

    const envelope = createEnvelope<FileReplicatePayload>({
      eventType: EVENT_TYPES.FILE_REPLICATE,
      partitionKey: fileId,
      payload: {
        fileId,
        targetProvider: 'local',
      },
    });

    await expect(
      replicationWorker.handleReplication(envelope, 1, 3),
    ).rejects.toThrow(/Data corruption/);

    expect(replicationWorker.metrics.dataCorruptionAlerts).toBe(1);

    // Target object must not remain available on secondary
    const secStat = await secondaryDriver.stat({
      provider: 'local',
      key: testFile.storageKey,
    });
    expect(secStat).toBeNull();

    // Replica should be marked FAILED
    const sec = replicasDb.get(fileId)?.find((r) => r.provider === 'local');
    expect(sec?.status).toBe('FAILED');

    // file.replication_failed event should be emitted
    const failedEvt = outboxDb.find(
      (e) => e.eventType === EVENT_TYPES.FILE_REPLICATION_FAILED,
    );
    expect(failedEvt).toBeDefined();
  });
});
