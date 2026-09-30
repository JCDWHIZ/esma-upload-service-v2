/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/require-await */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import * as crypto from 'node:crypto';
import { ReplicationWorker } from '../../src/workers/replication.worker.js';
import { FakeStorageDriver } from '../helpers/storage-driver.mock.js';
import { StorageRegistry } from '../../src/storage/registry.js';
import { MemoryBroker } from '../../src/events/memory-broker.js';
import {
  EVENT_TYPES,
  type FilePurgePayload,
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

describe('Delete Propagation & file.purge Worker [P4-09]', () => {
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

  const content = Buffer.from('payload for delete propagation tests');
  const expectedSha256 = crypto
    .createHash('sha256')
    .update(content)
    .digest('hex');

  beforeEach(async () => {
    seaweedDriver = new FakeStorageDriver('seaweedfs');
    localDriver = new FakeStorageDriver('local');
    cloudinaryDriver = new FakeStorageDriver('cloudinary');

    // Pre-populate driver storage
    await seaweedDriver.upload({
      key: 'esma-tenant/school-1/photo.jpg',
      source: () => Readable.from(content),
      size: content.length,
      sha256: expectedSha256,
      mimetype: 'image/jpeg',
      visibility: 'tenant',
    });

    await localDriver.upload({
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
      id: 'f-purge-100',
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
      status: 'DELETING',
      scanStatus: 'NOT_REQUIRED',
      replicationStatus: 'QUEUED',
      primaryProvider: 'seaweedfs',
      uploadedBy: 'u-1',
      tags: ['avatar'],
      attributes: { env: 'test' },
      legacyPublicId: null,
      idempotencyKey: null,
      correlationId: 'corr-purge-100',
      expiresAt: null,
      version: 1,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockReplicas = [
      {
        fileId: 'f-purge-100',
        provider: 'seaweedfs',
        role: 'primary',
        status: 'DELETING',
        providerKey: 'esma-tenant/school-1/photo.jpg',
        providerMeta: {},
        url: 'http://seaweedfs/photo.jpg',
        etag: 'etag-seaweed',
        attempts: 0,
        lastError: null,
        syncedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        fileId: 'f-purge-100',
        provider: 'local',
        role: 'secondary',
        status: 'DELETING',
        providerKey: 'esma-tenant/school-1/photo.jpg',
        providerMeta: {},
        url: null,
        etag: 'etag-local',
        attempts: 0,
        lastError: null,
        syncedAt: new Date(),
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
      markDeleting: vi.fn().mockImplementation(async (id: string) => {
        if (id === mockFile.id) {
          mockFile.status = 'DELETING';
          return true;
        }
        return false;
      }),
      markDeleted: vi.fn().mockImplementation(async (id: string) => {
        if (id === mockFile.id) {
          mockFile.status = 'DELETED';
          mockFile.deletedAt = new Date();
          return true;
        }
        return false;
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
        .mockImplementation(async (_fileId: string, provider: Provider) => {
          const replica = mockReplicas.find((r) => r.provider === provider);
          if (replica) {
            replica.status = 'AVAILABLE';
            return true;
          }
          return false;
        }),
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

  it('purges all replicas across drivers, marks file DELETED, and emits file.deleted [P4-09]', async () => {
    const seaweedDeleteSpy = vi.spyOn(seaweedDriver, 'delete');
    const localDeleteSpy = vi.spyOn(localDriver, 'delete');

    const envelope = createEnvelope<FilePurgePayload>({
      eventType: EVENT_TYPES.FILE_PURGE,
      partitionKey: mockFile.id,
      payload: { fileId: mockFile.id },
      namespace: mockFile.namespace,
      tenantId: mockFile.tenantId,
      correlationId: 'corr-purge-test-1',
    });

    const outcome = await worker.handlePurge(envelope, 1, 3);
    expect(outcome).toEqual({ kind: 'ack' });

    // Both drivers were invoked for deletion
    expect(seaweedDeleteSpy).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'seaweedfs' }),
    );
    expect(localDeleteSpy).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'local' }),
    );

    // Objects are actually deleted from storage drivers
    expect(
      await seaweedDriver.stat({
        provider: 'seaweedfs',
        key: mockFile.storageKey,
      }),
    ).toBeNull();
    expect(
      await localDriver.stat({ provider: 'local', key: mockFile.storageKey }),
    ).toBeNull();

    // Replicas and file are marked DELETED
    expect(mockReplicas.every((r) => r.status === 'DELETED')).toBe(true);
    expect(mockFile.status).toBe('DELETED');
    expect(mockFile.deletedAt).toBeInstanceOf(Date);

    // Outbox event file.deleted was emitted
    expect(enqueuedOutboxEvents).toHaveLength(1);
    expect(enqueuedOutboxEvents[0].eventType).toBe(EVENT_TYPES.FILE_DELETED);
    expect(enqueuedOutboxEvents[0].partitionKey).toBe(mockFile.id);
    expect((enqueuedOutboxEvents[0].payload as { fileId: string }).fileId).toBe(
      mockFile.id,
    );
    expect(worker.metrics.purged).toBe(1);
  });

  it('handles delete across every replica state: QUEUED, FAILED, AVAILABLE, DELETING [P4-09]', async () => {
    // Configure replicas in diverse states
    mockReplicas = [
      {
        fileId: mockFile.id,
        provider: 'seaweedfs',
        role: 'primary',
        status: 'AVAILABLE',
        providerKey: mockFile.storageKey,
        providerMeta: {},
        url: null,
        etag: null,
        attempts: 1,
        lastError: null,
        syncedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        fileId: mockFile.id,
        provider: 'local',
        role: 'secondary',
        status: 'FAILED',
        providerKey: mockFile.storageKey,
        providerMeta: {},
        url: null,
        etag: null,
        attempts: 3,
        lastError: 'Disk full',
        syncedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        fileId: mockFile.id,
        provider: 'cloudinary',
        role: 'secondary',
        status: 'QUEUED',
        providerKey: mockFile.storageKey,
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

    const cloudinaryDeleteSpy = vi.spyOn(cloudinaryDriver, 'delete');
    const seaweedDeleteSpy = vi.spyOn(seaweedDriver, 'delete');
    const localDeleteSpy = vi.spyOn(localDriver, 'delete');

    const envelope = createEnvelope<FilePurgePayload>({
      eventType: EVENT_TYPES.FILE_PURGE,
      partitionKey: mockFile.id,
      payload: { fileId: mockFile.id },
      namespace: mockFile.namespace,
      tenantId: mockFile.tenantId,
    });

    const outcome = await worker.handlePurge(envelope, 1, 3);
    expect(outcome).toEqual({ kind: 'ack' });

    // QUEUED replica skipped driver I/O
    expect(cloudinaryDeleteSpy).not.toHaveBeenCalled();

    // AVAILABLE and FAILED replicas had driver.delete called
    expect(seaweedDeleteSpy).toHaveBeenCalled();
    expect(localDeleteSpy).toHaveBeenCalled();

    // All ended with status DELETED
    expect(mockReplicas.every((r) => r.status === 'DELETED')).toBe(true);
    expect(mockFile.status).toBe('DELETED');
  });

  it('is completely idempotent on replay when file is already DELETED [P4-09]', async () => {
    mockFile.status = 'DELETED';
    mockFile.deletedAt = new Date();

    const seaweedDeleteSpy = vi.spyOn(seaweedDriver, 'delete');

    const envelope = createEnvelope<FilePurgePayload>({
      eventType: EVENT_TYPES.FILE_PURGE,
      partitionKey: mockFile.id,
      payload: { fileId: mockFile.id },
    });

    const outcome = await worker.handlePurge(envelope, 1, 3);
    expect(outcome).toEqual({ kind: 'ack' });

    // No driver operations or outbox events on replay
    expect(seaweedDeleteSpy).not.toHaveBeenCalled();
    expect(enqueuedOutboxEvents).toHaveLength(0);
  });

  it('retries with RetryableError when a driver fails deletion, leaving file in DELETING [P4-09]', async () => {
    vi.spyOn(localDriver, 'delete').mockRejectedValueOnce(
      new Error('Connection reset during purge'),
    );

    const envelope = createEnvelope<FilePurgePayload>({
      eventType: EVENT_TYPES.FILE_PURGE,
      partitionKey: mockFile.id,
      payload: { fileId: mockFile.id },
    });

    await expect(worker.handlePurge(envelope, 1, 3)).rejects.toThrow(
      RetryableError,
    );

    // File remains in DELETING state (not yet finalized)
    expect(mockFile.status).toBe('DELETING');
    expect(mockFile.deletedAt).toBeNull();
    expect(enqueuedOutboxEvents).toHaveLength(0);
    expect(worker.metrics.retried).toBe(1);
  });

  it('throws PermanentError when deletion fails after maxAttempts [P4-09]', async () => {
    vi.spyOn(seaweedDriver, 'delete').mockRejectedValue(
      new Error('Permanent S3 403 Forbidden'),
    );

    const envelope = createEnvelope<FilePurgePayload>({
      eventType: EVENT_TYPES.FILE_PURGE,
      partitionKey: mockFile.id,
      payload: { fileId: mockFile.id },
    });

    await expect(worker.handlePurge(envelope, 3, 3)).rejects.toThrow(
      PermanentError,
    );
    expect(worker.metrics.failed).toBe(1);
  });

  describe('Race Condition: Delete during in-flight replication (F-23) [P4-09]', () => {
    it('replication worker step 6 detects DELETING status, cleans up target object and marks replica DELETED', async () => {
      // 1. Setup file currently ACTIVE, with primary on seaweedfs and queued copy on local
      mockFile.status = 'ACTIVE';
      mockReplicas = [
        {
          fileId: mockFile.id,
          provider: 'seaweedfs',
          role: 'primary',
          status: 'AVAILABLE',
          providerKey: mockFile.storageKey,
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
          fileId: mockFile.id,
          provider: 'local',
          role: 'secondary',
          status: 'QUEUED',
          providerKey: mockFile.storageKey,
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

      // Hook localDriver.upload to simulate a user delete occurring mid-transfer
      const origLocalUpload = localDriver.upload.bind(localDriver);
      vi.spyOn(localDriver, 'upload').mockImplementation(async (input) => {
        // While upload stream is writing, DELETE request arrives!
        mockFile.status = 'DELETING';
        return origLocalUpload(input);
      });

      const localDeleteSpy = vi.spyOn(localDriver, 'delete');

      // 2. Replication worker runs handleReplication
      const replEnvelope = createEnvelope<FileReplicatePayload>({
        eventType: EVENT_TYPES.FILE_REPLICATE,
        partitionKey: mockFile.id,
        payload: { fileId: mockFile.id, targetProvider: 'local' },
      });

      const replOutcome = await worker.handleReplication(replEnvelope, 1, 3);
      expect(replOutcome).toEqual({ kind: 'ack' });

      // Step 6 observed mockFile.status is DELETING -> target object deleted on localDriver and replica marked DELETED
      expect(localDeleteSpy).toHaveBeenCalled();
      const localReplica = mockReplicas.find((r) => r.provider === 'local');
      expect(localReplica?.status).toBe('DELETED');
      expect(
        await localDriver.stat({ provider: 'local', key: mockFile.storageKey }),
      ).toBeNull();

      // 3. Purge worker then runs handlePurge
      const purgeEnvelope = createEnvelope<FilePurgePayload>({
        eventType: EVENT_TYPES.FILE_PURGE,
        partitionKey: mockFile.id,
        payload: { fileId: mockFile.id },
      });

      const purgeOutcome = await worker.handlePurge(purgeEnvelope, 1, 3);
      expect(purgeOutcome).toEqual({ kind: 'ack' });

      // Primary on seaweedfs is also purged, file is marked DELETED
      expect(
        await seaweedDriver.stat({
          provider: 'seaweedfs',
          key: mockFile.storageKey,
        }),
      ).toBeNull();
      expect(mockFile.status).toBe('DELETED');
      expect(mockReplicas.every((r) => r.status === 'DELETED')).toBe(true);
      expect(
        enqueuedOutboxEvents.some(
          (e) => e.eventType === EVENT_TYPES.FILE_DELETED,
        ),
      ).toBe(true);
    });
  });

  describe('End-to-End via MemoryBroker [P4-09]', () => {
    it('dispatches file.purge through worker consumer, purging file across drivers', async () => {
      await worker.start();

      const envelope = createEnvelope<FilePurgePayload>({
        eventType: EVENT_TYPES.FILE_PURGE,
        partitionKey: mockFile.id,
        payload: { fileId: mockFile.id },
      });

      // Publish to broker topic 'replication'
      await broker.publish('replication', mockFile.id, envelope);

      // Allow async consumer loop to process message
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(mockFile.status).toBe('DELETED');
      expect(mockReplicas.every((r) => r.status === 'DELETED')).toBe(true);
      expect(
        enqueuedOutboxEvents.some(
          (e) => e.eventType === EVENT_TYPES.FILE_DELETED,
        ),
      ).toBe(true);
    });
  });
});
