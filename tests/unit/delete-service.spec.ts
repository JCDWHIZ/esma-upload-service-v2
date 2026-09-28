import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import { DeleteService } from '../../src/files/delete.service.js';
import { StorageRegistry } from '../../src/storage/registry.js';
import { FakeStorageDriver } from '../helpers/storage-driver.mock.js';
import { AuthorizationService } from '../../src/authz/authorization.service.js';
import { AppConfigService } from '../../src/config/config.service.js';
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../src/core/errors/app-error.js';
import type { RequestContext } from '../../src/core/request-context.js';
import type { FileRecord, FileReplica } from '../../src/core/types.js';
import type { DatabaseService } from '../../src/db/database.service.js';
import type { FileRepository } from '../../src/db/repositories/file.repository.js';
import type { ReplicaRepository } from '../../src/db/repositories/replica.repository.js';
import type { UsageRepository } from '../../src/db/repositories/usage.repository.js';
import type { OutboxRepository } from '../../src/db/repositories/outbox.repository.js';

describe('DeleteService [P2-08]', () => {
  let deleteService: DeleteService;
  let fakeDriver: FakeStorageDriver;
  let storageRegistry: StorageRegistry;
  let authzService: AuthorizationService;
  let configService: AppConfigService;

  let mockFiles: Map<string, FileRecord>;
  let mockReplicas: Map<string, FileReplica[]>;
  let usageReleased: Array<{
    namespace: string;
    tenantId: string;
    bytes: bigint;
    files: number;
  }>;
  let enqueuedOutboxEvents: Array<Record<string, unknown>>;

  const mockContext: RequestContext = {
    namespace: 'esma-tenant',
    tenantId: 'school-123',
    subTenantId: 'branch-456',
    actor: {
      id: 'usr-999',
      type: 'user',
      roles: ['school_admin'],
      scopes: ['files:delete'],
    },
    correlationId: 'corr-delete-test-123',
    ipAddress: '127.0.0.1',
    attributes: {},
  };

  function createMockFile(overrides: Partial<FileRecord> = {}): FileRecord {
    return {
      id: 'file-uuid-001',
      namespace: 'esma-tenant',
      tenantId: 'school-123',
      subTenantId: 'branch-456',
      folder: 'admissions',
      storageKey: 'schools/school-123/admissions/file-uuid-001.jpg',
      originalFilename: 'student.jpg',
      mimetype: 'image/jpeg',
      declaredMimetype: 'image/jpeg',
      sizeBytes: 1024n,
      sha256: 'abc123hash',
      visibility: 'tenant',
      status: 'ACTIVE',
      scanStatus: 'CLEAN',
      replicationStatus: 'NOT_REQUIRED',
      primaryProvider: 'local',
      uploadedBy: 'usr-999',
      tags: ['photo'],
      attributes: {},
      legacyPublicId: null,
      idempotencyKey: null,
      correlationId: 'corr-orig',
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      ...overrides,
    };
  }

  function createMockReplica(
    overrides: Partial<FileReplica> = {},
  ): FileReplica {
    return {
      fileId: 'file-uuid-001',
      provider: 'local',
      role: 'primary',
      status: 'AVAILABLE',
      providerKey: 'schools/school-123/admissions/file-uuid-001.jpg',
      providerMeta: {},
      url: null,
      etag: 'etag-123',
      attempts: 0,
      lastError: null,
      syncedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  beforeEach(() => {
    fakeDriver = new FakeStorageDriver('local');
    mockFiles = new Map();
    mockReplicas = new Map();
    usageReleased = [];
    enqueuedOutboxEvents = [];

    configService = {
      raw: {
        APP_BASE_URL: 'https://upload.esma.example',
        EVENTS_ENABLED: false,
        ADMIN_ALLOWED_ROLES: 'superadmin',
      },
      get: () => configService.raw,
      appBaseUrl: 'https://upload.esma.example',
      eventsEnabled: false,
    } as unknown as AppConfigService;

    storageRegistry = {
      get: vi.fn().mockImplementation((name: string) => {
        if (name === 'local') return fakeDriver;
        throw new Error(`Unknown provider ${name}`);
      }),
      has: vi.fn().mockReturnValue(true),
    } as unknown as StorageRegistry;

    authzService = {
      authorize: vi.fn().mockReturnValue({
        allowed: true,
        reason: 'Authorized',
        ruleId: 'RULE_ALLOW',
      }),
      canAccessTenant: vi.fn().mockReturnValue(true),
    } as unknown as AuthorizationService;

    const mockFileRepo = {
      findById: vi.fn().mockImplementation((id: string) => {
        return Promise.resolve(mockFiles.get(id) ?? null);
      }),
      markDeleting: vi.fn().mockImplementation((id: string) => {
        const file = mockFiles.get(id);
        if (file && file.status !== 'DELETED') {
          file.status = 'DELETING';
        }
        return Promise.resolve(true);
      }),
      markDeleted: vi.fn().mockImplementation((id: string) => {
        const file = mockFiles.get(id);
        if (file) {
          file.status = 'DELETED';
          file.deletedAt = new Date();
        }
        return Promise.resolve(true);
      }),
    };

    const mockReplicaRepo = {
      listByFile: vi.fn().mockImplementation((fileId: string) => {
        return Promise.resolve(mockReplicas.get(fileId) ?? []);
      }),
      markDeleting: vi
        .fn()
        .mockImplementation((fileId: string, provider: string) => {
          const list = mockReplicas.get(fileId) ?? [];
          for (const rep of list) {
            if (rep.provider === provider && rep.status !== 'DELETED') {
              rep.status = 'DELETING';
            }
          }
          return Promise.resolve();
        }),
      markDeleted: vi
        .fn()
        .mockImplementation((fileId: string, provider: string) => {
          const list = mockReplicas.get(fileId) ?? [];
          for (const rep of list) {
            if (rep.provider === provider) {
              rep.status = 'DELETED';
            }
          }
          return Promise.resolve();
        }),
    };

    const mockUsageRepo = {
      release: vi
        .fn()
        .mockImplementation(
          (
            namespace: string,
            tenantId: string,
            bytes: bigint,
            files: number,
          ) => {
            usageReleased.push({ namespace, tenantId, bytes, files });
            return Promise.resolve();
          },
        ),
    };

    const mockOutboxRepo = {
      enqueue: vi.fn().mockImplementation((event: Record<string, unknown>) => {
        enqueuedOutboxEvents.push(event);
        return Promise.resolve({ id: 'outbox-1' });
      }),
    };

    const mockDatabaseService = {
      getDb: vi.fn().mockReturnValue({
        transaction: () => ({
          execute: async <T>(fn: (trx: unknown) => Promise<T>): Promise<T> => {
            return fn({});
          },
        }),
      }),
    };

    deleteService = new DeleteService(
      storageRegistry,
      authzService,
      configService,
      mockDatabaseService as unknown as DatabaseService,
      mockFileRepo as unknown as FileRepository,
      mockReplicaRepo as unknown as ReplicaRepository,
      mockUsageRepo as unknown as UsageRepository,
      mockOutboxRepo as unknown as OutboxRepository,
    );
  });

  it('successfully deletes an active file and purges its replicas [P2-08]', async () => {
    const file = createMockFile({ id: 'f-1', sizeBytes: 5000n });
    const replica = createMockReplica({ fileId: 'f-1', provider: 'local' });
    mockFiles.set('f-1', file);
    mockReplicas.set('f-1', [replica]);

    // Store object in fake driver
    await fakeDriver.upload({
      key: replica.providerKey,
      source: () => Readable.from(Buffer.from('test data')),
      size: 9,
      mimetype: 'image/jpeg',
      sha256: 'abc123hash',
      visibility: 'tenant',
    });

    const deleteSpy = vi.spyOn(fakeDriver, 'delete');

    await deleteService.delete(mockContext, 'f-1');

    expect(deleteSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'local',
        key: replica.providerKey,
      }),
    );
    expect(file.status).toBe('DELETED');
    expect(file.deletedAt).toBeDefined();
    expect(replica.status).toBe('DELETED');
    expect(usageReleased).toHaveLength(1);
    expect(usageReleased[0]).toEqual({
      namespace: 'esma-tenant',
      tenantId: 'school-123',
      bytes: 5000n,
      files: 1,
    });
  });

  it('marks QUEUED replicas directly as DELETED without invoking driver [P2-08]', async () => {
    const file = createMockFile({ id: 'f-queued' });
    const primaryReplica = createMockReplica({
      fileId: 'f-queued',
      provider: 'local',
      status: 'AVAILABLE',
    });
    const secondaryReplica = createMockReplica({
      fileId: 'f-queued',
      provider: 'seaweedfs',
      role: 'secondary',
      status: 'QUEUED',
    });
    mockFiles.set('f-queued', file);
    mockReplicas.set('f-queued', [primaryReplica, secondaryReplica]);

    await deleteService.delete(mockContext, 'f-queued');

    expect(file.status).toBe('DELETED');
    expect(primaryReplica.status).toBe('DELETED');
    expect(secondaryReplica.status).toBe('DELETED');
  });

  it('is idempotent when deleting an already DELETED file [P2-08]', async () => {
    const file = createMockFile({
      id: 'f-already-del',
      status: 'DELETED',
      deletedAt: new Date(),
    });
    mockFiles.set('f-already-del', file);

    await expect(
      deleteService.delete(mockContext, 'f-already-del'),
    ).resolves.toBeUndefined();

    // Should not release usage again
    expect(usageReleased).toHaveLength(0);
  });

  it('resumes inline purge if file is already in DELETING status [P2-08]', async () => {
    const file = createMockFile({ id: 'f-deleting', status: 'DELETING' });
    const replica = createMockReplica({
      fileId: 'f-deleting',
      status: 'DELETING',
    });
    mockFiles.set('f-deleting', file);
    mockReplicas.set('f-deleting', [replica]);

    await deleteService.delete(mockContext, 'f-deleting');

    // Does not release usage again because it was already released during initial transition
    expect(usageReleased).toHaveLength(0);
    expect(file.status).toBe('DELETED');
    expect(replica.status).toBe('DELETED');
  });

  it('leaves file in DELETING status if a driver fails during inline purge [P2-08]', async () => {
    const file = createMockFile({ id: 'f-driver-fail' });
    const replica = createMockReplica({
      fileId: 'f-driver-fail',
      status: 'AVAILABLE',
    });
    mockFiles.set('f-driver-fail', file);
    mockReplicas.set('f-driver-fail', [replica]);

    // Force driver delete to throw
    vi.spyOn(fakeDriver, 'delete').mockRejectedValueOnce(
      new Error('S3 connection reset'),
    );

    // Should not throw to caller; logs error and leaves file in DELETING
    await deleteService.delete(mockContext, 'f-driver-fail');

    expect(file.status).toBe('DELETING');
    expect(replica.status).toBe('DELETING');
  });

  it('enqueues outbox event file.purge when eventsEnabled is true [P2-08]', async () => {
    (configService as unknown as { eventsEnabled: boolean }).eventsEnabled =
      true;

    const file = createMockFile({ id: 'f-event' });
    const replica = createMockReplica({ fileId: 'f-event' });
    mockFiles.set('f-event', file);
    mockReplicas.set('f-event', [replica]);

    await deleteService.delete(mockContext, 'f-event');

    expect(enqueuedOutboxEvents).toHaveLength(1);
    const firstEvent = enqueuedOutboxEvents[0] as {
      topic: string;
      partitionKey: string;
      eventType: string;
      envelope: {
        eventType: string;
        namespace: string;
        tenantId: string;
        payload: { fileId: string };
      };
    };
    expect(firstEvent.topic).toBe('file.purge');
    expect(firstEvent.partitionKey).toBe('f-event');
    expect(firstEvent.eventType).toBe('file.purge');
    expect(firstEvent.envelope.eventType).toBe('file.purge');
    expect(firstEvent.envelope.namespace).toBe('esma-tenant');
    expect(firstEvent.envelope.tenantId).toBe('school-123');
    expect(firstEvent.envelope.payload.fileId).toBe('f-event');
  });

  it('throws NotFoundError when fileId does not exist [P2-08]', async () => {
    await expect(
      deleteService.delete(mockContext, 'non-existent-id'),
    ).rejects.toThrow(NotFoundError);
  });

  it('throws NotFoundError for cross-tenant access to preserve tenant isolation [P2-08]', async () => {
    const file = createMockFile({
      id: 'f-other-tenant',
      tenantId: 'other-school',
    });
    mockFiles.set('f-other-tenant', file);

    vi.spyOn(authzService, 'canAccessTenant').mockReturnValue(false);

    await expect(
      deleteService.delete(mockContext, 'f-other-tenant'),
    ).rejects.toThrow(NotFoundError);
  });

  it('throws ForbiddenError when authorization action is denied [P2-08]', async () => {
    const file = createMockFile({ id: 'f-denied' });
    mockFiles.set('f-denied', file);

    vi.spyOn(authzService, 'authorize').mockReturnValue({
      allowed: false,
      reason: 'Role teacher cannot delete file',
      ruleId: 'DENY_DELETE',
    });

    await expect(deleteService.delete(mockContext, 'f-denied')).rejects.toThrow(
      ForbiddenError,
    );
  });

  describe('bulkDelete [P2-08]', () => {
    it('rejects empty fileIds array with ValidationError', async () => {
      await expect(deleteService.bulkDelete(mockContext, [])).rejects.toThrow(
        ValidationError,
      );
    });

    it('rejects more than 100 fileIds with ValidationError', async () => {
      const ids = Array.from({ length: 101 }, (_, i) => `file-${i}`);
      await expect(deleteService.bulkDelete(mockContext, ids)).rejects.toThrow(
        ValidationError,
      );
    });

    it('processes batch deletion returning per-ID results', async () => {
      const file1 = createMockFile({ id: 'b-1' });
      const file2 = createMockFile({ id: 'b-2' });
      mockFiles.set('b-1', file1);
      mockFiles.set('b-2', file2);
      mockReplicas.set('b-1', [createMockReplica({ fileId: 'b-1' })]);
      mockReplicas.set('b-2', [createMockReplica({ fileId: 'b-2' })]);

      // 'b-3' does not exist -> NotFoundError
      const res = await deleteService.bulkDelete(mockContext, [
        'b-1',
        'b-2',
        'b-3',
      ]);

      expect(res.total).toBe(3);
      expect(res.deletedCount).toBe(2);
      expect(res.failedCount).toBe(1);
      expect(res.results).toEqual([
        { fileId: 'b-1', success: true },
        { fileId: 'b-2', success: true },
        {
          fileId: 'b-3',
          success: false,
          error: "File 'b-3' not found",
          code: 'FILE_NOT_FOUND',
        },
      ]);
    });
  });
});
