import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import { Test, TestingModule } from '@nestjs/testing';
import { UploadService } from '../../src/files/upload.service.js';
import { StorageRegistry } from '../../src/storage/registry.js';
import { FakeStorageDriver } from '../helpers/storage-driver.mock.js';
import { ConfigModule } from '../../src/config/config.module.js';
import { AuthorizationModule } from '../../src/authz/authorization.module.js';
import { DatabaseModule } from '../../src/db/database.module.js';
import { StorageModule } from '../../src/storage/storage.module.js';
import { FilesModule } from '../../src/files/files.module.js';
import { DEFAULT_POLICIES } from '../../src/config/policies.js';
import type { RequestContext } from '../../src/core/request-context.js';
import type { IngestedFile } from '../../src/ingest/types.js';
import { DatabaseService } from '../../src/db/database.service.js';
import { FileRepository } from '../../src/db/repositories/file.repository.js';
import { ReplicaRepository } from '../../src/db/repositories/replica.repository.js';
import { UsageRepository } from '../../src/db/repositories/usage.repository.js';
import { OutboxRepository } from '../../src/db/repositories/outbox.repository.js';
import {
  QuotaExceededError,
  StorageUnavailableError,
} from '../../src/core/errors/app-error.js';
import { uploadManifestResponseSchema } from '../../src/core/manifest.js';

describe('UploadService Integration (NestJS Module & FakeStorageDriver)', () => {
  let moduleRef: TestingModule;
  let uploadService: UploadService;
  let registry: StorageRegistry;
  let fakeDriver: FakeStorageDriver;
  let dbService: DatabaseService;
  let fileRepo: FileRepository;
  let replicaRepo: ReplicaRepository;
  let usageRepo: UsageRepository;
  let hardDeleteSpy: ReturnType<typeof vi.spyOn>;
  let releaseSpy: ReturnType<typeof vi.spyOn>;

  const mockCtx: RequestContext = {
    namespace: 'esma-tenant',
    tenantId: 'school-integration',
    subTenantId: undefined,
    actor: {
      id: 'integration-actor-1',
      type: 'user',
      roles: ['superadmin'],
      scopes: [],
    },
    correlationId: '0198f3a2-7c1e-7b40-9d2a-5e6f1a8c9999',
    ipAddress: '127.0.0.1',
    attributes: {},
  };

  const policy = DEFAULT_POLICIES['esma-tenant'];

  function makeMockFile(name: string, size = 1024): IngestedFile {
    const buf = Buffer.alloc(size, 65); // 'A'
    return {
      fieldName: 'file',
      originalName: name,
      declaredMime: 'image/png',
      detectedMime: 'image/png',
      size: buf.length,
      sha256:
        '2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae',
      path: `/tmp/${name}`,
      openReadStream: () => Readable.from(buf),
      dispose: () => Promise.resolve(),
    };
  }

  beforeEach(async () => {
    fakeDriver = new FakeStorageDriver('local');

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule,
        DatabaseModule,
        StorageModule,
        AuthorizationModule,
        FilesModule,
      ],
    }).compile();

    uploadService = moduleRef.get(UploadService);
    registry = moduleRef.get(StorageRegistry);
    dbService = moduleRef.get(DatabaseService);
    fileRepo = moduleRef.get(FileRepository);
    replicaRepo = moduleRef.get(ReplicaRepository);
    usageRepo = moduleRef.get(UsageRepository);
    const outboxRepo = moduleRef.get(OutboxRepository);
    vi.spyOn(outboxRepo, 'enqueue').mockResolvedValue(
      {} as unknown as import('../../src/core/types.js').OutboxEvent,
    );

    // Register test fake driver
    registry.register(fakeDriver);

    // Mock DB transaction executor since Postgres container is not running locally
    vi.spyOn(dbService, 'getDb').mockReturnValue({
      transaction: () => ({
        execute: async <T>(cb: (trx: unknown) => Promise<T>): Promise<T> => {
          return cb({});
        },
      }),
    } as unknown as ReturnType<DatabaseService['getDb']>);

    // Mock repo calls for in-memory integration tracking
    vi.spyOn(usageRepo, 'tryReserve').mockResolvedValue(true);
    releaseSpy = vi.spyOn(usageRepo, 'release').mockResolvedValue(undefined);
    vi.spyOn(fileRepo, 'insert').mockImplementation((data) =>
      Promise.resolve({
        id: data.id ?? '0198f3a2-7c1e-7b40-9d2a-5e6f1a8c0001',
        namespace: data.namespace,
        tenantId: data.tenantId,
        subTenantId: data.subTenantId ?? null,
        folder: data.folder ?? '',
        storageKey: data.storageKey,
        originalFilename: data.originalFilename,
        mimetype: data.mimetype,
        declaredMimetype: data.declaredMimetype ?? null,
        sizeBytes: BigInt(data.sizeBytes),
        sha256: data.sha256 ?? null,
        visibility: data.visibility,
        status: 'ACTIVE',
        scanStatus: 'NOT_REQUIRED',
        replicationStatus: 'NOT_REQUIRED',
        primaryProvider: 'local',
        uploadedBy: data.uploadedBy,
        tags: data.tags ?? [],
        attributes: data.attributes ?? {},
        legacyPublicId: data.legacyPublicId ?? null,
        idempotencyKey: data.idempotencyKey ?? null,
        correlationId: data.correlationId,
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      }),
    );
    vi.spyOn(replicaRepo, 'insertMany').mockImplementation((replicas) =>
      Promise.resolve(
        replicas.map((r) => ({
          fileId: r.fileId,
          provider: r.provider,
          role: r.role,
          status: 'AVAILABLE',
          providerKey: r.providerKey,
          providerMeta: r.providerMeta ?? {},
          url: r.url ?? null,
          etag: r.etag ?? null,
          attempts: 0,
          lastError: null,
          syncedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
      ),
    );
    hardDeleteSpy = vi.spyOn(fileRepo, 'hardDelete').mockResolvedValue(true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (moduleRef) {
      await moduleRef.close();
    }
  });

  it('orchestrates happy path single file upload through full DI container', async () => {
    const file = makeMockFile('annual_report.png');
    const outcomes = await uploadService.upload(mockCtx, policy, [file]);

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].success).toBe(true);
    if (outcomes[0].success) {
      const manifest = outcomes[0].manifest;
      expect(manifest.success).toBe(true);
      expect(manifest.data.primaryProvider).toBe('local');
      expect(manifest.data.visibility).toBe('tenant');
      expect(manifest.data.replicas.local.status).toBe('AVAILABLE');

      const parsed = uploadManifestResponseSchema.safeParse(manifest);
      expect(parsed.success).toBe(true);
    }
  });

  it('failure injection: database failure triggers object compensation and releases quota', async () => {
    const file = makeMockFile('failed_tx.png');

    vi.spyOn(dbService, 'getDb').mockReturnValue({
      transaction: () => ({
        execute: (): Promise<never> =>
          Promise.reject(new Error('Connection pool exhausted')),
      }),
    } as unknown as ReturnType<DatabaseService['getDb']>);

    await expect(uploadService.upload(mockCtx, policy, [file])).rejects.toThrow(
      StorageUnavailableError,
    );

    // Assert compensation delete was executed
    const deleteCalls = fakeDriver
      .getCalls()
      .filter((c) => c.method === 'delete');
    expect(deleteCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('failure injection: quota exceeded triggers compensation and throws QuotaExceededError', async () => {
    const file = makeMockFile('over_quota.png');
    vi.spyOn(usageRepo, 'tryReserve').mockResolvedValue(false);

    await expect(uploadService.upload(mockCtx, policy, [file])).rejects.toThrow(
      QuotaExceededError,
    );

    const deleteCalls = fakeDriver
      .getCalls()
      .filter((c) => c.method === 'delete');
    expect(deleteCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('failure injection: atomic batch rollback compensates all completed files', async () => {
    const file1 = makeMockFile('f1.png');
    const file2 = makeMockFile('f2.png');
    const file3 = makeMockFile('f3.png');

    let count = 0;
    const origUpload = fakeDriver.upload.bind(fakeDriver);
    vi.spyOn(fakeDriver, 'upload').mockImplementation(async (input) => {
      count++;
      if (count === 3) {
        throw new Error('Driver failed on 3rd file');
      }
      return origUpload(input);
    });

    await expect(
      uploadService.upload(mockCtx, policy, [file1, file2, file3], {
        atomic: true,
      }),
    ).rejects.toThrow(StorageUnavailableError);

    // Verify both file 1 and file 2 were deleted from primary storage
    const deleteCalls = fakeDriver
      .getCalls()
      .filter((c) => c.method === 'delete');
    expect(deleteCalls.length).toBe(2);

    // Verify both files were hard deleted from DB
    expect(hardDeleteSpy).toHaveBeenCalledTimes(2);
    expect(releaseSpy).toHaveBeenCalledTimes(2);
  });
});
