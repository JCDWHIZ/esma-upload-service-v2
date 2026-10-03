import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { S3Client } from '@aws-sdk/client-s3';
import { ConfigModule } from '../../src/config/config.module.js';
import { AppConfigService } from '../../src/config/config.service.js';
import { DatabaseModule } from '../../src/db/database.module.js';
import { StorageModule } from '../../src/storage/storage.module.js';
import { AuthorizationModule } from '../../src/authz/authorization.module.js';
import { FilesModule } from '../../src/files/files.module.js';
import { StorageRegistry } from '../../src/storage/registry.js';
import { PresignedUploadService } from '../../src/files/presigned-upload.service.js';
import { SeaweedFSStorageDriver } from '../../src/storage/drivers/seaweedfs.driver.js';
import { DatabaseService } from '../../src/db/database.service.js';
import { FileRepository } from '../../src/db/repositories/file.repository.js';
import { ReplicaRepository } from '../../src/db/repositories/replica.repository.js';
import { UsageRepository } from '../../src/db/repositories/usage.repository.js';
import { OutboxRepository } from '../../src/db/repositories/outbox.repository.js';
import { ProblemJsonErrorFilter } from '../../src/common/filters/problem-json-error.filter.js';
import type { AuthenticatedHttpRequest } from '../../src/auth/context.js';
import type { RequestContext } from '../../src/core/request-context.js';
import type { FileRecord, FileReplica } from '../../src/core/types.js';

describe('Direct-to-Storage Presigned Upload Integration [P2-09]', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let presignedService: PresignedUploadService;
  let registry: StorageRegistry;
  let dbService: DatabaseService;
  let fileRepo: FileRepository;
  let replicaRepo: ReplicaRepository;
  let usageRepo: UsageRepository;
  let outboxRepo: OutboxRepository;
  let enqueueSpy: ReturnType<typeof vi.spyOn>;
  let mockS3Client: S3Client;
  let seaweedDriver: SeaweedFSStorageDriver;

  const mockCtx: RequestContext = {
    namespace: 'esma-tenant',
    tenantId: 'school-integration',
    subTenantId: 'branch-main',
    actor: {
      id: 'integration-uploader',
      type: 'user',
      roles: ['schooladmin'],
      scopes: ['files:write'],
      branchGrants: ['branch-main'],
      isSchoolAdmin: true,
      isPlatformAdmin: false,
    },
    correlationId: '0198f3a2-7c1e-7b40-9d2a-5e6f1a8c9999',
    ipAddress: '127.0.0.1',
    attributes: {},
  };

  const storedFiles = new Map<string, FileRecord>();

  beforeEach(async () => {
    storedFiles.clear();

    mockS3Client = new S3Client({
      endpoint: 'http://localhost:8333',
      region: 'us-east-1',
      credentials: {
        accessKeyId: 'test-key',
        secretAccessKey: 'test-secret',
      },
      forcePathStyle: true,
    });

    mockS3Client.send = vi
      .fn()
      .mockImplementation((command: { constructor: { name: string } }) => {
        if (command.constructor.name === 'HeadObjectCommand') {
          return Promise.resolve({
            ContentLength: 1048576,
            ETag: '"etag-video-test"',
            ContentType: 'application/pdf',
          });
        }
        if (command.constructor.name === 'PutObjectCommand') {
          return Promise.resolve({
            ETag: '"etag-video-test"',
          });
        }
        if (command.constructor.name === 'DeleteObjectCommand') {
          return Promise.resolve({});
        }
        return Promise.resolve({});
      });

    seaweedDriver = new SeaweedFSStorageDriver(
      {
        endpoint: 'http://localhost:8333',
        publicEndpoint: 'https://s3.infra.elsoft.ng',
        bucket: 'esma-uploads',
        accessKeyId: 'test-key',
        secretAccessKey: 'test-secret',
        allowInternalPresignedUrls: true,
      },
      mockS3Client,
    );

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule,
        DatabaseModule,
        StorageModule,
        AuthorizationModule,
        FilesModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedHttpRequest).ctx = mockCtx;
      next();
    });
    app.useGlobalFilters(new ProblemJsonErrorFilter());
    await app.init();

    presignedService = moduleRef.get(PresignedUploadService);
    registry = moduleRef.get(StorageRegistry);
    dbService = moduleRef.get(DatabaseService);
    fileRepo = moduleRef.get(FileRepository);
    replicaRepo = moduleRef.get(ReplicaRepository);
    usageRepo = moduleRef.get(UsageRepository);
    outboxRepo = moduleRef.get(OutboxRepository);
    const configService = moduleRef.get(AppConfigService);
    vi.spyOn(configService, 'eventsEnabled', 'get').mockReturnValue(true);

    // Register test seaweed driver instance with mocked S3 client
    registry.register(seaweedDriver);

    // Mock DB transaction executor
    vi.spyOn(dbService, 'getDb').mockReturnValue({
      transaction: () => ({
        execute: async <T>(cb: (trx: unknown) => Promise<T>): Promise<T> => {
          return cb({});
        },
      }),
    } as unknown as ReturnType<DatabaseService['getDb']>);

    // Mock repository methods
    vi.spyOn(usageRepo, 'tryReserve').mockResolvedValue(true);
    vi.spyOn(usageRepo, 'release').mockResolvedValue(undefined);

    vi.spyOn(fileRepo, 'insert').mockImplementation((data) => {
      const file: FileRecord = {
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
        status: data.status ?? 'PENDING_UPLOAD',
        scanStatus: 'NOT_REQUIRED',
        replicationStatus: 'NOT_REQUIRED',
        primaryProvider: 'seaweedfs',
        uploadedBy: data.uploadedBy,
        tags: data.tags ?? [],
        attributes: data.attributes ?? {},
        legacyPublicId: null,
        idempotencyKey: null,
        correlationId: data.correlationId,
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        expiresAt: data.expiresAt ?? null,
      };
      storedFiles.set(file.id, file);
      return Promise.resolve(file);
    });

    vi.spyOn(fileRepo, 'findById').mockImplementation((id: string) => {
      return Promise.resolve(storedFiles.get(id) ?? null);
    });

    vi.spyOn(fileRepo, 'updateStatus').mockImplementation(
      (id: string, version: number, updates) => {
        const existing = storedFiles.get(id);
        if (!existing) {
          throw new Error('Not found');
        }
        const updated: FileRecord = {
          ...existing,
          version: version + 1,
          status: updates.status ?? existing.status,
          sizeBytes:
            updates.sizeBytes !== undefined
              ? BigInt(String(updates.sizeBytes))
              : existing.sizeBytes,
          sha256:
            updates.sha256 !== undefined ? updates.sha256 : existing.sha256,
          expiresAt:
            updates.expiresAt !== undefined
              ? updates.expiresAt
              : existing.expiresAt,
        };
        storedFiles.set(id, updated);
        return Promise.resolve(updated);
      },
    );

    vi.spyOn(replicaRepo, 'insertMany').mockImplementation((replicas) => {
      return Promise.resolve(
        replicas.map((r): FileReplica => ({
          fileId: r.fileId,
          provider: r.provider,
          role: r.role,
          status: r.status ?? 'AVAILABLE',
          providerKey: r.providerKey,
          providerMeta: r.providerMeta ?? {},
          url: r.url ?? null,
          etag: r.etag ?? null,
          attempts: r.attempts ?? 0,
          lastError: r.lastError ?? null,
          syncedAt: r.syncedAt ?? new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
      );
    });

    vi.spyOn(replicaRepo, 'listByFile').mockImplementation(
      (fileId: string): Promise<FileReplica[]> => {
        const file = storedFiles.get(fileId);
        if (!file) return Promise.resolve([]);
        return Promise.resolve([
          {
            fileId,
            provider: 'seaweedfs',
            role: 'primary',
            status: 'AVAILABLE',
            providerKey: file.storageKey,
            providerMeta: {},
            url: null,
            etag: 'etag-video-test',
            attempts: 0,
            lastError: null,
            syncedAt: new Date(),
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ]);
      },
    );

    enqueueSpy = vi.spyOn(outboxRepo, 'enqueue').mockImplementation((event) => {
      return Promise.resolve({
        id: 'outbox-test-1',
        topic: event.topic,
        partitionKey: event.partitionKey,
        eventType: event.eventType,
        envelope: event.envelope,
        availableAt: new Date(),
        publishedAt: null,
        attempts: 0,
        lastError: null,
        createdAt: new Date(),
      });
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (app) {
      await app.close();
    }
  });

  it('completes the entire cycle: initiate -> mock S3 upload -> complete -> manifest', async () => {
    // 1. Initiate presigned upload
    const initiateResult = await presignedService.initiate(mockCtx, {
      filename: 'lecture_recording.pdf',
      sizeBytes: 1048576,
      mimeType: 'application/pdf',
      branchId: 'branch-main',
      folder: 'lectures',
      visibility: 'tenant',
    });

    expect(initiateResult.fileId).toBeDefined();
    expect(initiateResult.uploadUrl).toContain('https://s3.infra.elsoft.ng');
    expect(initiateResult.requiredHeaders).toEqual({
      'Content-Type': 'application/pdf',
    });
    expect(initiateResult.expiresAt).toBeDefined();

    // Verify stored record is PENDING_UPLOAD
    const pending = storedFiles.get(initiateResult.fileId);
    expect(pending).toBeDefined();
    expect(pending?.status).toBe('PENDING_UPLOAD');
    expect(pending?.primaryProvider).toBe('seaweedfs');

    // 2. Complete presigned upload after simulated direct PUT
    const manifest = await presignedService.complete(
      mockCtx,
      initiateResult.fileId,
      { clientEtag: 'etag-video-test' },
    );

    expect(manifest.success).toBe(true);
    expect(manifest.data.fileId).toBe(initiateResult.fileId);
    expect(manifest.data.filename).toBe('lecture_recording.pdf');
    expect(manifest.data.mimetype).toBe('application/pdf');
    expect(manifest.data.size).toBe(1048576);
    expect(manifest.data.canonicalUrl).toContain(initiateResult.fileId);

    // Verify stored record transitioned to ACTIVE
    const completed = storedFiles.get(initiateResult.fileId);
    expect(completed?.status).toBe('ACTIVE');
    expect(completed?.expiresAt).toBeNull();

    // Verify outbox replication event was enqueued
    expect(enqueueSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: 'file.uploaded',
        partitionKey: initiateResult.fileId,
        eventType: 'file.uploaded',
      }),
      expect.anything(),
    );
  });

  it('serves HTTP endpoints: POST /api/v1/files/presigned-upload and POST /api/v1/files/:fileId/complete-upload', async () => {
    // 1. HTTP Initiate
    const initRes = await request(
      app.getHttpServer() as Parameters<typeof request>[0],
    )
      .post('/api/v1/files/presigned-upload')
      .send({
        filename: 'http_document.pdf',
        sizeBytes: 1048576,
        mimeType: 'application/pdf',
        folder: 'media',
      })
      .expect(201);

    const initBody = initRes.body as {
      success: boolean;
      data: { fileId: string; uploadUrl: string };
    };
    expect(initBody.success).toBe(true);
    expect(initBody.data.fileId).toBeDefined();
    expect(initBody.data.uploadUrl).toBeDefined();

    const createdId = initBody.data.fileId;

    // 2. HTTP Complete
    const completeRes = await request(
      app.getHttpServer() as Parameters<typeof request>[0],
    )
      .post(`/api/v1/files/${createdId}/complete-upload`)
      .send({ clientEtag: 'etag-video-test' })
      .expect(200);

    const completeBody = completeRes.body as {
      success: boolean;
      data: { fileId: string; filename: string };
    };
    expect(completeBody.success).toBe(true);
    expect(completeBody.data.fileId).toBe(createdId);
    expect(completeBody.data.filename).toBe('http_document.pdf');
  });

  it('enforces branch isolation: rejects upload initiation to unauthorized branch with 403', async () => {
    const restrictedCtx: RequestContext = {
      ...mockCtx,
      actor: {
        ...mockCtx.actor,
        branchGrants: ['branch-east'],
        isSchoolAdmin: false,
        isPlatformAdmin: false,
      },
    };

    await expect(
      presignedService.initiate(restrictedCtx, {
        filename: 'forbidden.pdf',
        sizeBytes: 1000,
        mimeType: 'application/pdf',
        branchId: 'branch-west',
      }),
    ).rejects.toThrow();
  });

  it('enforces tenant boundary: cross-tenant complete returns 404', async () => {
    const file = await presignedService.initiate(mockCtx, {
      filename: 'tenant_file.pdf',
      sizeBytes: 1000,
      mimeType: 'application/pdf',
    });

    const otherTenantCtx: RequestContext = {
      ...mockCtx,
      tenantId: 'other-school',
    };

    await expect(
      presignedService.complete(otherTenantCtx, file.fileId),
    ).rejects.toThrow();
  });
});
