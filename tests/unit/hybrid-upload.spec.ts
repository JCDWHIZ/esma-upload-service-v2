import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import { UploadService } from '../../src/files/upload.service.js';
import { type IQuotaGate } from '../../src/files/quota-gate.interface.js';
import { StorageRegistry } from '../../src/storage/registry.js';
import {
  StoragePlacementService,
  type FilePlacementMetadata,
} from '../../src/storage/placement.service.js';
import { FakeStorageDriver } from '../helpers/storage-driver.mock.js';
import { KeyService } from '../../src/core/storage-key.service.js';
import { AuthorizationService } from '../../src/authz/authorization.service.js';
import { AppConfigService } from '../../src/config/config.service.js';
import {
  DEFAULT_POLICIES,
  type UploadPolicy,
} from '../../src/config/policies.js';
import type { RequestContext } from '../../src/core/request-context.js';
import type { IngestedFile } from '../../src/ingest/types.js';
import {
  RetryableError,
  StorageUnavailableError,
} from '../../src/core/errors/app-error.js';
import { uploadManifestResponseSchema } from '../../src/core/manifest.js';
import type {
  FileRecord,
  FileReplica,
  FileVisibility,
  Provider,
  ReplicaRole,
  ReplicaStatus,
  ReplicationStatus,
} from '../../src/core/types.js';
import {
  EVENT_TYPES,
  type FileUploadedPayload,
  type FileReplicatePayload,
} from '../../src/events/catalog.js';
import type { EventEnvelope } from '../../src/events/envelope.js';
import type { DatabaseService } from '../../src/db/database.service.js';
import type { FileRepository } from '../../src/db/repositories/file.repository.js';
import type { ReplicaRepository } from '../../src/db/repositories/replica.repository.js';
import type { UsageRepository } from '../../src/db/repositories/usage.repository.js';
import type { OutboxWriter } from '../../src/events/outbox-writer.js';

function createMockIngestedFile(
  overrides: Partial<IngestedFile> = {},
): IngestedFile {
  const content = Buffer.from('hello hybrid upload world');
  return {
    fieldName: 'file',
    originalName: 'photo.jpg',
    declaredMime: 'image/jpeg',
    detectedMime: 'image/jpeg',
    size: content.length,
    sha256: '5a41544a0e91c7a23c317ff6e1d74a79df8996faad46d61f558778f3c3961ef0',
    path: '/tmp/photo.jpg',
    openReadStream: () => Readable.from(content),
    dispose: () => Promise.resolve(),
    ...overrides,
  };
}

describe('UploadService (hybrid upload & primary failover) [P4-06]', () => {
  let uploadService: UploadService;
  let seaweedDriver: FakeStorageDriver;
  let localDriver: FakeStorageDriver;
  let cloudinaryDriver: FakeStorageDriver;
  let storageRegistry: StorageRegistry;
  let storagePlacement: StoragePlacementService;
  let keyService: KeyService;
  let authzService: AuthorizationService;
  let configService: AppConfigService;
  let mockQuotaGate: IQuotaGate;

  let insertedFiles: FileRecord[];
  let insertedReplicas: FileReplica[];
  let enqueuedOutboxEvents: EventEnvelope[];

  const mockContext: RequestContext = {
    namespace: 'esma-tenant',
    tenantId: 'school-123',
    subTenantId: 'branch-456',
    actor: {
      id: 'usr-999',
      type: 'user',
      roles: ['school_admin'],
      scopes: [],
    },
    correlationId: '0198f3a2-7c1e-7b40-9d2a-5e6f1a8c0000',
    ipAddress: '127.0.0.1',
    attributes: {},
  };

  const defaultPolicy: UploadPolicy = DEFAULT_POLICIES['esma-tenant'];

  beforeEach(() => {
    seaweedDriver = new FakeStorageDriver('seaweedfs');
    localDriver = new FakeStorageDriver('local');
    cloudinaryDriver = new FakeStorageDriver('cloudinary');

    insertedFiles = [];
    insertedReplicas = [];
    enqueuedOutboxEvents = [];

    configService = {
      raw: {
        APP_BASE_URL: 'https://upload.esma.example',
        EVENTS_ENABLED: true,
        ADMIN_ALLOWED_ROLES: 'superadmin',
        STORAGE_DRIVER: 'seaweedfs',
      },
      get: () => configService.raw,
      appBaseUrl: 'https://upload.esma.example',
      eventsEnabled: true,
      adminAllowedRoles: 'superadmin',
    } as unknown as AppConfigService;

    const driversMap: Record<string, FakeStorageDriver> = {
      seaweedfs: seaweedDriver,
      local: localDriver,
      cloudinary: cloudinaryDriver,
    };

    storageRegistry = {
      getPrimary: () => seaweedDriver,
      get: (name: string) => {
        const d = driversMap[name];
        if (!d) throw new Error(`Unknown driver ${name}`);
        return d;
      },
      has: (name: string) => Boolean(driversMap[name]),
      getTopology: () => ({
        mode: 'replicated',
        primary: 'seaweedfs',
        secondaries: ['cloudinary'],
        primaryFailover: ['local'],
        strict: false,
      }),
    } as unknown as StorageRegistry;

    storagePlacement = {
      plan: vi
        .fn()
        .mockImplementation(
          (
            _ctx: RequestContext,
            _policy: UploadPolicy,
            file: FilePlacementMetadata,
          ) => {
            if (file.visibility === 'private') {
              return {
                primaryCandidates: ['seaweedfs', 'local'],
                secondaries: [],
                skippedReasons: { cloudinary: 'SKIPPED_BY_POLICY' },
              };
            }
            return {
              primaryCandidates: ['seaweedfs', 'local'],
              secondaries: ['cloudinary'],
            };
          },
        ),
    } as unknown as StoragePlacementService;

    keyService = new KeyService();

    authzService = {
      authorize: vi.fn().mockReturnValue({
        allowed: true,
        reason: 'Authorized',
        ruleId: 'RULE_ALLOW',
      }),
    } as unknown as AuthorizationService;

    mockQuotaGate = {
      reserve: vi.fn().mockResolvedValue(undefined),
      release: vi.fn().mockResolvedValue(undefined),
    };

    const asStr = (val: unknown): string =>
      typeof val === 'string' ? val : '';
    const asNullableStr = (val: unknown): string | null =>
      typeof val === 'string' ? val : null;

    const mockFileRepo = {
      insert: vi.fn().mockImplementation((data: Record<string, unknown>) => {
        const record: FileRecord = {
          id: asStr(data.id) || '0198f3a2-7c1e-7b40-9d2a-5e6f1a8c3b90',
          namespace: asStr(data.namespace),
          tenantId: asStr(data.tenantId),
          subTenantId: asNullableStr(data.subTenantId),
          folder: asStr(data.folder),
          storageKey: asStr(data.storageKey),
          originalFilename: asStr(data.originalFilename),
          mimetype: asStr(data.mimetype),
          declaredMimetype: asNullableStr(data.declaredMimetype),
          sizeBytes: BigInt(data.sizeBytes as string | number | bigint),
          sha256: asNullableStr(data.sha256),
          visibility: data.visibility as FileVisibility,
          status: 'ACTIVE',
          scanStatus: 'NOT_REQUIRED',
          replicationStatus: data.replicationStatus as ReplicationStatus,
          primaryProvider: data.primaryProvider as Provider,
          uploadedBy: asStr(data.uploadedBy),
          tags: Array.isArray(data.tags) ? (data.tags as string[]) : [],
          attributes: (data.attributes as Record<string, unknown>) ?? {},
          legacyPublicId: asNullableStr(data.legacyPublicId),
          idempotencyKey: asNullableStr(data.idempotencyKey),
          correlationId: asStr(data.correlationId),
          version: 1,
          createdAt: new Date('2026-09-29T12:00:00.000Z'),
          updatedAt: new Date('2026-09-29T12:00:00.000Z'),
          deletedAt: null,
        };
        insertedFiles.push(record);
        return Promise.resolve(record);
      }),
      hardDelete: vi.fn().mockImplementation((id: string) => {
        insertedFiles = insertedFiles.filter((f) => f.id !== id);
        return Promise.resolve(true);
      }),
    };

    const mockReplicaRepo = {
      insertMany: vi
        .fn()
        .mockImplementation((replicas: Array<Record<string, unknown>>) => {
          const created = replicas.map((r) => {
            const rep: FileReplica = {
              fileId: asStr(r.fileId),
              provider: r.provider as Provider,
              role: r.role as ReplicaRole,
              status: r.status as ReplicaStatus,
              providerKey: asStr(r.providerKey),
              providerMeta: (r.providerMeta as Record<string, unknown>) ?? {},
              url: asNullableStr(r.url),
              etag: asNullableStr(r.etag),
              attempts: 0,
              lastError: null,
              syncedAt: r.syncedAt instanceof Date ? r.syncedAt : null,
              createdAt: new Date('2026-09-29T12:00:00.000Z'),
              updatedAt: new Date('2026-09-29T12:00:00.000Z'),
            };
            insertedReplicas.push(rep);
            return rep;
          });
          return Promise.resolve(created);
        }),
    };

    const mockUsageRepo = {
      tryReserve: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(undefined),
    };

    const mockOutboxWriter = {
      enqueue: vi
        .fn()
        .mockImplementation((_trx: unknown, envelope: EventEnvelope) => {
          enqueuedOutboxEvents.push(envelope);
          return Promise.resolve();
        }),
    };

    const mockDatabaseService = {
      getDb: () => ({
        transaction: () => ({
          execute: async <T>(
            callback: (trx: unknown) => Promise<T>,
          ): Promise<T> => {
            return callback({});
          },
        }),
      }),
    };

    uploadService = new UploadService(
      storageRegistry,
      keyService,
      authzService,
      configService,
      mockDatabaseService as unknown as DatabaseService,
      mockFileRepo as unknown as FileRepository,
      mockReplicaRepo as unknown as ReplicaRepository,
      mockUsageRepo as unknown as UsageRepository,
      mockOutboxWriter as unknown as OutboxWriter,
      mockQuotaGate,
      storagePlacement,
    );
  });

  it('hybrid upload: writes primary once, enqueues secondary outbox row, and returns valid manifest', async () => {
    const file = createMockIngestedFile({
      originalName: 'avatar.jpg',
      detectedMime: 'image/jpeg',
    });

    const seaweedUploadSpy = vi.spyOn(seaweedDriver, 'upload');
    const cloudinaryUploadSpy = vi.spyOn(cloudinaryDriver, 'upload');

    const outcomes = await uploadService.upload(mockContext, defaultPolicy, [
      file,
    ]);

    expect(outcomes).toHaveLength(1);
    const outcome = outcomes[0];
    expect(outcome.success).toBe(true);

    if (!outcome.success) return;

    // 1. Primary written synchronously once
    expect(seaweedUploadSpy).toHaveBeenCalledTimes(1);
    // 2. Secondary is NEVER called synchronously
    expect(cloudinaryUploadSpy).not.toHaveBeenCalled();

    // 3. Database records
    expect(insertedFiles).toHaveLength(1);
    const fileRecord = insertedFiles[0];
    expect(fileRecord.primaryProvider).toBe('seaweedfs');
    expect(fileRecord.replicationStatus).toBe('QUEUED');

    // 4. Replicas inserted
    expect(insertedReplicas).toHaveLength(2);
    const primaryRep = insertedReplicas.find((r) => r.role === 'primary');
    const secondaryRep = insertedReplicas.find((r) => r.role === 'secondary');

    expect(primaryRep).toBeDefined();
    expect(primaryRep?.provider).toBe('seaweedfs');
    expect(primaryRep?.status).toBe('AVAILABLE');

    expect(secondaryRep).toBeDefined();
    expect(secondaryRep?.provider).toBe('cloudinary');
    expect(secondaryRep?.status).toBe('QUEUED');
    expect(secondaryRep?.providerKey).toBeDefined();

    // 5. Outbox events: file.uploaded + file.replicate
    expect(enqueuedOutboxEvents).toHaveLength(2);
    const uploadedEvent = enqueuedOutboxEvents.find(
      (e) => e.eventType === EVENT_TYPES.FILE_UPLOADED,
    ) as EventEnvelope<FileUploadedPayload> | undefined;
    const replicateEvent = enqueuedOutboxEvents.find(
      (e) => e.eventType === EVENT_TYPES.FILE_REPLICATE,
    ) as EventEnvelope<FileReplicatePayload> | undefined;

    expect(uploadedEvent).toBeDefined();
    expect(replicateEvent).toBeDefined();
    expect(replicateEvent?.payload.targetProvider).toBe('cloudinary');
    expect(uploadedEvent?.payload.primaryProvider).toBe('seaweedfs');

    // 6. Manifest validation
    const parsed = uploadManifestResponseSchema.safeParse(outcome.manifest);
    expect(parsed.success).toBe(true);
    expect(outcome.manifest.data.replicationStatus).toBe('QUEUED');
    expect(outcome.manifest.data.primaryProvider).toBe('seaweedfs');
    expect(outcome.manifest.data.replicas.seaweedfs?.status).toBe('AVAILABLE');
    expect(outcome.manifest.data.replicas.cloudinary?.status).toBe('QUEUED');
  });

  it('failover loop: fails over to second candidate on RetryableError and increments metric', async () => {
    const file = createMockIngestedFile({
      originalName: 'document.pdf',
      detectedMime: 'application/pdf',
    });

    // seaweedfs fails with RetryableError on initial try and retry
    let seaweedAttempts = 0;
    vi.spyOn(seaweedDriver, 'upload').mockImplementation(() => {
      seaweedAttempts++;
      return Promise.reject(
        new RetryableError('SeaweedFS connection timeout', { status: 503 }),
      );
    });

    const localUploadSpy = vi.spyOn(localDriver, 'upload');

    const outcomes = await uploadService.upload(mockContext, defaultPolicy, [
      file,
    ]);

    expect(outcomes).toHaveLength(1);
    const outcome = outcomes[0];
    expect(outcome.success).toBe(true);

    if (!outcome.success) return;

    // seaweedfs tried twice (1 attempt + 1 retry budget)
    expect(seaweedAttempts).toBe(2);
    // local driver succeeded
    expect(localUploadSpy).toHaveBeenCalledTimes(1);

    // Failover metric incremented
    expect(uploadService.getMetrics().primaryFailovers).toBe(1);

    // File record reflects local as primary provider
    expect(outcome.fileRecord.primaryProvider).toBe('local');
    expect(outcome.manifest.data.primaryProvider).toBe('local');
    expect(outcome.manifest.data.replicas.local?.status).toBe('AVAILABLE');

    // Outbox event has primaryProvider = local
    const uploadedEvent = enqueuedOutboxEvents.find(
      (e) => e.eventType === EVENT_TYPES.FILE_UPLOADED,
    ) as EventEnvelope<FileUploadedPayload> | undefined;
    expect(uploadedEvent?.payload.primaryProvider).toBe('local');
  });

  it('failover loop: immediate failover on non-retryable StorageUnavailableError', async () => {
    const file = createMockIngestedFile({
      originalName: 'test.png',
      detectedMime: 'image/png',
    });

    let seaweedAttempts = 0;
    vi.spyOn(seaweedDriver, 'upload').mockImplementation(() => {
      seaweedAttempts++;
      return Promise.reject(
        new StorageUnavailableError('SeaweedFS disk unmounted'),
      );
    });

    const localUploadSpy = vi.spyOn(localDriver, 'upload');

    const outcomes = await uploadService.upload(mockContext, defaultPolicy, [
      file,
    ]);

    expect(outcomes[0].success).toBe(true);
    // Non-retryable error does not waste retry budget, immediately fails over
    expect(seaweedAttempts).toBe(1);
    expect(localUploadSpy).toHaveBeenCalledTimes(1);
    expect(uploadService.getMetrics().primaryFailovers).toBe(1);
  });

  it('failover loop: all candidates fail -> upload reports failure (non-atomic mode)', async () => {
    const file = createMockIngestedFile({
      originalName: 'fail.jpg',
    });

    vi.spyOn(seaweedDriver, 'upload').mockRejectedValue(
      new StorageUnavailableError('SeaweedFS unavailable'),
    );
    vi.spyOn(localDriver, 'upload').mockRejectedValue(
      new StorageUnavailableError('Local disk full'),
    );

    const outcomes = await uploadService.upload(
      mockContext,
      defaultPolicy,
      [file],
      {
        atomic: false,
      },
    );

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].success).toBe(false);
    if (!outcomes[0].success) {
      expect(outcomes[0].error).toBeInstanceOf(StorageUnavailableError);
    }
  });

  it('manifest policy exclusion: marks excluded secondary as SKIPPED_BY_POLICY', async () => {
    const file = createMockIngestedFile({
      originalName: 'confidential.pdf',
      detectedMime: 'application/pdf',
    });

    const outcomes = await uploadService.upload(
      mockContext,
      defaultPolicy,
      [file],
      { visibility: 'private' },
    );

    expect(outcomes).toHaveLength(1);
    const outcome = outcomes[0];
    expect(outcome.success).toBe(true);

    if (!outcome.success) return;

    // Cloudinary was excluded by policy for private visibility
    expect(outcome.manifest.data.replicas.cloudinary?.status).toBe(
      'SKIPPED_BY_POLICY',
    );
    expect(outcome.manifest.data.replicationStatus).toBe('NOT_REQUIRED');

    // Only file.uploaded event, no file.replicate event
    const replicateEvent = enqueuedOutboxEvents.find(
      (e) => e.eventType === EVENT_TYPES.FILE_REPLICATE,
    );
    expect(replicateEvent).toBeUndefined();
  });

  it('atomic batch compensation: deletes file on the exact driver that stored it', async () => {
    const file1 = createMockIngestedFile({
      originalName: 'file1.jpg',
    });
    const file2 = createMockIngestedFile({
      originalName: 'file2.jpg',
    });

    // File 1 uploads to failover driver 'local' (seaweed fails)
    let callIndex = 0;
    vi.spyOn(seaweedDriver, 'upload').mockImplementation(() => {
      callIndex++;
      if (callIndex <= 2) {
        // Fail file1 seaweed attempts
        return Promise.reject(new RetryableError('Seaweed error'));
      }
      return Promise.reject(new StorageUnavailableError('Seaweed error file2'));
    });

    // Local driver succeeds for file 1, but fails for file 2
    let localCalls = 0;
    vi.spyOn(localDriver, 'upload').mockImplementation((input) => {
      localCalls++;
      if (localCalls === 1) {
        return Promise.resolve({
          ref: { provider: 'local', key: input.key },
          size: input.size,
          etag: 'local-etag',
          url: `http://localhost/${input.key}`,
        });
      }
      return Promise.reject(new StorageUnavailableError('Local failure file2'));
    });

    await expect(
      uploadService.upload(mockContext, defaultPolicy, [file1, file2], {
        atomic: true,
      }),
    ).rejects.toThrow(StorageUnavailableError);

    // Compensation must have deleted file1 on LOCAL driver (not seaweedfs)
    const localDeletes = localDriver
      .getCalls()
      .filter((c) => c.method === 'delete');
    const seaweedDeletes = seaweedDriver
      .getCalls()
      .filter((c) => c.method === 'delete');
    expect(localDeletes).toHaveLength(1);
    expect(seaweedDeletes).toHaveLength(0);
  });
});
