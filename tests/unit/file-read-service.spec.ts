import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import { FileReadService } from '../../src/files/file-read.service.js';
import { SignedUrlService } from '../../src/files/signed-url.service.js';
import { StorageRegistry } from '../../src/storage/registry.js';
import { FakeStorageDriver } from '../helpers/storage-driver.mock.js';
import { AuthorizationService } from '../../src/authz/authorization.service.js';
import { AppConfigService } from '../../src/config/config.service.js';
import { FileRepository } from '../../src/db/repositories/file.repository.js';
import { ReplicaRepository } from '../../src/db/repositories/replica.repository.js';
import { RequestContext } from '../../src/core/request-context.js';
import { FileRecord, FileReplica } from '../../src/core/types.js';
import {
  FileNotReadyError,
  FileQuarantinedError,
  ForbiddenError,
  NotFoundError,
  ReplicaNotAvailableError,
  UnauthenticatedError,
} from '../../src/core/errors/app-error.js';

describe('FileReadService Unit Tests [P2-07]', () => {
  let service: FileReadService;
  let signedUrlService: SignedUrlService;
  let fakeDriver: FakeStorageDriver;
  let storageRegistry: StorageRegistry;
  let authzService: AuthorizationService;
  let configService: AppConfigService;
  let fileRepo: FileRepository;
  let replicaRepo: ReplicaRepository;

  const testPayload = Buffer.from('abcdefghijklmnopqrstuvwxyz0123456789'); // 36 bytes

  const baseFileRecord: FileRecord = {
    id: '0198f3a2-7c1e-7b40-9d2a-5e6f1a8c0001',
    namespace: 'esma-tenant',
    tenantId: 'school-100',
    subTenantId: 'branch-A',
    folder: 'documents',
    storageKey: 'uploads/schools/school-100/test.pdf',
    originalFilename: 'test.pdf',
    mimetype: 'application/pdf',
    declaredMimetype: 'application/pdf',
    sizeBytes: BigInt(testPayload.length),
    sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    visibility: 'tenant',
    status: 'ACTIVE',
    scanStatus: 'CLEAN',
    replicationStatus: 'NOT_REQUIRED',
    primaryProvider: 'local',
    uploadedBy: 'user-owner-1',
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

  const sameTenantCtx: RequestContext = {
    namespace: 'esma-tenant',
    tenantId: 'school-100',
    subTenantId: 'branch-A',
    actor: {
      id: 'user-other',
      type: 'user',
      roles: ['teacher'],
      scopes: [],
    },
    correlationId: '0198f3a2-7c1e-7b40-9d2a-5e6f1a8c0000',
    ipAddress: '127.0.0.1',
    attributes: {},
  };

  const ownerCtx: RequestContext = {
    ...sameTenantCtx,
    actor: {
      id: 'user-owner-1',
      type: 'user',
      roles: ['teacher'],
      scopes: [],
    },
  };

  const schoolAdminCtx: RequestContext = {
    ...sameTenantCtx,
    actor: {
      id: 'school-admin-1',
      type: 'user',
      roles: ['school_admin'],
      scopes: [],
      isSchoolAdmin: true,
    },
  };

  const crossTenantCtx: RequestContext = {
    namespace: 'esma-tenant',
    tenantId: 'school-999',
    subTenantId: undefined,
    actor: {
      id: 'attacker-1',
      type: 'user',
      roles: ['school_admin'],
      scopes: [],
    },
    correlationId: '0198f3a2-7c1e-7b40-9d2a-5e6f1a8c0000',
    ipAddress: '127.0.0.1',
    attributes: {},
  };

  const adminCtx: RequestContext = {
    namespace: 'esma-admin',
    tenantId: 'system',
    subTenantId: undefined,
    actor: {
      id: 'platform-admin',
      type: 'user',
      roles: ['superadmin'],
      scopes: ['files:admin', '*'],
      isPlatformAdmin: true,
    },
    correlationId: '0198f3a2-7c1e-7b40-9d2a-5e6f1a8c0000',
    ipAddress: '127.0.0.1',
    attributes: {},
  };

  let mockFilesMap: Map<string, FileRecord>;
  let mockReplicasMap: Map<string, FileReplica[]>;
  let cloudinaryDriver: FakeStorageDriver;

  beforeEach(async () => {
    mockFilesMap = new Map();
    mockReplicasMap = new Map();

    mockFilesMap.set(baseFileRecord.id, { ...baseFileRecord });

    fakeDriver = new FakeStorageDriver('local');
    cloudinaryDriver = new FakeStorageDriver('cloudinary');

    // Store test file in fake driver
    await fakeDriver.upload({
      key: baseFileRecord.storageKey,
      source: () => Readable.from(testPayload),
      size: testPayload.length,
      sha256: baseFileRecord.sha256!,
      mimetype: baseFileRecord.mimetype,
      visibility: 'tenant',
    });

    storageRegistry = {
      get: vi.fn().mockImplementation((name: string) => {
        if (name === 'local') return fakeDriver;
        if (name === 'cloudinary') return cloudinaryDriver;
        if (name === 'seaweedfs') return fakeDriver;
        throw new Error(`Driver not found: ${name}`);
      }),
    } as unknown as StorageRegistry;

    configService = {
      signedUrlSecret: 'very-secret-test-key-32-chars-long-minimum-size',
      signedUrlMaxTtlSeconds: 900,
      appBaseUrl: 'https://cdn.example.com',
      seaweedfsPublicEndpoint: undefined,
      get: () => ({
        ADMIN_ALLOWED_ROLES: 'superadmin',
      }),
    } as unknown as AppConfigService;

    signedUrlService = new SignedUrlService(configService);
    authzService = new AuthorizationService(configService);

    fileRepo = {
      findById: vi
        .fn()
        .mockImplementation((id: string) =>
          Promise.resolve(mockFilesMap.get(id) ?? null),
        ),
    } as unknown as FileRepository;

    replicaRepo = {
      listByFile: vi
        .fn()
        .mockImplementation((id: string) =>
          Promise.resolve(mockReplicasMap.get(id) ?? []),
        ),
    } as unknown as ReplicaRepository;

    service = new FileReadService(
      fileRepo,
      replicaRepo,
      storageRegistry,
      authzService,
      signedUrlService,
      configService,
    );
  });

  describe('Status and Scan Gating', () => {
    it('throws NotFoundError for non-existent file', async () => {
      await expect(
        service.open(sameTenantCtx, 'non-existent-id'),
      ).rejects.toThrow(NotFoundError);
    });

    it('throws NotFoundError for DELETED or DELETING file', async () => {
      mockFilesMap.set('del-1', {
        ...baseFileRecord,
        id: 'del-1',
        status: 'DELETED',
      });
      mockFilesMap.set('del-2', {
        ...baseFileRecord,
        id: 'del-2',
        status: 'DELETING',
      });

      await expect(service.open(sameTenantCtx, 'del-1')).rejects.toThrow(
        NotFoundError,
      );
      await expect(service.open(sameTenantCtx, 'del-2')).rejects.toThrow(
        NotFoundError,
      );
    });

    it('throws FileQuarantinedError for QUARANTINED or INFECTED file', async () => {
      mockFilesMap.set('quar-1', {
        ...baseFileRecord,
        id: 'quar-1',
        status: 'QUARANTINED',
      });
      mockFilesMap.set('inf-1', {
        ...baseFileRecord,
        id: 'inf-1',
        scanStatus: 'INFECTED',
      });

      await expect(service.open(sameTenantCtx, 'quar-1')).rejects.toThrow(
        FileQuarantinedError,
      );
      await expect(service.open(sameTenantCtx, 'inf-1')).rejects.toThrow(
        FileQuarantinedError,
      );
    });

    it('throws FileNotReadyError for scanStatus PENDING', async () => {
      mockFilesMap.set('pend-1', {
        ...baseFileRecord,
        id: 'pend-1',
        scanStatus: 'PENDING',
      });

      await expect(service.open(sameTenantCtx, 'pend-1')).rejects.toThrow(
        FileNotReadyError,
      );
    });
  });

  describe('Visibility and Authorization per ARCH §4.3', () => {
    it('public file allows unauthenticated read', async () => {
      mockFilesMap.set('pub-1', {
        ...baseFileRecord,
        id: 'pub-1',
        visibility: 'public',
      });

      const res = await service.open(null, 'pub-1');
      expect(res.kind).toBe('stream');
      expect(res.statusCode).toBe(200);
      expect(res.headers['Cache-Control']).toBe('public, max-age=86400');
    });

    it('tenant file denies unauthenticated read with 401', async () => {
      await expect(service.open(null, baseFileRecord.id)).rejects.toThrow(
        UnauthenticatedError,
      );
    });

    it('tenant file returns 404 on cross-tenant read (never leaks existence)', async () => {
      await expect(
        service.open(crossTenantCtx, baseFileRecord.id),
      ).rejects.toThrow(NotFoundError);
    });

    it('tenant file allows authenticated actor in the same tenant', async () => {
      const res = await service.open(sameTenantCtx, baseFileRecord.id);
      expect(res.kind).toBe('stream');
      expect(res.statusCode).toBe(200);
      expect(res.headers['Cache-Control']).toBe('private, no-store');
    });

    it('private file denies unauthenticated access without signed URL with 401', async () => {
      mockFilesMap.set('priv-1', {
        ...baseFileRecord,
        id: 'priv-1',
        visibility: 'private',
      });

      await expect(service.open(null, 'priv-1')).rejects.toThrow(
        UnauthenticatedError,
      );
    });

    it('private file denies non-owner, non-admin in same tenant with 403', async () => {
      mockFilesMap.set('priv-1', {
        ...baseFileRecord,
        id: 'priv-1',
        visibility: 'private',
      });

      await expect(service.open(sameTenantCtx, 'priv-1')).rejects.toThrow(
        ForbiddenError,
      );
    });

    it('private file returns 404 for cross-tenant access', async () => {
      mockFilesMap.set('priv-1', {
        ...baseFileRecord,
        id: 'priv-1',
        visibility: 'private',
      });

      await expect(service.open(crossTenantCtx, 'priv-1')).rejects.toThrow(
        NotFoundError,
      );
    });

    it('private file allows owner to read', async () => {
      mockFilesMap.set('priv-1', {
        ...baseFileRecord,
        id: 'priv-1',
        visibility: 'private',
      });

      const res = await service.open(ownerCtx, 'priv-1');
      expect(res.kind).toBe('stream');
      expect(res.statusCode).toBe(200);
    });

    it('private file allows school admin to read', async () => {
      mockFilesMap.set('priv-1', {
        ...baseFileRecord,
        id: 'priv-1',
        visibility: 'private',
      });

      const res = await service.open(schoolAdminCtx, 'priv-1');
      expect(res.kind).toBe('stream');
      expect(res.statusCode).toBe(200);
    });

    it('private file allows unauthenticated read with valid signed URL', async () => {
      mockFilesMap.set('priv-1', {
        ...baseFileRecord,
        id: 'priv-1',
        visibility: 'private',
      });

      const signed = signedUrlService.sign('priv-1', { disposition: 'inline' });
      const res = await service.open(
        { exp: signed.exp, disp: signed.disp, sig: signed.sig },
        'priv-1',
      );

      expect(res.kind).toBe('stream');
      expect(res.statusCode).toBe(200);
      expect(res.headers['Content-Disposition']).toContain('inline');
    });

    it('private file rejects unauthenticated read with tampered signed URL', async () => {
      mockFilesMap.set('priv-1', {
        ...baseFileRecord,
        id: 'priv-1',
        visibility: 'private',
      });

      const signed = signedUrlService.sign('priv-1');
      await expect(
        service.open(
          { exp: signed.exp, disp: signed.disp, sig: 'bad-sig' },
          'priv-1',
        ),
      ).rejects.toThrow(UnauthenticatedError);
    });
  });

  describe('Conditional Requests (If-None-Match)', () => {
    it('returns 304 when ETag matches', async () => {
      const res = await service.open(sameTenantCtx, baseFileRecord.id, {
        ifNoneMatch: `"${baseFileRecord.sha256}"`,
      });

      expect(res.kind).toBe('not_modified');
      expect(res.statusCode).toBe(304);
      expect(res.headers['ETag']).toBe(`"${baseFileRecord.sha256}"`);
    });

    it('returns 304 when If-None-Match is wildcard *', async () => {
      const res = await service.open(sameTenantCtx, baseFileRecord.id, {
        ifNoneMatch: '*',
      });

      expect(res.kind).toBe('not_modified');
      expect(res.statusCode).toBe(304);
    });

    it('returns 200 stream when ETag differs', async () => {
      const res = await service.open(sameTenantCtx, baseFileRecord.id, {
        ifNoneMatch: '"different-etag"',
      });

      expect(res.kind).toBe('stream');
      expect(res.statusCode).toBe(200);
    });
  });

  describe('Range Requests & Byte Slicing (ARCH §7.2)', () => {
    it('returns exact byte slice for bounded range bytes=0-9', async () => {
      const res = await service.open(sameTenantCtx, baseFileRecord.id, {
        range: 'bytes=0-9',
      });

      expect(res.kind).toBe('stream');
      expect(res.statusCode).toBe(206);
      expect(res.headers['Content-Range']).toBe(
        `bytes 0-9/${testPayload.length}`,
      );
      expect(res.headers['Content-Length']).toBe('10');

      if (res.kind === 'stream') {
        const chunks: Buffer[] = [];
        for await (const chunk of res.stream) {
          chunks.push(
            Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array),
          );
        }
        const slice = Buffer.concat(chunks);
        expect(slice.toString()).toBe('abcdefghij');
      }
    });

    it('returns slice for open-ended prefix bytes=26-', async () => {
      const res = await service.open(sameTenantCtx, baseFileRecord.id, {
        range: 'bytes=26-',
      });

      expect(res.kind).toBe('stream');
      expect(res.statusCode).toBe(206);
      expect(res.headers['Content-Range']).toBe(
        `bytes 26-35/${testPayload.length}`,
      );
      expect(res.headers['Content-Length']).toBe('10');

      if (res.kind === 'stream') {
        const chunks: Buffer[] = [];
        for await (const chunk of res.stream) {
          chunks.push(
            Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array),
          );
        }
        const slice = Buffer.concat(chunks);
        expect(slice.toString()).toBe('0123456789');
      }
    });

    it('returns suffix range bytes=-6 (last 6 bytes)', async () => {
      const res = await service.open(sameTenantCtx, baseFileRecord.id, {
        range: 'bytes=-6',
      });

      expect(res.kind).toBe('stream');
      expect(res.statusCode).toBe(206);
      expect(res.headers['Content-Range']).toBe(
        `bytes 30-35/${testPayload.length}`,
      );
      expect(res.headers['Content-Length']).toBe('6');

      if (res.kind === 'stream') {
        const chunks: Buffer[] = [];
        for await (const chunk of res.stream) {
          chunks.push(
            Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array),
          );
        }
        const slice = Buffer.concat(chunks);
        expect(slice.toString()).toBe('456789');
      }
    });

    it('answers multi-range request as full 200 per ARCH §7.2', async () => {
      const res = await service.open(sameTenantCtx, baseFileRecord.id, {
        range: 'bytes=0-5, 10-15',
      });

      expect(res.kind).toBe('stream');
      expect(res.statusCode).toBe(200);
      expect(res.headers['Content-Length']).toBe(String(testPayload.length));
    });

    it('returns 416 for unsatisfiable range', async () => {
      const res1 = await service.open(sameTenantCtx, baseFileRecord.id, {
        range: 'bytes=100-50',
      });
      expect(res1.kind).toBe('range_not_satisfiable');
      expect(res1.statusCode).toBe(416);
      expect(res1.headers['Content-Range']).toBe(
        `bytes */${testPayload.length}`,
      );

      const res2 = await service.open(sameTenantCtx, baseFileRecord.id, {
        range: 'bytes=5000-',
      });
      expect(res2.kind).toBe('range_not_satisfiable');
      expect(res2.statusCode).toBe(416);
    });
  });

  describe('Response Hardening Headers (ARCH §4.5)', () => {
    it('sets all mandatory security and caching headers', async () => {
      const res = await service.open(sameTenantCtx, baseFileRecord.id);

      expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
      expect(res.headers['Content-Security-Policy']).toBe('sandbox');
      expect(res.headers['Accept-Ranges']).toBe('bytes');
      expect(res.headers['Content-Type']).toBe('application/pdf');
      expect(res.headers['Content-Disposition']).toContain('inline'); // PDF defaults to inline
    });

    it('defaults non-image/pdf MIME to attachment disposition', async () => {
      mockFilesMap.set('zip-1', {
        ...baseFileRecord,
        id: 'zip-1',
        mimetype: 'application/zip',
        originalFilename: 'archive.zip',
      });

      const res = await service.open(sameTenantCtx, 'zip-1');
      expect(res.headers['Content-Disposition']).toContain('attachment');
      expect(res.headers['Content-Disposition']).toContain('archive.zip');
    });
  });

  describe('Provider and Replica Selection', () => {
    it('rejects ?provider= without admin privileges', async () => {
      await expect(
        service.open(sameTenantCtx, baseFileRecord.id, { provider: 'local' }),
      ).rejects.toThrow(ForbiddenError);
    });

    it('throws ReplicaNotAvailableError with 409 and Retry-After: 30 for missing replica', async () => {
      mockReplicasMap.set(baseFileRecord.id, []);

      try {
        await service.open(adminCtx, baseFileRecord.id, {
          provider: 'seaweedfs',
        });
        expect.fail('Should have thrown ReplicaNotAvailableError');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(ReplicaNotAvailableError);
        const headers = (err as { headers?: Record<string, string> }).headers;
        expect(headers?.['Retry-After']).toBe('30');
      }
    });

    it('redirects to Cloudinary for public files when available', async () => {
      mockFilesMap.set('pub-img', {
        ...baseFileRecord,
        id: 'pub-img',
        visibility: 'public',
        mimetype: 'image/jpeg',
      });

      mockReplicasMap.set('pub-img', [
        {
          fileId: 'pub-img',
          provider: 'cloudinary',
          role: 'secondary',
          status: 'AVAILABLE',
          providerKey: 'schools/sample.jpg',
          providerMeta: {},
          url: 'https://cloudinary.example.com/schools/sample.jpg',
          etag: null,
          attempts: 0,
          lastError: null,
          syncedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      // Configure cloudinary driver to return direct url
      cloudinaryDriver.setCapabilities({ publicCdn: true });

      const res = await service.open(null, 'pub-img', { redirect: 'auto' });
      expect(res.kind).toBe('redirect');
      expect(res.statusCode).toBe(302);
      expect((res as unknown as { url: string }).url).toContain(
        'cloudinary.example.com',
      );
    });
  });
});
