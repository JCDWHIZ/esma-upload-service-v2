import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import { UploadService } from '../../src/files/upload.service.js';
import { IQuotaGate } from '../../src/files/quota-gate.interface.js';
import { StorageRegistry } from '../../src/storage/registry.js';
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
  ForbiddenError,
  PolicyViolationError,
  QuotaExceededError,
  RetryableError,
  StorageUnavailableError,
} from '../../src/core/errors/app-error.js';
import { uploadManifestResponseSchema } from '../../src/core/manifest.js';
import type { FileRecord, FileReplica } from '../../src/core/types.js';

function createMockIngestedFile(
  overrides: Partial<IngestedFile> = {},
): IngestedFile {
  const content = Buffer.from('hello upload service world');
  return {
    fieldName: 'file',
    originalName: 'test.jpg',
    declaredMime: 'image/jpeg',
    detectedMime: 'image/jpeg',
    size: content.length,
    sha256: '5a41544a0e91c7a23c317ff6e1d74a79df8996faad46d61f558778f3c3961ef0',
    path: '/tmp/test.jpg',
    openReadStream: () => Readable.from(content),
    dispose: () => Promise.resolve(),
    ...overrides,
  };
}

describe('UploadService (single-driver mode) [P2-06]', () => {
  let uploadService: UploadService;
  let fakeDriver: FakeStorageDriver;
  let storageRegistry: StorageRegistry;
  let keyService: KeyService;
  let authzService: AuthorizationService;
  let configService: AppConfigService;
  let mockQuotaGate: IQuotaGate;
  let reserveSpy: ReturnType<typeof vi.fn>;
  let releaseSpy: ReturnType<typeof vi.fn>;

  let insertedFiles: FileRecord[];
  let insertedReplicas: FileReplica[];
  let deletedFiles: string[];
  let mockUsageReserved: boolean;
  let mockUsageReleased: boolean;
  let enqueuedOutboxEvents: unknown[];
  let dbTransactionFails: boolean;

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
    fakeDriver = new FakeStorageDriver('local');
    insertedFiles = [];
    insertedReplicas = [];
    deletedFiles = [];
    mockUsageReserved = true;
    mockUsageReleased = false;
    enqueuedOutboxEvents = [];
    dbTransactionFails = false;

    // Config service mock
    configService = {
      raw: {
        APP_BASE_URL: 'https://upload.esma.example',
        EVENTS_ENABLED: false,
        ADMIN_ALLOWED_ROLES: 'superadmin',
        STORAGE_DRIVER: 'local',
      },
      get: () => configService.raw,
      appBaseUrl: 'https://upload.esma.example',
      eventsEnabled: false,
      adminAllowedRoles: 'superadmin',
    } as unknown as AppConfigService;

    // Storage registry mock
    storageRegistry = {
      getPrimary: () => fakeDriver,
      get: () => fakeDriver,
      has: () => true,
    } as unknown as StorageRegistry;

    keyService = new KeyService();

    // Authorization service mock
    authzService = {
      authorize: vi.fn().mockReturnValue({
        allowed: true,
        reason: 'Authorized',
        ruleId: 'RULE_ALLOW',
      }),
    } as unknown as AuthorizationService;

    // QuotaGate mock
    reserveSpy = vi.fn().mockResolvedValue(undefined);
    releaseSpy = vi.fn().mockResolvedValue(undefined);
    mockQuotaGate = {
      reserve: reserveSpy as unknown as (
        ctx: RequestContext,
        bytes: number | bigint,
      ) => Promise<void>,
      release: releaseSpy as unknown as (
        ctx: RequestContext,
        bytes: number | bigint,
      ) => Promise<void>,
    };

    // Database / Repository mocks
    const mockFileRepo = {
      insert: vi.fn().mockImplementation((data: Record<string, unknown>) => {
        const record: FileRecord = {
          id: (data.id as string) ?? '0198f3a2-7c1e-7b40-9d2a-5e6f1a8c3b90',
          namespace: data.namespace as string,
          tenantId: data.tenantId as string,
          subTenantId: (data.subTenantId as string) ?? null,
          folder: (data.folder as string) ?? '',
          storageKey: data.storageKey as string,
          originalFilename: data.originalFilename as string,
          mimetype: data.mimetype as string,
          declaredMimetype: (data.declaredMimetype as string) ?? null,
          sizeBytes: BigInt(data.sizeBytes as string | number | bigint),
          sha256: (data.sha256 as string) ?? null,
          visibility: data.visibility as 'tenant' | 'private' | 'public',
          status: 'ACTIVE',
          scanStatus: 'NOT_REQUIRED',
          replicationStatus: 'NOT_REQUIRED',
          primaryProvider: 'local',
          uploadedBy: data.uploadedBy as string,
          tags: (data.tags as string[]) ?? [],
          attributes: (data.attributes as Record<string, unknown>) ?? {},
          legacyPublicId: (data.legacyPublicId as string) ?? null,
          idempotencyKey: (data.idempotencyKey as string) ?? null,
          correlationId: data.correlationId as string,
          version: 1,
          createdAt: new Date('2026-09-28T12:00:00.000Z'),
          updatedAt: new Date('2026-09-28T12:00:00.000Z'),
          deletedAt: null,
        };
        insertedFiles.push(record);
        return Promise.resolve(record);
      }),
      hardDelete: vi.fn().mockImplementation((id: string) => {
        deletedFiles.push(id);
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
              fileId: r.fileId as string,
              provider: 'local',
              role: 'primary',
              status: 'AVAILABLE',
              providerKey: r.providerKey as string,
              providerMeta: {},
              url: null,
              etag: (r.etag as string) ?? null,
              attempts: 0,
              lastError: null,
              syncedAt: new Date('2026-09-28T12:00:00.000Z'),
              createdAt: new Date('2026-09-28T12:00:00.000Z'),
              updatedAt: new Date('2026-09-28T12:00:00.000Z'),
            };
            insertedReplicas.push(rep);
            return rep;
          });
          return Promise.resolve(created);
        }),
    };

    const mockUsageRepo = {
      tryReserve: vi.fn().mockImplementation(() => {
        return Promise.resolve(mockUsageReserved);
      }),
      release: vi.fn().mockImplementation(() => {
        mockUsageReleased = true;
        return Promise.resolve();
      }),
    };

    const mockOutboxWriter = {
      enqueue: vi.fn().mockImplementation((trx: unknown, envelope: unknown) => {
        void trx;
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
            if (dbTransactionFails) {
              throw new Error('Database transaction abort simulated');
            }
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
      mockDatabaseService as unknown as import('../../src/db/database.service.js').DatabaseService,
      mockFileRepo as unknown as import('../../src/db/repositories/file.repository.js').FileRepository,
      mockReplicaRepo as unknown as import('../../src/db/repositories/replica.repository.js').ReplicaRepository,
      mockUsageRepo as unknown as import('../../src/db/repositories/usage.repository.js').UsageRepository,
      mockOutboxWriter as unknown as import('../../src/events/outbox-writer.js').OutboxWriter,
      mockQuotaGate,
    );
  });

  it('uploads a file successfully and produces a valid ARCH §9.2 manifest', async () => {
    const file = createMockIngestedFile({
      originalName: 'grade_sheet.pdf',
      detectedMime: 'application/pdf',
    });
    const outcomes = await uploadService.upload(mockContext, defaultPolicy, [
      file,
    ]);

    expect(outcomes).toHaveLength(1);
    const outcome = outcomes[0];
    expect(outcome.success).toBe(true);

    if (outcome.success) {
      expect(outcome.fileRecord.originalFilename).toBe('grade_sheet.pdf');
      expect(outcome.fileRecord.storageKey).toMatch(
        /^tenants\/school-123\/branches\/branch-456\/[a-f0-9-]+\.pdf$/,
      );
      expect(outcome.fileRecord.primaryProvider).toBe('local');
      expect(outcome.fileRecord.visibility).toBe('tenant');

      // Manifest schema validation
      const parseResult = uploadManifestResponseSchema.safeParse(
        outcome.manifest,
      );
      expect(parseResult.success).toBe(true);
      expect(outcome.manifest.data.canonicalUrl).toBe(
        `https://upload.esma.example/api/v1/files/${outcome.fileId}`,
      );
      expect(outcome.manifest.data.replicas.local.status).toBe('AVAILABLE');
      expect(outcome.manifest.data.replicationStatus).toBe('NOT_REQUIRED');
    }

    // Verify quota gate reserved
    expect(reserveSpy).toHaveBeenCalledWith(mockContext, file.size);
    // Verify driver stored the object
    expect(insertedFiles).toHaveLength(1);
    expect(insertedReplicas).toHaveLength(1);
  });

  it('rejects upload when authorization denies action and touches no storage or db', async () => {
    (authzService.authorize as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      allowed: false,
      reason: 'School admin cannot upload to this branch',
      ruleId: 'RULE_BRANCH_MISMATCH',
    });

    const file = createMockIngestedFile();
    await expect(
      uploadService.upload(mockContext, defaultPolicy, [file]),
    ).rejects.toThrow(ForbiddenError);

    expect(insertedFiles).toHaveLength(0);
    expect(insertedReplicas).toHaveLength(0);
  });

  it('rejects upload when visibility is not permitted by policy', async () => {
    const strictPolicy: UploadPolicy = {
      ...defaultPolicy,
      allowedVisibilities: ['tenant'],
    };

    const file = createMockIngestedFile();
    await expect(
      uploadService.upload(mockContext, strictPolicy, [file], {
        visibility: 'public',
      }),
    ).rejects.toThrow(PolicyViolationError);

    expect(insertedFiles).toHaveLength(0);
  });

  it('retries up to 2 times on RetryableError and succeeds on subsequent attempt', async () => {
    const file = createMockIngestedFile();
    let streamOpenCount = 0;
    const fileWithStreamSpy: IngestedFile = {
      ...file,
      openReadStream: () => {
        streamOpenCount++;
        return Readable.from(Buffer.from('stream payload'));
      },
    };

    // Inject 1 retryable error
    fakeDriver.failNext(
      'upload',
      new RetryableError('Transient storage 503', { retryAfterMs: 1 }),
    );

    const outcomes = await uploadService.upload(mockContext, defaultPolicy, [
      fileWithStreamSpy,
    ]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].success).toBe(true);
    expect(streamOpenCount).toBe(2); // First failed, retry opened a new stream
  });

  it('propagates error when driver fails permanently and creates no DB records or orphans', async () => {
    fakeDriver.failNext('upload', new Error('Permanent S3 permission denied'));

    const file = createMockIngestedFile();
    await expect(
      uploadService.upload(mockContext, defaultPolicy, [file]),
    ).rejects.toThrow();

    expect(insertedFiles).toHaveLength(0);
    expect(insertedReplicas).toHaveLength(0);
    expect(releaseSpy).toHaveBeenCalledWith(mockContext, file.size);
  });

  it('compensates by deleting the stored object when the DB transaction fails after primary upload', async () => {
    dbTransactionFails = true;
    const file = createMockIngestedFile();

    await expect(
      uploadService.upload(mockContext, defaultPolicy, [file]),
    ).rejects.toThrow(StorageUnavailableError);

    // Primary driver stored object was deleted during compensation
    const calls = fakeDriver.getCalls();
    const deleteCalls = calls.filter((c) => c.method === 'delete');
    expect(deleteCalls.length).toBeGreaterThanOrEqual(1);

    // Released quota gate
    expect(releaseSpy).toHaveBeenCalledWith(mockContext, file.size);
  });

  it('compensates and throws QuotaExceededError when tenant quota is exceeded in database', async () => {
    mockUsageReserved = false; // tryReserve fails
    const file = createMockIngestedFile();

    await expect(
      uploadService.upload(mockContext, defaultPolicy, [file]),
    ).rejects.toThrow(QuotaExceededError);

    // Primary driver object should have been deleted by compensation
    const calls = fakeDriver.getCalls();
    const deleteCalls = calls.filter((c) => c.method === 'delete');
    expect(deleteCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('compensates all earlier files in an atomic batch of 3 when the 3rd fails, leaving nothing behind', async () => {
    const file1 = createMockIngestedFile({ originalName: 'doc1.jpg' });
    const file2 = createMockIngestedFile({ originalName: 'doc2.jpg' });
    const file3 = createMockIngestedFile({ originalName: 'doc3.jpg' });

    let uploadCount = 0;
    const originalUpload = fakeDriver.upload.bind(fakeDriver);
    vi.spyOn(fakeDriver, 'upload').mockImplementation(async (input) => {
      uploadCount++;
      if (uploadCount === 3) {
        throw new Error('Disk full on file 3');
      }
      return originalUpload(input);
    });

    await expect(
      uploadService.upload(mockContext, defaultPolicy, [file1, file2, file3], {
        atomic: true,
      }),
    ).rejects.toThrow(StorageUnavailableError);

    // Assert compensation deleted earlier files from DB
    expect(deletedFiles.length).toBe(2);
    expect(mockUsageReleased).toBe(true);

    // Assert compensation deleted earlier files from storage
    const calls = fakeDriver.getCalls();
    const deleteKeys = calls
      .filter((c) => c.method === 'delete')
      .map((c) => c.key);
    expect(deleteKeys.length).toBeGreaterThanOrEqual(2);
  });

  it('returns per-file outcomes without aborting when atomic is false', async () => {
    const file1 = createMockIngestedFile({ originalName: 'doc1.jpg' });
    const file2 = createMockIngestedFile({ originalName: 'doc2.jpg' });

    let uploadCount = 0;
    const originalUpload = fakeDriver.upload.bind(fakeDriver);
    vi.spyOn(fakeDriver, 'upload').mockImplementation(async (input) => {
      uploadCount++;
      if (uploadCount === 2) {
        throw new Error('Temporary failure on file 2');
      }
      return originalUpload(input);
    });

    const outcomes = await uploadService.upload(
      mockContext,
      defaultPolicy,
      [file1, file2],
      {
        atomic: false,
      },
    );

    expect(outcomes).toHaveLength(2);
    expect(outcomes[0].success).toBe(true);
    expect(outcomes[1].success).toBe(false);
    if (!outcomes[1].success) {
      expect(outcomes[1].filename).toBe('doc2.jpg');
      expect(outcomes[1].error).toBeInstanceOf(StorageUnavailableError);
    }

    // File 1 was NOT deleted
    expect(deletedFiles).toHaveLength(0);
    expect(insertedFiles).toHaveLength(1);
  });

  it('enqueues file.uploaded outbox event when EVENTS_ENABLED is true', async () => {
    (configService as unknown as { eventsEnabled: boolean }).eventsEnabled =
      true;

    const file = createMockIngestedFile();
    const outcomes = await uploadService.upload(mockContext, defaultPolicy, [
      file,
    ]);

    expect(outcomes[0].success).toBe(true);
    expect(enqueuedOutboxEvents).toHaveLength(1);
    // OutboxWriter.enqueue is called with (trx, envelope) and we capture the envelope
    const envelope = enqueuedOutboxEvents[0] as Record<string, unknown>;
    expect(envelope['eventType']).toBe('file.uploaded');
    expect(typeof envelope['eventId']).toBe('string');
    expect(envelope['partitionKey']).toBe(
      (outcomes[0] as { fileId: string }).fileId,
    );
    const payload = envelope['payload'] as Record<string, unknown>;
    expect(payload['mimetype']).toBe('image/jpeg');
    expect(payload['primaryProvider']).toBe('local');
  });

  it('enqueues file.scan outbox event when policy.requireVirusScan is true (P5-07)', async () => {
    (configService as unknown as { eventsEnabled: boolean }).eventsEnabled =
      true;

    const scanPolicy = {
      ...defaultPolicy,
      requireVirusScan: true,
    };

    const file = createMockIngestedFile();
    const outcomes = await uploadService.upload(mockContext, scanPolicy, [
      file,
    ]);

    expect(outcomes[0].success).toBe(true);
    const scanEvent = enqueuedOutboxEvents.find(
      (e) => (e as Record<string, unknown>)['eventType'] === 'file.scan',
    ) as Record<string, unknown>;
    expect(scanEvent).toBeDefined();
    const scanPayload = scanEvent['payload'] as Record<string, unknown>;
    expect(scanPayload['fileId']).toBe(
      (outcomes[0] as { fileId: string }).fileId,
    );
  });

  it('uploadSingle returns the manifest directly', async () => {
    const file = createMockIngestedFile();
    const manifest = await uploadService.uploadSingle(
      mockContext,
      defaultPolicy,
      file,
    );

    expect(manifest.success).toBe(true);
    expect(manifest.data.filename).toBe('test.jpg');
  });
});
