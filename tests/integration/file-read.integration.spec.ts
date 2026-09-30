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
import { Readable, PassThrough } from 'node:stream';
import type { Request, Response, NextFunction } from 'express';
import { FilesModule } from '../../src/files/files.module.js';
import { ConfigModule } from '../../src/config/config.module.js';
import { AuthorizationModule } from '../../src/authz/authorization.module.js';
import { DatabaseModule } from '../../src/db/database.module.js';
import { StorageModule } from '../../src/storage/storage.module.js';
import { StorageRegistry } from '../../src/storage/registry.js';
import { FakeStorageDriver } from '../helpers/storage-driver.mock.js';
import { FileRepository } from '../../src/db/repositories/file.repository.js';
import { ReplicaRepository } from '../../src/db/repositories/replica.repository.js';
import { ProblemJsonErrorFilter } from '../../src/common/filters/problem-json-error.filter.js';
import type { AuthenticatedHttpRequest } from '../../src/auth/context.js';
import { FileRecord, FileReplica } from '../../src/core/types.js';

describe('FileRead & Content Delivery Integration [P2-07]', () => {
  let app: INestApplication;
  let fakeDriver: FakeStorageDriver;

  const sampleContent = Buffer.from('abcdefghijklmnopqrstuvwxyz0123456789'); // 36 bytes

  const testFile: FileRecord = {
    id: '0198f3a2-7c1e-7b40-9d2a-5e6f1a8c1111',
    namespace: 'esma-tenant',
    tenantId: 'school-int-1',
    subTenantId: 'branch-1',
    folder: 'int-docs',
    storageKey: 'uploads/schools/school-int-1/sample.pdf',
    originalFilename: 'sample.pdf',
    mimetype: 'application/pdf',
    declaredMimetype: 'application/pdf',
    sizeBytes: BigInt(sampleContent.length),
    sha256: '9f83c605cad7aca0791fe19ec61f357907b525a6262d3997f9ac3fb7c1f66ac1',
    visibility: 'public',
    status: 'ACTIVE',
    scanStatus: 'CLEAN',
    replicationStatus: 'NOT_REQUIRED',
    primaryProvider: 'local',
    uploadedBy: 'user-1',
    tags: [],
    attributes: {},
    legacyPublicId: null,
    idempotencyKey: null,
    correlationId: '0198f3a2-7c1e-7b40-9d2a-5e6f1a8c0000',
    version: 1,
    createdAt: new Date('2026-09-20T10:00:00Z'),
    updatedAt: new Date('2026-09-20T10:00:00Z'),
    deletedAt: null,
  };

  const privateFile: FileRecord = {
    ...testFile,
    id: '0198f3a2-7c1e-7b40-9d2a-5e6f1a8c2222',
    visibility: 'private',
    storageKey: 'uploads/schools/school-int-1/private.pdf',
    originalFilename: 'private.pdf',
  };

  const filesDb = new Map<string, FileRecord>();
  const replicasDb = new Map<string, FileReplica[]>();

  beforeAll(async () => {
    fakeDriver = new FakeStorageDriver('local');

    // Populate fake storage
    await fakeDriver.upload({
      key: testFile.storageKey,
      source: () => Readable.from(sampleContent),
      size: sampleContent.length,
      sha256: testFile.sha256!,
      mimetype: testFile.mimetype,
      visibility: 'public',
    });

    await fakeDriver.upload({
      key: privateFile.storageKey,
      source: () => Readable.from(sampleContent),
      size: sampleContent.length,
      sha256: privateFile.sha256!,
      mimetype: privateFile.mimetype,
      visibility: 'private',
    });

    filesDb.set(testFile.id, testFile);
    filesDb.set(privateFile.id, privateFile);

    const mockStorageRegistry = {
      has: vi.fn().mockImplementation((name: string) => {
        return (
          name === 'local' || name === 'cloudinary' || name === 'seaweedfs'
        );
      }),
      isHealthy: vi.fn().mockReturnValue(true),
      get: vi.fn().mockImplementation((name: string) => {
        if (name === 'local' || name === 'cloudinary' || name === 'seaweedfs') {
          return fakeDriver;
        }
        throw new Error(`Driver not found: ${name}`);
      }),
    };

    const mockFileRepo = {
      findById: vi
        .fn()
        .mockImplementation((id: string) =>
          Promise.resolve(filesDb.get(id) ?? null),
        ),
    };

    const mockReplicaRepo = {
      listByFile: vi
        .fn()
        .mockImplementation((id: string) =>
          Promise.resolve(replicasDb.get(id) ?? []),
        ),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule,
        AuthorizationModule,
        DatabaseModule,
        StorageModule,
        FilesModule,
      ],
    })
      .overrideProvider(StorageRegistry)
      .useValue(mockStorageRegistry)
      .overrideProvider(FileRepository)
      .useValue(mockFileRepo)
      .overrideProvider(ReplicaRepository)
      .useValue(mockReplicaRepo)
      .compile();

    app = moduleFixture.createNestApplication();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      if (!req.url.includes('sig=')) {
        const tenantHeader = req.headers['x-tenant-id'];
        const tenantId =
          typeof tenantHeader === 'string' ? tenantHeader : 'school-int-1';
        const isAdmin = req.headers['x-esma-admin'] === 'true';

        (req as AuthenticatedHttpRequest).ctx = {
          namespace: isAdmin ? 'esma-admin' : 'esma-tenant',
          tenantId: isAdmin ? 'system' : tenantId,
          actor: {
            id: isAdmin ? 'admin-1' : 'user-1',
            type: 'user',
            roles: isAdmin ? ['superadmin'] : ['schooladmin', 'user'],
            scopes: isAdmin
              ? ['files:admin', '*']
              : ['files:read', 'files:write', 'files:delete'],
            isSchoolAdmin: !isAdmin,
            isPlatformAdmin: isAdmin,
          },
          correlationId: 'corr-int-read',
          ipAddress: '127.0.0.1',
          attributes: {},
        };
      }
      next();
    });
    app.useGlobalFilters(new ProblemJsonErrorFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    fakeDriver.clear();
    // re-add sample file
    await fakeDriver.upload({
      key: testFile.storageKey,
      source: () => Readable.from(sampleContent),
      size: sampleContent.length,
      sha256: testFile.sha256!,
      mimetype: testFile.mimetype,
      visibility: 'public',
    });
    await fakeDriver.upload({
      key: privateFile.storageKey,
      source: () => Readable.from(sampleContent),
      size: sampleContent.length,
      sha256: privateFile.sha256!,
      mimetype: privateFile.mimetype,
      visibility: 'private',
    });
  });

  describe('GET /api/v1/files/:fileId (Content Streaming)', () => {
    it('downloads full file with expected content and hardened response headers', async () => {
      const server = app.getHttpServer() as unknown as Parameters<
        typeof request
      >[0];

      const res = await request(server)
        .get(`/api/v1/files/${testFile.id}`)
        .expect(200);

      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-security-policy']).toBe('sandbox');
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['cache-control']).toBe('public, max-age=86400');
      expect(res.headers['content-disposition']).toContain('inline');
      expect(res.headers['etag']).toBe(`"${testFile.sha256}"`);
      expect(res.headers['content-length']).toBe(String(sampleContent.length));

      expect(Buffer.from(res.body).toString()).toBe(sampleContent.toString());
    });

    it('answers range request with 206 and exact byte slice', async () => {
      const server = app.getHttpServer() as unknown as Parameters<
        typeof request
      >[0];

      const res = await request(server)
        .get(`/api/v1/files/${testFile.id}`)
        .set('Range', 'bytes=0-9')
        .expect(206);

      expect(res.headers['content-range']).toBe(
        `bytes 0-9/${sampleContent.length}`,
      );
      expect(res.headers['content-length']).toBe('10');
      expect(Buffer.from(res.body).toString()).toBe('abcdefghij');
    });

    it('answers suffix range bytes=-6 with last 6 bytes', async () => {
      const server = app.getHttpServer() as unknown as Parameters<
        typeof request
      >[0];

      const res = await request(server)
        .get(`/api/v1/files/${testFile.id}`)
        .set('Range', 'bytes=-6')
        .expect(206);

      expect(res.headers['content-range']).toBe(
        `bytes 30-35/${sampleContent.length}`,
      );
      expect(res.headers['content-length']).toBe('6');
      expect(Buffer.from(res.body).toString()).toBe('456789');
    });

    it('returns 416 for invalid range', async () => {
      const server = app.getHttpServer() as unknown as Parameters<
        typeof request
      >[0];

      const res = await request(server)
        .get(`/api/v1/files/${testFile.id}`)
        .set('Range', 'bytes=500-100')
        .expect(416);

      expect(res.headers['content-range']).toBe(
        `bytes */${sampleContent.length}`,
      );
    });

    it('returns 304 Not Modified when If-None-Match matches ETag', async () => {
      const server = app.getHttpServer() as unknown as Parameters<
        typeof request
      >[0];

      await request(server)
        .get(`/api/v1/files/${testFile.id}`)
        .set('If-None-Match', `"${testFile.sha256}"`)
        .expect(304);
    });

    it('HEAD request returns headers with empty body', async () => {
      const server = app.getHttpServer() as unknown as Parameters<
        typeof request
      >[0];

      const res = await request(server)
        .head(`/api/v1/files/${testFile.id}`)
        .expect(200);

      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-length']).toBe(String(sampleContent.length));
      expect(res.text).toBeUndefined();
    });
  });

  describe('Signed URL Flow for Private Files', () => {
    it('generates a signed URL and accesses private file unauthenticated', async () => {
      const server = app.getHttpServer() as unknown as Parameters<
        typeof request
      >[0];

      // 1. Generate signed URL
      const postRes = await request(server)
        .post(`/api/v1/files/${privateFile.id}/signed-url`)
        .send({ disposition: 'attachment', expiresInSeconds: 600 })
        .expect(200);

      const postBody = postRes.body as {
        url: string;
        fileId: string;
        disposition: string;
      };
      expect(postBody.url).toBeDefined();
      expect(postBody.fileId).toBe(privateFile.id);
      expect(postBody.disposition).toBe('attachment');

      const signedUrl = new URL(postBody.url);
      const exp = signedUrl.searchParams.get('exp')!;
      const disp = signedUrl.searchParams.get('disp')!;
      const sig = signedUrl.searchParams.get('sig')!;

      // 2. Fetch using signed URL without Authorization header
      const getRes = await request(server)
        .get(`/api/v1/files/${privateFile.id}`)
        .query({ exp, disp, sig })
        .expect(200);

      expect(getRes.headers['content-disposition']).toContain('attachment');
      expect(getRes.headers['cache-control']).toBe('private, no-store');
      expect(Buffer.from(getRes.body).toString()).toBe(
        sampleContent.toString(),
      );
    });

    it('rejects access to private file when signed URL is tampered', async () => {
      const server = app.getHttpServer() as unknown as Parameters<
        typeof request
      >[0];

      const postRes = await request(server)
        .post(`/api/v1/files/${privateFile.id}/signed-url`)
        .send({ disposition: 'inline' })
        .expect(200);

      const postBody = postRes.body as {
        url: string;
        fileId: string;
        disposition: string;
      };
      const signedUrl = new URL(postBody.url);
      const exp = signedUrl.searchParams.get('exp')!;
      const sig = signedUrl.searchParams.get('sig')!;

      // Alter disposition without updating signature
      await request(server)
        .get(`/api/v1/files/${privateFile.id}`)
        .query({ exp, disp: 'attachment', sig })
        .expect(401);
    });
  });

  describe('Client Disconnect & Upstream Stream Abort', () => {
    it('closes and destroys upstream stream when client disconnects prematurely', async () => {
      // Create a slow stream
      const slowStream = new PassThrough();
      const destroySpy = vi.spyOn(slowStream, 'destroy');

      vi.spyOn(fakeDriver, 'downloadStream').mockResolvedValueOnce({
        stream: slowStream,
        size: 1000,
        contentType: 'application/pdf',
      });

      const server = app.getHttpServer() as unknown as Parameters<
        typeof request
      >[0];

      const req = request(server).get(`/api/v1/files/${testFile.id}`);

      // Emit chunk then abort
      slowStream.write('chunk-1');

      setTimeout(() => {
        req.abort();
      }, 50);

      try {
        await req;
      } catch {
        // expected connection abort
      }

      await new Promise((r) => setTimeout(r, 80));

      // Verify destroy was called on the upstream stream
      expect(destroySpy).toHaveBeenCalled();
    });
  });

  describe('Replica Selection and Fallback [P4-08]', () => {
    it('mid-request fallback: succeeds from secondary replica when primary fails before headers', async () => {
      const server = app.getHttpServer() as unknown as Parameters<
        typeof request
      >[0];

      const failoverFile: FileRecord = {
        ...testFile,
        id: '0198f3a2-7c1e-7b40-9d2a-5e6f1a8c3333',
        primaryProvider: 'seaweedfs',
        storageKey: 'uploads/primary/failover.pdf',
      };
      filesDb.set(failoverFile.id, failoverFile);

      replicasDb.set(failoverFile.id, [
        {
          fileId: failoverFile.id,
          provider: 'seaweedfs',
          role: 'primary',
          status: 'AVAILABLE',
          providerKey: 'uploads/primary/failover.pdf',
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
          fileId: failoverFile.id,
          provider: 'local',
          role: 'secondary',
          status: 'AVAILABLE',
          providerKey: testFile.storageKey, // local fake driver has testFile content
          providerMeta: {},
          url: null,
          etag: null,
          attempts: 0,
          lastError: null,
          syncedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const seaweedDriver = new FakeStorageDriver('seaweedfs');
      vi.spyOn(seaweedDriver, 'downloadStream').mockRejectedValue(
        new Error('Primary SeaweedFS node down'),
      );

      const registry = app.get(StorageRegistry);
      vi.spyOn(registry, 'get').mockImplementation((name: string) => {
        if (name === 'seaweedfs') return seaweedDriver;
        if (name === 'local') return fakeDriver;
        return fakeDriver;
      });

      const res = await request(server)
        .get(`/api/v1/files/${failoverFile.id}`)
        .expect(200);

      expect(Buffer.from(res.body as Buffer).toString()).toBe(
        sampleContent.toString(),
      );
    });

    it('public file with redirect=auto: streams from primary when CDN queued, redirects when CDN available', async () => {
      const server = app.getHttpServer() as unknown as Parameters<
        typeof request
      >[0];

      const cdnFile: FileRecord = {
        ...testFile,
        id: '0198f3a2-7c1e-7b40-9d2a-5e6f1a8c4444',
        visibility: 'public',
        primaryProvider: 'local',
      };
      filesDb.set(cdnFile.id, cdnFile);

      // Stage 1: Cloudinary replica is QUEUED (not yet AVAILABLE)
      replicasDb.set(cdnFile.id, [
        {
          fileId: cdnFile.id,
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
          fileId: cdnFile.id,
          provider: 'cloudinary',
          role: 'secondary',
          status: 'QUEUED',
          providerKey: 'cdn/queued.pdf',
          providerMeta: {},
          url: null,
          etag: null,
          attempts: 0,
          lastError: null,
          syncedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const registry = app.get(StorageRegistry);
      vi.spyOn(registry, 'get').mockImplementation(() => {
        return fakeDriver;
      });

      // Should stream from primary with 200 OK
      const resStream = await request(server)
        .get(`/api/v1/files/${cdnFile.id}`)
        .query({ redirect: 'auto' })
        .expect(200);

      expect(Buffer.from(resStream.body as Buffer).toString()).toBe(
        sampleContent.toString(),
      );

      // Stage 2: Cloudinary replica becomes AVAILABLE
      const cdnDriver = new FakeStorageDriver('cloudinary');
      cdnDriver.setCapabilities({ publicCdn: true });
      const cdnUrl =
        'https://res.cloudinary.com/test-org/image/upload/cdn-file.pdf';
      vi.spyOn(cdnDriver, 'getDirectUrl').mockResolvedValue(cdnUrl);

      vi.spyOn(registry, 'get').mockImplementation((name: string) => {
        if (name === 'cloudinary') return cdnDriver;
        return fakeDriver;
      });

      replicasDb.set(cdnFile.id, [
        {
          fileId: cdnFile.id,
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
          fileId: cdnFile.id,
          provider: 'cloudinary',
          role: 'secondary',
          status: 'AVAILABLE',
          providerKey: 'cdn/file.pdf',
          providerMeta: {},
          url: cdnUrl,
          etag: null,
          attempts: 0,
          lastError: null,
          syncedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      // Should redirect with 302 Found
      const resRedirect = await request(server)
        .get(`/api/v1/files/${cdnFile.id}`)
        .query({ redirect: 'auto' })
        .expect(302);

      expect(resRedirect.headers['location']).toBe(cdnUrl);
    });

    it('?provider=x rejects non-admin with 403 and returns 409 with Retry-After: 30 for admin when unavailable', async () => {
      const server = app.getHttpServer() as unknown as Parameters<
        typeof request
      >[0];

      // Non-admin request
      await request(server)
        .get(`/api/v1/files/${testFile.id}`)
        .query({ provider: 'seaweedfs' })
        .expect(403);

      // Admin request with unavailable replica
      const res = await request(server)
        .get(`/api/v1/files/${testFile.id}`)
        .set('x-esma-admin', 'true')
        .query({ provider: 'seaweedfs' })
        .expect(409);

      expect(res.headers['retry-after']).toBe('30');
    });
  });
});
