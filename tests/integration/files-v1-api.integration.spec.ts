/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */
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
import { AuthModule } from '../../src/auth/auth.module.js';
import { IngestModule } from '../../src/ingest/ingest.module.js';
import { StorageRegistry } from '../../src/storage/registry.js';
import { FakeStorageDriver } from '../helpers/storage-driver.mock.js';
import { DatabaseService } from '../../src/db/database.service.js';
import { FileRepository } from '../../src/db/repositories/file.repository.js';
import { ReplicaRepository } from '../../src/db/repositories/replica.repository.js';
import { UsageRepository } from '../../src/db/repositories/usage.repository.js';
import { OutboxRepository } from '../../src/db/repositories/outbox.repository.js';
import { ApiKeyAuthenticatorService } from '../../src/auth/apikey/apikey-authenticator.service.js';
import { ProblemJsonErrorFilter } from '../../src/common/filters/problem-json-error.filter.js';
import { FileRecord, FileReplica, ApiClient } from '../../src/core/types.js';

describe('Generic v1 HTTP API Integration [P3-01]', () => {
  let app: INestApplication;
  let fakeDriver: FakeStorageDriver;

  // Mock API Clients
  const clientA: ApiClient = {
    id: 'client_tenant_a',
    name: 'Tenant A Client',
    keyPrefix: 'gus_ta',
    keyHash: 'hash_a',
    namespace: 'generic',
    tenantIds: ['tenant_A'],
    allowAnyTenant: false,
    scopes: ['files:read', 'files:write', 'files:delete'],
    status: 'ACTIVE',
    expiresAt: null,
    lastUsedAt: null,
    createdAt: new Date(),
    revokedAt: null,
  };

  const clientB: ApiClient = {
    id: 'client_tenant_b',
    name: 'Tenant B Client',
    keyPrefix: 'gus_tb',
    keyHash: 'hash_b',
    namespace: 'generic',
    tenantIds: ['tenant_B'],
    allowAnyTenant: false,
    scopes: ['files:read', 'files:write', 'files:delete'],
    status: 'ACTIVE',
    expiresAt: null,
    lastUsedAt: null,
    createdAt: new Date(),
    revokedAt: null,
  };

  const readOnlyClientA: ApiClient = {
    ...clientA,
    id: 'client_ro_a',
    scopes: ['files:read'],
  };

  // In-memory repositories
  const filesDb = new Map<string, FileRecord>();
  const replicasDb = new Map<string, FileReplica[]>();

  const fileA: FileRecord = {
    id: '0198f3a2-7c1e-7b40-9d2a-5e6f1a8c0001',
    namespace: 'generic',
    tenantId: 'tenant_A',
    subTenantId: 'branch_1',
    folder: 'reports',
    storageKey: 'generic/tenant_A/file_a.pdf',
    originalFilename: 'file_a.pdf',
    mimetype: 'application/pdf',
    declaredMimetype: 'application/pdf',
    sizeBytes: BigInt(1024),
    sha256: '9f83c605cad7aca0791fe19ec61f357907b525a6262d3997f9ac3fb7c1f66ac1',
    visibility: 'tenant',
    status: 'ACTIVE',
    scanStatus: 'CLEAN',
    replicationStatus: 'NOT_REQUIRED',
    primaryProvider: 'local',
    uploadedBy: 'client_tenant_a',
    tags: ['audit'],
    attributes: {},
    legacyPublicId: null,
    idempotencyKey: null,
    correlationId: 'corr-01',
    version: 1,
    createdAt: new Date('2026-09-20T10:00:00Z'),
    updatedAt: new Date('2026-09-20T10:00:00Z'),
    deletedAt: null,
  };

  const fileB: FileRecord = {
    id: '0198f3a2-7c1e-7b40-9d2a-5e6f1a8c0002',
    namespace: 'generic',
    tenantId: 'tenant_B',
    subTenantId: null,
    folder: 'confidential',
    storageKey: 'generic/tenant_B/file_b.pdf',
    originalFilename: 'file_b.pdf',
    mimetype: 'application/pdf',
    declaredMimetype: 'application/pdf',
    sizeBytes: BigInt(2048),
    sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    visibility: 'tenant',
    status: 'ACTIVE',
    scanStatus: 'CLEAN',
    replicationStatus: 'NOT_REQUIRED',
    primaryProvider: 'local',
    uploadedBy: 'client_tenant_b',
    tags: ['secret'],
    attributes: {},
    legacyPublicId: null,
    idempotencyKey: null,
    correlationId: 'corr-02',
    version: 1,
    createdAt: new Date('2026-09-21T10:00:00Z'),
    updatedAt: new Date('2026-09-21T10:00:00Z'),
    deletedAt: null,
  };

  beforeAll(async () => {
    fakeDriver = new FakeStorageDriver('local');

    // Register storage content
    await fakeDriver.upload({
      key: fileA.storageKey,
      source: () => Readable.from(Buffer.alloc(1024, 'A')),
      size: 1024,
      sha256: fileA.sha256!,
      mimetype: 'application/pdf',
      visibility: 'tenant',
    });
    await fakeDriver.upload({
      key: fileB.storageKey,
      source: () => Readable.from(Buffer.alloc(2048, 'B')),
      size: 2048,
      sha256: fileB.sha256!,
      mimetype: 'application/pdf',
      visibility: 'tenant',
    });

    const mockDb = {
      transaction: () => ({
        execute: async (callback: (trx: any) => Promise<any>) => callback({}),
      }),
    };

    const mockDatabaseService = {
      getDb: vi.fn().mockReturnValue(mockDb),
      getPool: vi.fn().mockReturnValue({}),
    };

    const mockFileRepo = {
      findById: vi.fn().mockImplementation((id: string) => {
        return Promise.resolve(filesDb.get(id) ?? null);
      }),
      create: vi.fn().mockImplementation((data: any) => {
        const id = data.id ?? '0198f3a2-7c1e-7b40-9d2a-5e6f1a8c9999';
        const rec: FileRecord = {
          ...data,
          id,
          sizeBytes: BigInt(data.sizeBytes),
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
          version: 1,
        };
        filesDb.set(id, rec);
        return Promise.resolve(rec);
      }),
      list: vi.fn().mockImplementation((filter: any, limit: number) => {
        const list = Array.from(filesDb.values()).filter((f) => {
          if (f.tenantId !== filter.tenantId) return false;
          if (f.status === 'DELETED') return false;
          if (filter.folder && f.folder !== filter.folder) return false;
          if (filter.subTenantId && f.subTenantId !== filter.subTenantId)
            return false;
          if (filter.mimetype && f.mimetype !== filter.mimetype) return false;
          return true;
        });
        const items = list.slice(0, limit);
        return Promise.resolve({
          items,
          nextCursor: null,
        });
      }),
      markDeleting: vi.fn().mockImplementation((id: string) => {
        const rec = filesDb.get(id);
        if (rec) rec.status = 'DELETING';
        return Promise.resolve();
      }),
      markDeleted: vi.fn().mockImplementation((id: string) => {
        const rec = filesDb.get(id);
        if (rec) rec.status = 'DELETED';
        return Promise.resolve();
      }),
      insert: vi.fn().mockImplementation((data: any) => {
        const id = data.id ?? '0198f3a2-7c1e-7b40-9d2a-5e6f1a8c9999';
        const rec: FileRecord = {
          ...data,
          id,
          sizeBytes: BigInt(data.sizeBytes),
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
          version: 1,
        };
        filesDb.set(id, rec);
        return Promise.resolve(rec);
      }),
      updateStatus: vi.fn().mockImplementation((id: string, update: any) => {
        const rec = filesDb.get(id);
        if (rec) {
          rec.status = update.status;
          if (update.sizeBytes !== undefined) {
            rec.sizeBytes = BigInt(update.sizeBytes);
          }
        }
        return Promise.resolve();
      }),
    };

    const mockReplicaRepo = {
      listByFile: vi.fn().mockImplementation((fileId: string) => {
        return Promise.resolve(replicasDb.get(fileId) ?? []);
      }),
      listByFileId: vi.fn().mockImplementation((fileId: string) => {
        return Promise.resolve(replicasDb.get(fileId) ?? []);
      }),
      create: vi.fn().mockImplementation((data: any) => {
        const rep: FileReplica = {
          ...data,
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
          version: 1,
        };
        const cur = replicasDb.get(data.fileId) ?? [];
        cur.push(rep);
        replicasDb.set(data.fileId, cur);
        return Promise.resolve(rep);
      }),
      insertMany: vi.fn().mockImplementation((reps: any[]) => {
        return Promise.resolve(
          reps.map((data) => {
            const rep: FileReplica = {
              ...data,
              createdAt: new Date(),
              updatedAt: new Date(),
              deletedAt: null,
              version: 1,
            };
            const cur = replicasDb.get(data.fileId) ?? [];
            cur.push(rep);
            replicasDb.set(data.fileId, cur);
            return rep;
          }),
        );
      }),
      markDeleting: vi.fn().mockResolvedValue(undefined),
      markDeleted: vi.fn().mockResolvedValue(undefined),
      updateStatus: vi.fn().mockResolvedValue(undefined),
    };

    const mockUsageRepo = {
      tryReserve: vi.fn().mockResolvedValue(true),
      reserveQuota: vi.fn().mockResolvedValue(undefined),
      releaseQuota: vi.fn().mockResolvedValue(undefined),
      commitQuota: vi.fn().mockResolvedValue(undefined),
      increment: vi.fn().mockResolvedValue(undefined),
      decrement: vi.fn().mockResolvedValue(undefined),
      release: vi.fn().mockResolvedValue(undefined),
    };

    const mockOutboxRepo = {
      enqueue: vi.fn().mockResolvedValue(undefined),
    };

    const mockApiKeyAuth = {
      authenticate: vi.fn().mockImplementation((key: string) => {
        if (key === 'key-client-a') return Promise.resolve(clientA);
        if (key === 'key-client-b') return Promise.resolve(clientB);
        if (key === 'key-ro-a') return Promise.resolve(readOnlyClientA);
        throw new Error('Invalid API key');
      }),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule,
        DatabaseModule,
        StorageModule,
        AuthModule,
        AuthorizationModule,
        IngestModule,
        FilesModule,
      ],
    })
      .overrideProvider(DatabaseService)
      .useValue(mockDatabaseService)
      .overrideProvider(FileRepository)
      .useValue(mockFileRepo)
      .overrideProvider(ReplicaRepository)
      .useValue(mockReplicaRepo)
      .overrideProvider(UsageRepository)
      .useValue(mockUsageRepo)
      .overrideProvider(OutboxRepository)
      .useValue(mockOutboxRepo)
      .overrideProvider(ApiKeyAuthenticatorService)
      .useValue(mockApiKeyAuth)
      .compile();

    const registry = moduleRef.get(StorageRegistry);
    registry.register(fakeDriver);

    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new ProblemJsonErrorFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    filesDb.clear();
    replicasDb.clear();

    filesDb.set(fileA.id, { ...fileA });
    filesDb.set(fileB.id, { ...fileB });

    replicasDb.set(fileA.id, [
      {
        fileId: fileA.id,
        provider: 'local',
        providerKey: fileA.storageKey,
        providerMeta: {},
        role: 'primary',
        status: 'AVAILABLE',
        url: null,
        etag: fileA.sha256,
        attempts: 0,
        lastError: null,
        syncedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    replicasDb.set(fileB.id, [
      {
        fileId: fileB.id,
        provider: 'local',
        providerKey: fileB.storageKey,
        providerMeta: {},
        role: 'primary',
        status: 'AVAILABLE',
        url: null,
        etag: fileB.sha256,
        attempts: 0,
        lastError: null,
        syncedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
  });

  // ==========================================================================
  // 1. Authentication & Authorization Gates
  // ==========================================================================

  describe('1. Authentication & Authorization Gates', () => {
    it('returns 401 Unauthenticated when missing auth headers on protected route', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/files');
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('UNAUTHENTICATED');
      expect(res.headers['content-type']).toContain('application/problem+json');
    });

    it('returns 403 Forbidden when client lacks required scope attempting upload', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/files/upload')
        .set('x-api-key', 'key-ro-a')
        .set('x-tenant-id', 'tenant_A');

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('GENERIC_SCOPE_MISSING');
    });

    it('returns 403 Forbidden when client lacks required scope attempting delete', async () => {
      const res = await request(app.getHttpServer())
        .delete(`/api/v1/files/${fileA.id}`)
        .set('x-api-key', 'key-ro-a')
        .set('x-tenant-id', 'tenant_A');

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('GENERIC_SCOPE_MISSING');
    });
  });

  // ==========================================================================
  // 2. Strict Tenant Isolation Suite
  // ==========================================================================

  describe('2. Strict Tenant Isolation Suite', () => {
    it('prevents client from using x-tenant-id outside its binding', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/files')
        .set('x-api-key', 'key-client-a')
        .set('x-tenant-id', 'tenant_B'); // Bound to tenant_A, attempting tenant_B

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('TENANT_MISMATCH');
    });

    it('listing files only returns the caller’s tenant files', async () => {
      const resA = await request(app.getHttpServer())
        .get('/api/v1/files')
        .set('x-api-key', 'key-client-a')
        .set('x-tenant-id', 'tenant_A');

      expect(resA.status).toBe(200);
      expect(resA.body.files).toBeDefined();
      expect(resA.body.files).toHaveLength(1);
      expect(resA.body.files[0].fileId).toBe(fileA.id);

      const resB = await request(app.getHttpServer())
        .get('/api/v1/files')
        .set('x-api-key', 'key-client-b')
        .set('x-tenant-id', 'tenant_B');

      expect(resB.status).toBe(200);
      expect(resB.body.files).toBeDefined();
      expect(resB.body.files).toHaveLength(1);
      expect(resB.body.files[0].fileId).toBe(fileB.id);
    });

    it('reading file of another tenant returns 404 (never 403, preventing enumeration)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/files/${fileB.id}`)
        .set('x-api-key', 'key-client-a')
        .set('x-tenant-id', 'tenant_A');

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('FILE_NOT_FOUND');
    });

    it('getting metadata of another tenant returns 404', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/files/${fileB.id}/metadata`)
        .set('x-api-key', 'key-client-a')
        .set('x-tenant-id', 'tenant_A');

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('FILE_NOT_FOUND');
    });

    it('generating signed URL for another tenant returns 404', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/files/${fileB.id}/signed-url`)
        .set('x-api-key', 'key-client-a')
        .set('x-tenant-id', 'tenant_A')
        .send({ expiresInSeconds: 600 });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('FILE_NOT_FOUND');
    });

    it('deleting file of another tenant returns 404', async () => {
      const res = await request(app.getHttpServer())
        .delete(`/api/v1/files/${fileB.id}`)
        .set('x-api-key', 'key-client-a')
        .set('x-tenant-id', 'tenant_A');

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('FILE_NOT_FOUND');
    });
  });

  // ==========================================================================
  // 3. Happy Path & Core Operations
  // ==========================================================================

  describe('3. Core Route Operations & Manifest Validation', () => {
    it('GET /api/v1/files/:fileId streams file content with valid response headers', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/files/${fileA.id}`)
        .set('x-api-key', 'key-client-a')
        .set('x-tenant-id', 'tenant_A');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['etag']).toBe(`"${fileA.sha256}"`);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-security-policy']).toBe('sandbox');
    });

    it('GET /api/v1/files/:fileId with Range header returns 206 Partial Content', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/files/${fileA.id}`)
        .set('x-api-key', 'key-client-a')
        .set('x-tenant-id', 'tenant_A')
        .set('range', 'bytes=0-9');

      expect(res.status).toBe(206);
      expect(res.headers['content-range']).toBe('bytes 0-9/1024');
      expect(res.headers['content-length']).toBe('10');
    });

    it('GET /api/v1/files/:fileId with matching If-None-Match returns 304', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/files/${fileA.id}`)
        .set('x-api-key', 'key-client-a')
        .set('x-tenant-id', 'tenant_A')
        .set('if-none-match', `"${fileA.sha256}"`);

      expect(res.status).toBe(304);
    });

    it('GET /api/v1/files/:fileId/metadata returns standard manifest without bytes', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/files/${fileA.id}/metadata`)
        .set('x-api-key', 'key-client-a')
        .set('x-tenant-id', 'tenant_A');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.fileId).toBe(fileA.id);
      expect(res.body.data.filename).toBe('file_a.pdf');
      expect(res.body.data.mimetype).toBe('application/pdf');
      expect(res.body.data.primaryProvider).toBe('local');
    });

    it('POST /api/v1/files/:fileId/signed-url creates time-limited signed URL', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/files/${fileA.id}/signed-url`)
        .set('x-api-key', 'key-client-a')
        .set('x-tenant-id', 'tenant_A')
        .send({ expiresInSeconds: 1800, disposition: 'attachment' });

      expect(res.status).toBe(200);
      expect(res.body.fileId).toBe(fileA.id);
      expect(res.body.url).toContain('/api/v1/files/');
      expect(res.body.url).toContain('sig=');
      expect(res.body.url).toContain('exp=');
      expect(res.body.disposition).toBe('attachment');

      // Access file via signed URL without any auth credentials
      const signedUrl = new URL(res.body.url);
      const accessRes = await request(app.getHttpServer()).get(
        `${signedUrl.pathname}${signedUrl.search}`,
      );

      expect(accessRes.status).toBe(200);
      expect(accessRes.headers['content-type']).toBe('application/pdf');
    });

    it('DELETE /api/v1/files/:fileId purges the file and returns 204', async () => {
      const res = await request(app.getHttpServer())
        .delete(`/api/v1/files/${fileA.id}`)
        .set('x-api-key', 'key-client-a')
        .set('x-tenant-id', 'tenant_A');

      expect(res.status).toBe(204);
      expect(filesDb.get(fileA.id)?.status).toBe('DELETED');
    });

    it('POST /api/v1/files/bulk-delete purges batch and returns 200 with results', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/files/bulk-delete')
        .set('x-api-key', 'key-client-a')
        .set('x-tenant-id', 'tenant_A')
        .send({ fileIds: [fileA.id] });

      expect(res.status).toBe(200);
      expect(res.body.requested).toBe(1);
      expect(res.body.deletedCount).toBe(1);
      expect(res.body.results).toHaveLength(1);
      expect(res.body.results[0].success).toBe(true);
    });

    it('POST /api/v1/files/upload with multipart file succeeds with 201 Created', async () => {
      // Small 1x1 PNG buffer
      const pngBuffer = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64',
      );

      const res = await request(app.getHttpServer())
        .post('/api/v1/files/upload')
        .set('x-api-key', 'key-client-a')
        .set('x-tenant-id', 'tenant_A')
        .field('folder', 'invoices')
        .field('visibility', 'tenant')
        .field('tags', 'q1,2026')
        .attach('file', pngBuffer, 'test-image.png');

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.filename).toBe('test-image.png');
      expect(res.body.data.visibility).toBe('tenant');
    });

    it('POST /api/v1/files/upload with multiple files succeeds with 201 Created and array of manifests', async () => {
      const pngBuffer = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64',
      );

      const res = await request(app.getHttpServer())
        .post('/api/v1/files/upload')
        .set('x-api-key', 'key-client-a')
        .set('x-tenant-id', 'tenant_A')
        .field('folder', 'multi')
        .attach('file', pngBuffer, 'image1.png')
        .attach('file', pngBuffer, 'image2.png');

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data).toHaveLength(2);
    });
  });
});
