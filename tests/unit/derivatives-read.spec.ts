/* eslint-disable @typescript-eslint/unbound-method */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FileReadService } from '../../src/files/file-read.service.js';
import { SignedUrlService } from '../../src/files/signed-url.service.js';
import { StorageRegistry } from '../../src/storage/registry.js';
import { FakeStorageDriver } from '../helpers/storage-driver.mock.js';
import { AuthorizationService } from '../../src/authz/authorization.service.js';
import { AppConfigService } from '../../src/config/config.service.js';
import { FileRepository } from '../../src/db/repositories/file.repository.js';
import { ReplicaRepository } from '../../src/db/repositories/replica.repository.js';
import type { RequestContext } from '../../src/core/request-context.js';
import type { FileRecord } from '../../src/core/types.js';
import {
  NotFoundError,
  FileNotReadyError,
} from '../../src/core/errors/app-error.js';

describe('FileReadService Image Derivatives (P5-08)', () => {
  let service: FileReadService;
  let signedUrlService: SignedUrlService;
  let fakeDriver: FakeStorageDriver;
  let storageRegistry: StorageRegistry;
  let authzService: AuthorizationService;
  let configService: AppConfigService;
  let fileRepo: FileRepository;
  let replicaRepo: ReplicaRepository;
  let cloudinaryDriver: FakeStorageDriver;

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
    replicationStatus: 'NOT_REQUIRED',
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
    createdAt: new Date('2026-10-01T10:00:00Z'),
    updatedAt: new Date('2026-10-01T10:00:00Z'),
    deletedAt: null,
  };

  const tenantCtx: RequestContext = {
    namespace: 'esma-tenant',
    tenantId: 'school-100',
    subTenantId: undefined,
    actor: {
      id: 'user-1',
      type: 'user',
      roles: ['user'],
      scopes: ['files:read'],
    },
    correlationId: 'req-1',
    ipAddress: '127.0.0.1',
    attributes: {},
  };

  beforeEach(async () => {
    fakeDriver = new FakeStorageDriver('local');
    // Store derivative payloads
    await fakeDriver.put(
      'uploads/esma-tenant/school-100/avatars/avatar.jpg.d/thumb.webp',
      Buffer.from('THUMB_WEBP_BINARY_DATA'),
      { contentType: 'image/webp' },
    );
    await fakeDriver.put(
      'uploads/esma-tenant/school-100/avatars/avatar.jpg.d/medium.webp',
      Buffer.from('MEDIUM_WEBP_BINARY_DATA'),
      { contentType: 'image/webp' },
    );

    cloudinaryDriver = new FakeStorageDriver('cloudinary');
    cloudinaryDriver.getDirectUrl = vi
      .fn()
      .mockResolvedValue(
        'https://res.cloudinary.com/demo/image/upload/w_256,f_webp/sample.jpg',
      );

    storageRegistry = {
      has: vi
        .fn()
        .mockImplementation(
          (name: string) => name === 'local' || name === 'cloudinary',
        ),
      isHealthy: vi.fn().mockReturnValue(true),
      get: vi.fn().mockImplementation((name: string) => {
        if (name === 'cloudinary') return cloudinaryDriver;
        return fakeDriver;
      }),
      getPrimary: vi.fn().mockReturnValue(fakeDriver),
      getSecondaries: vi.fn().mockReturnValue([]),
    } as unknown as StorageRegistry;

    fileRepo = {
      findById: vi.fn().mockResolvedValue(testFile),
    } as unknown as FileRepository;

    replicaRepo = {
      listByFile: vi.fn().mockResolvedValue([
        {
          fileId: testFile.id,
          provider: 'local',
          role: 'primary',
          status: 'AVAILABLE',
          providerKey: testFile.storageKey,
        },
      ]),
    } as unknown as ReplicaRepository;

    authzService = {
      canAccessTenant: vi.fn().mockReturnValue(true),
      authorize: vi.fn().mockReturnValue({ allowed: true }),
    } as unknown as AuthorizationService;

    signedUrlService = {
      verify: vi.fn().mockReturnValue({ valid: true, disposition: 'inline' }),
    } as unknown as SignedUrlService;

    configService = {
      seaweedfsPublicEndpoint: false,
    } as unknown as AppConfigService;

    service = new FileReadService(
      fileRepo,
      replicaRepo,
      storageRegistry,
      authzService,
      signedUrlService,
      configService,
    );
  });

  it('streams the requested derivative variant with image/webp content-type', async () => {
    const res = await service.open({ ctx: tenantCtx }, testFile.id, {
      variant: 'thumb',
    });

    expect(res.kind).toBe('stream');
    if (res.kind === 'stream') {
      expect(res.statusCode).toBe(200);
      expect(res.headers['Content-Type']).toBe('image/webp');
      expect(res.headers['Content-Length']).toBe('4500');
      expect(res.headers['ETag']).toBe(`"${testFile.id}-thumb-1"`);

      // Read stream content
      const chunks: Buffer[] = [];
      for await (const chunk of res.stream) {
        chunks.push(
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array),
        );
      }
      expect(Buffer.concat(chunks).toString()).toBe('THUMB_WEBP_BINARY_DATA');
    }
  });

  it('throws 404 NotFoundError when derivative variant is not found', async () => {
    await expect(
      service.open({ ctx: tenantCtx }, testFile.id, {
        variant: 'large', // non-existent variant
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it('handles If-None-Match conditional ETag match for derivatives with 304', async () => {
    const res = await service.open({ ctx: tenantCtx }, testFile.id, {
      variant: 'thumb',
      ifNoneMatch: `"${testFile.id}-thumb-1"`,
    });

    expect(res.kind).toBe('not_modified');
    expect(res.statusCode).toBe(304);
  });

  it('returns empty stream with 200 for HEAD requests on derivatives', async () => {
    const res = await service.open({ ctx: tenantCtx }, testFile.id, {
      variant: 'thumb',
      isHead: true,
    });

    expect(res.kind).toBe('stream');
    if (res.kind === 'stream') {
      expect(res.statusCode).toBe(200);
      expect(res.headers['Content-Type']).toBe('image/webp');
      expect(res.headers['Content-Length']).toBe('4500');

      const chunks: Buffer[] = [];
      for await (const chunk of res.stream) {
        chunks.push(
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array),
        );
      }
      expect(chunks).toHaveLength(0);
    }
  });

  it('redirects to Cloudinary transformation URL for public files when Cloudinary is available', async () => {
    const publicFile: FileRecord = {
      ...testFile,
      visibility: 'public',
    };
    vi.mocked(fileRepo.findById).mockResolvedValue(publicFile);

    const res = await service.open({}, testFile.id, {
      variant: 'thumb',
    });

    expect(res.kind).toBe('redirect');
    if (res.kind === 'redirect') {
      expect(res.statusCode).toBe(302);
      expect(res.url).toContain('https://res.cloudinary.com');
      expect(cloudinaryDriver.getDirectUrl).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          transform: {
            width: 256,
            height: 256,
            format: 'webp',
          },
        }),
      );
    }
  });

  it('blocks derivative read if file virus scan is PENDING', async () => {
    vi.mocked(fileRepo.findById).mockResolvedValue({
      ...testFile,
      scanStatus: 'PENDING',
    });

    await expect(
      service.open({ ctx: tenantCtx }, testFile.id, { variant: 'thumb' }),
    ).rejects.toThrow(FileNotReadyError);
  });
});
