import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from 'vitest';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { Readable } from 'node:stream';
import { FilesModule } from '../../src/files/files.module.js';
import { ConfigModule } from '../../src/config/config.module.js';
import { AuthorizationModule } from '../../src/authz/authorization.module.js';
import { DatabaseModule } from '../../src/db/database.module.js';
import { StorageModule } from '../../src/storage/storage.module.js';
import { StorageRegistry } from '../../src/storage/registry.js';
import { FakeStorageDriver } from '../helpers/storage-driver.mock.js';
import { FileRepository } from '../../src/db/repositories/file.repository.js';
import { ReplicaRepository } from '../../src/db/repositories/replica.repository.js';
import { UsageRepository } from '../../src/db/repositories/usage.repository.js';
import { DatabaseService } from '../../src/db/database.service.js';
import { ProblemJsonErrorFilter } from '../../src/common/filters/problem-json-error.filter.js';
import { FileRecord, FileReplica } from '../../src/core/types.js';

describe('DeleteService & FileQuery Integration [P2-08]', () => {
  let app: INestApplication;
  let fakeDriver: FakeStorageDriver;

  const sampleBytes = Buffer.from('Integration test delete and query payload');

  const file1: FileRecord = {
    id: '0198f3a2-7c1e-7b40-9d2a-5e6f1a8c0001',
    namespace: 'esma-tenant',
    tenantId: 'default',
    subTenantId: null,
    folder: 'docs',
    storageKey: 'uploads/schools/default/file1.pdf',
    originalFilename: 'file1.pdf',
    mimetype: 'application/pdf',
    declaredMimetype: 'application/pdf',
    sizeBytes: BigInt(sampleBytes.length),
    sha256: 'sha-delete-1',
    visibility: 'tenant',
    status: 'ACTIVE',
    scanStatus: 'CLEAN',
    replicationStatus: 'NOT_REQUIRED',
    primaryProvider: 'local',
    uploadedBy: 'admin-user',
    tags: ['important'],
    attributes: {},
    legacyPublicId: null,
    idempotencyKey: null,
    correlationId: 'corr-int-1',
    version: 1,
    createdAt: new Date('2026-09-28T09:00:00Z'),
    updatedAt: new Date('2026-09-28T09:00:00Z'),
    deletedAt: null,
  };

  const file2: FileRecord = {
    ...file1,
    id: '0198f3a2-7c1e-7b40-9d2a-5e6f1a8c0002',
    storageKey: 'uploads/schools/default/file2.pdf',
    originalFilename: 'file2.pdf',
    createdAt: new Date('2026-09-28T10:00:00Z'),
    updatedAt: new Date('2026-09-28T10:00:00Z'),
  };

  const filesDb = new Map<string, FileRecord>();
  const replicasDb = new Map<string, FileReplica[]>();
  let usageReleasedCount = 0;

  beforeAll(async () => {
    fakeDriver = new FakeStorageDriver('local');

    const mockStorageRegistry = {
      get: vi.fn().mockImplementation((name: string) => {
        if (name === 'local' || name === 'seaweedfs' || name === 'cloudinary') {
          return fakeDriver;
        }
        throw new Error(`Unknown provider ${name}`);
      }),
      has: vi.fn().mockReturnValue(true),
    };

    const mockFileRepo = {
      findById: vi.fn().mockImplementation((id: string) => {
        return Promise.resolve(filesDb.get(id) ?? null);
      }),
      list: vi
        .fn()
        .mockImplementation(
          (filter: { status?: string }, _cursor?: string, limit?: number) => {
            const all = Array.from(filesDb.values()).filter((f) => {
              if (filter.status) {
                return f.status === filter.status;
              }
              return f.status !== 'DELETED' && f.status !== 'DELETING';
            });
            const safeLimit = typeof limit === 'number' ? limit : 20;
            return Promise.resolve({
              items: all.slice(0, safeLimit),
              nextCursor: null,
              hasMore: false,
            });
          },
        ),
      markDeleting: vi.fn().mockImplementation((id: string) => {
        const file = filesDb.get(id);
        if (file && file.status !== 'DELETED') {
          file.status = 'DELETING';
        }
        return Promise.resolve(true);
      }),
      markDeleted: vi.fn().mockImplementation((id: string) => {
        const file = filesDb.get(id);
        if (file) {
          file.status = 'DELETED';
          file.deletedAt = new Date();
        }
        return Promise.resolve(true);
      }),
    };

    const mockReplicaRepo = {
      listByFile: vi.fn().mockImplementation((fileId: string) => {
        return Promise.resolve(replicasDb.get(fileId) ?? []);
      }),
      markDeleting: vi
        .fn()
        .mockImplementation((fileId: string, provider: string) => {
          const list = replicasDb.get(fileId) ?? [];
          for (const r of list) {
            if (r.provider === provider && r.status !== 'DELETED') {
              r.status = 'DELETING';
            }
          }
          return Promise.resolve();
        }),
      markDeleted: vi
        .fn()
        .mockImplementation((fileId: string, provider: string) => {
          const list = replicasDb.get(fileId) ?? [];
          for (const r of list) {
            if (r.provider === provider) {
              r.status = 'DELETED';
            }
          }
          return Promise.resolve();
        }),
    };

    const mockUsageRepo = {
      release: vi.fn().mockImplementation(() => {
        usageReleasedCount++;
        return Promise.resolve();
      }),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule,
        DatabaseModule,
        StorageModule,
        AuthorizationModule,
        FilesModule,
      ],
    })
      .overrideProvider(StorageRegistry)
      .useValue(mockStorageRegistry)
      .overrideProvider(FileRepository)
      .useValue(mockFileRepo)
      .overrideProvider(ReplicaRepository)
      .useValue(mockReplicaRepo)
      .overrideProvider(UsageRepository)
      .useValue(mockUsageRepo)
      .compile();

    const dbService = moduleRef.get(DatabaseService);
    vi.spyOn(dbService, 'getDb').mockReturnValue({
      transaction: () => ({
        execute: async <T>(fn: (trx: unknown) => Promise<T>): Promise<T> => {
          return fn({});
        },
      }),
    } as unknown as ReturnType<DatabaseService['getDb']>);

    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new ProblemJsonErrorFilter());
    await app.init();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  beforeEach(async () => {
    filesDb.clear();
    replicasDb.clear();
    usageReleasedCount = 0;

    // Reset and seed file 1
    const f1Copy = { ...file1, status: 'ACTIVE' as const };
    filesDb.set(file1.id, f1Copy);
    replicasDb.set(file1.id, [
      {
        fileId: file1.id,
        provider: 'local',
        role: 'primary',
        status: 'AVAILABLE',
        providerKey: file1.storageKey,
        providerMeta: {},
        url: null,
        etag: 'etag-1',
        attempts: 0,
        lastError: null,
        syncedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    await fakeDriver.upload({
      key: file1.storageKey,
      source: () => Readable.from(sampleBytes),
      size: sampleBytes.length,
      sha256: file1.sha256!,
      mimetype: file1.mimetype,
      visibility: 'tenant',
    });

    // Reset and seed file 2
    const f2Copy = { ...file2, status: 'ACTIVE' as const };
    filesDb.set(file2.id, f2Copy);
    replicasDb.set(file2.id, [
      {
        fileId: file2.id,
        provider: 'local',
        role: 'primary',
        status: 'AVAILABLE',
        providerKey: file2.storageKey,
        providerMeta: {},
        url: null,
        etag: 'etag-2',
        attempts: 0,
        lastError: null,
        syncedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    await fakeDriver.upload({
      key: file2.storageKey,
      source: () => Readable.from(sampleBytes),
      size: sampleBytes.length,
      sha256: file2.sha256!,
      mimetype: file2.mimetype,
      visibility: 'tenant',
    });
  });

  it('DELETE /api/v1/files/:fileId purges file and replicas with 204 [P2-08]', async () => {
    const server = app.getHttpServer() as unknown as Parameters<
      typeof request
    >[0];

    // 1. Delete file 1
    await request(server).delete(`/api/v1/files/${file1.id}`).expect(204);

    expect(filesDb.get(file1.id)?.status).toBe('DELETED');
    expect(replicasDb.get(file1.id)?.[0].status).toBe('DELETED');
    expect(usageReleasedCount).toBe(1);

    // 2. Immediately unreadable on GET content -> 404
    await request(server).get(`/api/v1/files/${file1.id}`).expect(404);

    // 3. Immediately unreadable on GET metadata -> 404
    await request(server).get(`/api/v1/files/${file1.id}/metadata`).expect(404);

    // 4. Repeated delete is idempotent and returns 204
    await request(server).delete(`/api/v1/files/${file1.id}`).expect(204);

    expect(usageReleasedCount).toBe(1); // Not decremented a second time
  });

  it('POST /api/v1/files/bulk-delete purges multiple files [P2-08]', async () => {
    const server = app.getHttpServer() as unknown as Parameters<
      typeof request
    >[0];

    const res = await request(server)
      .post('/api/v1/files/bulk-delete')
      .send({
        fileIds: [file1.id, file2.id, '0198f3a2-0000-0000-0000-nonexistent'],
      })
      .expect(200);

    const body = res.body as {
      total: number;
      deletedCount: number;
      failedCount: number;
      results: Array<{
        fileId: string;
        success: boolean;
        error?: string;
        code?: string;
      }>;
    };

    expect(body).toEqual({
      total: 3,
      deletedCount: 2,
      failedCount: 1,
      results: [
        { fileId: file1.id, success: true },
        { fileId: file2.id, success: true },
        {
          fileId: '0198f3a2-0000-0000-0000-nonexistent',
          success: false,
          error: "File '0198f3a2-0000-0000-0000-nonexistent' not found",
          code: 'FILE_NOT_FOUND',
        },
      ],
    });

    expect(filesDb.get(file1.id)?.status).toBe('DELETED');
    expect(filesDb.get(file2.id)?.status).toBe('DELETED');
  });

  it('GET /api/v1/files excludes DELETED and DELETING files [P2-08]', async () => {
    const server = app.getHttpServer() as unknown as Parameters<
      typeof request
    >[0];

    // Initially both files are listed
    const res1 = await request(server).get('/api/v1/files').expect(200);
    const body1 = res1.body as { items: Array<{ fileId: string }> };

    expect(body1.items).toHaveLength(2);

    // Delete file1
    await request(server).delete(`/api/v1/files/${file1.id}`).expect(204);

    // Now only file2 is returned
    const res2 = await request(server).get('/api/v1/files').expect(200);
    const body2 = res2.body as { items: Array<{ fileId: string }> };

    expect(body2.items).toHaveLength(1);
    expect(body2.items[0].fileId).toBe(file2.id);
  });

  it('GET /api/v1/files/:fileId/metadata returns manifest for active file [P2-08]', async () => {
    const server = app.getHttpServer() as unknown as Parameters<
      typeof request
    >[0];

    const res = await request(server)
      .get(`/api/v1/files/${file2.id}/metadata`)
      .expect(200);

    const body = res.body as {
      success: boolean;
      data: {
        fileId: string;
        filename: string;
        replicas: Record<string, { status: string }>;
      };
    };

    expect(body.success).toBe(true);
    expect(body.data.fileId).toBe(file2.id);
    expect(body.data.filename).toBe('file2.pdf');
    expect(body.data.replicas.local.status).toBe('AVAILABLE');
  });
});
