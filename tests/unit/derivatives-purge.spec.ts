/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/require-await */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeleteService } from '../../src/files/delete.service.js';
import { ReplicationWorker } from '../../src/workers/replication.worker.js';
import type { StorageRegistry } from '../../src/storage/registry.js';
import type { AuthorizationService } from '../../src/authz/authorization.service.js';
import type { AppConfigService } from '../../src/config/config.service.js';
import type { DatabaseService } from '../../src/db/database.service.js';
import type { FileRepository } from '../../src/db/repositories/file.repository.js';
import type { ReplicaRepository } from '../../src/db/repositories/replica.repository.js';
import type { UsageRepository } from '../../src/db/repositories/usage.repository.js';
import type { OutboxRepository } from '../../src/db/repositories/outbox.repository.js';
import type { OutboxWriter } from '../../src/events/outbox-writer.js';
import type { IMessageBroker } from '../../src/events/broker.interface.js';
import type { RequestContext } from '../../src/core/request-context.js';
import type { FileRecord, FileReplica } from '../../src/core/types.js';
import {
  EVENT_TYPES,
  type FilePurgePayload,
} from '../../src/events/catalog.js';
import type { EventEnvelope } from '../../src/events/envelope.js';

describe('Derivative Purging (P5-08)', () => {
  let mockStorageRegistry: StorageRegistry;
  let mockPrimaryDriver: any;
  let mockSecondaryDriver: any;
  let mockFileRepo: FileRepository;
  let mockReplicaRepo: ReplicaRepository;
  let mockAuthzService: AuthorizationService;
  let mockConfigService: AppConfigService;
  let mockDatabaseService: DatabaseService;
  let mockUsageRepo: UsageRepository;
  let mockOutboxRepo: OutboxRepository;
  let mockOutboxWriter: OutboxWriter;
  let mockBroker: IMessageBroker;

  const testFile: FileRecord = {
    id: '0198f3a2-7c1e-7b40-9d2a-5e6f1a8c0001',
    namespace: 'esma-tenant',
    tenantId: 'school-100',
    subTenantId: null,
    folder: 'avatars',
    storageKey: 'uploads/esma-tenant/school-100/avatars/avatar.jpg',
    originalFilename: 'avatar.jpg',
    mimetype: 'image/jpeg',
    declaredMimetype: 'image/jpeg',
    sizeBytes: 150000n,
    sha256: 'abc123sha',
    visibility: 'tenant',
    status: 'ACTIVE',
    scanStatus: 'CLEAN',
    replicationStatus: 'SYNCED',
    primaryProvider: 'local',
    uploadedBy: 'user-1',
    tags: [],
    attributes: {},
    derivatives: {
      thumb: {
        key: 'uploads/esma-tenant/school-100/avatars/avatar.jpg.d/thumb.webp',
        size: 4500,
        width: 256,
        height: 192,
        mimetype: 'image/webp',
      },
      medium: {
        key: 'uploads/esma-tenant/school-100/avatars/avatar.jpg.d/medium.webp',
        size: 18000,
        width: 1024,
        height: 768,
        mimetype: 'image/webp',
      },
    },
    legacyPublicId: null,
    idempotencyKey: null,
    correlationId: 'corr-1',
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };

  const testReplicas: FileReplica[] = [
    {
      fileId: testFile.id,
      provider: 'local',
      role: 'primary',
      status: 'AVAILABLE',
      providerKey: testFile.storageKey,
      providerMeta: {},
      url: null,
      etag: null,
      attempts: 0,
      lastError: null,
      syncedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      fileId: testFile.id,
      provider: 'seaweedfs',
      role: 'secondary',
      status: 'AVAILABLE',
      providerKey: testFile.storageKey,
      providerMeta: {},
      url: null,
      etag: null,
      attempts: 0,
      lastError: null,
      syncedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ];

  const adminCtx: RequestContext = {
    namespace: 'esma-tenant',
    tenantId: 'school-100',
    subTenantId: undefined,
    actor: { id: 'admin-1', type: 'user', roles: ['admin'], scopes: ['*'] },
    correlationId: 'corr-del',
    ipAddress: '127.0.0.1',
    attributes: {},
  };

  beforeEach(() => {
    mockPrimaryDriver = {
      name: 'local',
      delete: vi.fn().mockResolvedValue(undefined),
    };
    mockSecondaryDriver = {
      name: 'seaweedfs',
      delete: vi.fn().mockResolvedValue(undefined),
    };

    mockStorageRegistry = {
      get: vi.fn().mockImplementation((name: string) => {
        if (name === 'local') return mockPrimaryDriver;
        if (name === 'seaweedfs') return mockSecondaryDriver;
        return mockPrimaryDriver;
      }),
    } as unknown as StorageRegistry;

    mockFileRepo = {
      findById: vi.fn().mockResolvedValue(testFile),
      markDeleting: vi.fn().mockResolvedValue(true),
      markDeleted: vi.fn().mockResolvedValue(true),
      updateStatus: vi.fn().mockResolvedValue({ ...testFile }),
    } as unknown as FileRepository;

    mockReplicaRepo = {
      listByFile: vi
        .fn()
        .mockResolvedValue(
          testReplicas.map((r) => ({ ...r, status: 'DELETING' })),
        ),
      markDeleting: vi.fn().mockResolvedValue(undefined),
      markDeleted: vi.fn().mockResolvedValue(undefined),
    } as unknown as ReplicaRepository;

    mockAuthzService = {
      canAccessTenant: vi.fn().mockReturnValue(true),
      authorize: vi.fn().mockReturnValue({ allowed: true }),
    } as unknown as AuthorizationService;

    mockConfigService = {
      purgeInline: true,
      eventsEnabled: true,
      consumerHandlerTimeoutMs: 30000,
      consumerShutdownTimeoutMs: 5000,
    } as unknown as AppConfigService;

    mockUsageRepo = {
      decrement: vi.fn().mockResolvedValue(undefined),
      release: vi.fn().mockResolvedValue(undefined),
    } as unknown as UsageRepository;

    mockOutboxRepo = {
      insert: vi.fn().mockResolvedValue(undefined),
    } as unknown as OutboxRepository;

    mockOutboxWriter = {
      enqueue: vi.fn().mockResolvedValue(undefined),
    } as unknown as OutboxWriter;

    mockDatabaseService = {
      getDb: vi.fn().mockReturnValue({
        transaction: () => ({
          execute: async (cb: any) =>
            cb({
              updateTable: () => ({
                set: () => ({
                  where: () => ({
                    execute: vi.fn().mockResolvedValue(undefined),
                  }),
                }),
              }),
            }),
        }),
      }),
    } as unknown as DatabaseService;

    mockBroker = {
      subscribe: vi.fn().mockResolvedValue({
        close: vi.fn().mockResolvedValue(undefined),
      }),
    } as unknown as IMessageBroker;
  });

  it('DeleteService inline purge deletes derivative keys from primary driver', async () => {
    const deleteService = new DeleteService(
      mockStorageRegistry,
      mockAuthzService,
      mockConfigService,
      mockDatabaseService,
      mockFileRepo,
      mockReplicaRepo,
      mockUsageRepo,
      mockOutboxRepo,
      mockOutboxWriter,
    );

    await deleteService.delete(adminCtx, testFile.id);

    // Primary driver should have been called to delete original + thumb + medium
    expect(mockPrimaryDriver.delete).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'uploads/esma-tenant/school-100/avatars/avatar.jpg.d/thumb.webp',
      }),
    );
    expect(mockPrimaryDriver.delete).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'uploads/esma-tenant/school-100/avatars/avatar.jpg.d/medium.webp',
      }),
    );
  });

  it('ReplicationWorker.handlePurge deletes derivative keys from primary driver', async () => {
    const replicationWorker = new ReplicationWorker(
      mockConfigService,
      mockDatabaseService,
      mockFileRepo,
      mockReplicaRepo,
      mockStorageRegistry,
      mockOutboxWriter,
      mockBroker,
    );

    const purgeEnvelope: EventEnvelope<FilePurgePayload> = {
      eventId: 'evt-purge-1',
      eventType: EVENT_TYPES.FILE_PURGE,
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      correlationId: 'corr-purge',
      namespace: testFile.namespace,
      tenantId: testFile.tenantId,
      partitionKey: testFile.id,
      attempt: 0,
      payload: {
        fileId: testFile.id,
      },
    };

    // Simulate all replicas reaching DELETED after purge iteration
    vi.mocked(mockReplicaRepo.listByFile)
      .mockResolvedValueOnce(testReplicas) // initial check
      .mockResolvedValueOnce(
        testReplicas.map((r) => ({ ...r, status: 'DELETED' })), // confirmation check
      );

    const outcome = await replicationWorker.handlePurge(purgeEnvelope, 0, 3);

    expect(outcome).toEqual({ kind: 'ack' });

    // Verify derivative keys purged
    expect(mockPrimaryDriver.delete).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'uploads/esma-tenant/school-100/avatars/avatar.jpg.d/thumb.webp',
      }),
    );
    expect(mockPrimaryDriver.delete).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'uploads/esma-tenant/school-100/avatars/avatar.jpg.d/medium.webp',
      }),
    );
  });
});
