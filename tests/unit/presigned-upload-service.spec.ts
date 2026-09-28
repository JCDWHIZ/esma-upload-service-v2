import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PresignedUploadService } from '../../src/files/presigned-upload.service.js';
import { StorageRegistry } from '../../src/storage/registry.js';
import { AuthorizationService } from '../../src/authz/authorization.service.js';
import { AppConfigService } from '../../src/config/config.service.js';
import { PolicyRegistry } from '../../src/config/policy-registry.js';
import { DatabaseService } from '../../src/db/database.service.js';
import { FileRepository } from '../../src/db/repositories/file.repository.js';
import { ReplicaRepository } from '../../src/db/repositories/replica.repository.js';
import { UsageRepository } from '../../src/db/repositories/usage.repository.js';
import { OutboxRepository } from '../../src/db/repositories/outbox.repository.js';
import type { RequestContext } from '../../src/core/request-context.js';
import type { FileRecord, FileReplica } from '../../src/core/types.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PayloadTooLargeError,
  PolicyViolationError,
  QuotaExceededError,
  StorageUnavailableError,
  UnsupportedMediaTypeError,
  ValidationError,
} from '../../src/core/errors/app-error.js';

describe('PresignedUploadService Unit Tests [P2-09]', () => {
  let service: PresignedUploadService;
  let mockSeaweedDriver: {
    name: 'seaweedfs';
    isConfigured: ReturnType<typeof vi.fn>;
    getPresignedUploadUrl: ReturnType<typeof vi.fn>;
    stat: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  let mockStorageRegistry: {
    get: ReturnType<typeof vi.fn>;
  };
  let mockFileRepo: {
    insert: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    updateStatus: ReturnType<typeof vi.fn>;
    findExpiredPendingUploads: ReturnType<typeof vi.fn>;
  };
  let mockReplicaRepo: {
    insertMany: ReturnType<typeof vi.fn>;
    listByFile: ReturnType<typeof vi.fn>;
  };
  let mockUsageRepo: {
    tryReserve: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };
  let mockOutboxRepo: {
    enqueue: ReturnType<typeof vi.fn>;
  };
  let mockPolicyRegistry: {
    get: ReturnType<typeof vi.fn>;
  };
  let mockAuthzService: {
    authorize: ReturnType<typeof vi.fn>;
    canAccessTenant: ReturnType<typeof vi.fn>;
  };
  let mockConfigService: {
    eventsEnabled: boolean;
    appBaseUrl: string;
  };
  let mockDbService: {
    getDb: ReturnType<typeof vi.fn>;
  };

  const defaultCtx: RequestContext = {
    namespace: 'esma-tenant',
    tenantId: 'school-1',
    subTenantId: 'branch-north',
    actor: {
      id: 'teacher-1',
      type: 'user',
      roles: ['teacher'],
      scopes: ['files:write'],
      branchGrants: ['branch-north'],
      isSchoolAdmin: false,
      isPlatformAdmin: false,
    },
    correlationId: 'corr-presigned-test',
    ipAddress: '127.0.0.1',
    attributes: {},
  };

  const defaultPolicy = {
    namespace: 'esma-tenant',
    maxFileSizeBytes: 1024 * 1024 * 500, // 500 MiB
    maxFilesPerRequest: 10,
    allowedMimeTypes: ['video/mp4', 'image/jpeg', 'application/pdf'],
    defaultVisibility: 'tenant' as const,
    allowedVisibilities: [
      'tenant' as const,
      'private' as const,
      'public' as const,
    ],
    cloudinaryReplication: 'never' as const,
    cloudinaryRootFolder: 'uploads',
    requireVirusScan: false,
  };

  const pendingFile: FileRecord = {
    id: '0198f3a2-7c1e-7b40-9d2a-5e6f1a8c3b99',
    namespace: 'esma-tenant',
    tenantId: 'school-1',
    subTenantId: 'branch-north',
    folder: 'media',
    storageKey: 'tenants/school-1/branches/branch-north/media/0198f3a2.mp4',
    originalFilename: 'fair.mp4',
    mimetype: 'video/mp4',
    declaredMimetype: 'video/mp4',
    sizeBytes: 524288000n,
    sha256: null,
    visibility: 'tenant',
    status: 'PENDING_UPLOAD',
    scanStatus: 'NOT_REQUIRED',
    replicationStatus: 'NOT_REQUIRED',
    primaryProvider: 'seaweedfs',
    uploadedBy: 'teacher-1',
    tags: [],
    attributes: {},
    legacyPublicId: null,
    idempotencyKey: null,
    correlationId: 'corr-init',
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    expiresAt: new Date(Date.now() + 600000),
  };

  beforeEach(() => {
    mockSeaweedDriver = {
      name: 'seaweedfs',
      isConfigured: vi.fn().mockReturnValue(true),
      getPresignedUploadUrl: vi.fn().mockResolvedValue({
        uploadUrl: 'https://s3.example.com/upload-target?sig=abc',
        requiredHeaders: { 'Content-Type': 'video/mp4' },
      }),
      stat: vi.fn().mockResolvedValue({
        size: 524288000,
        etag: 'etag-12345',
        contentType: 'video/mp4',
      }),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    mockStorageRegistry = {
      get: vi.fn().mockImplementation((name: string) => {
        if (name === 'seaweedfs') return mockSeaweedDriver;
        return undefined;
      }),
    };

    mockFileRepo = {
      insert: vi.fn().mockImplementation((data: unknown) => {
        const file = data as FileRecord;
        return Promise.resolve({
          ...file,
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
        });
      }),
      findById: vi.fn(),
      updateStatus: vi
        .fn()
        .mockImplementation((id: string, version: number, updates: unknown) => {
          const up = updates as Record<string, unknown>;
          return Promise.resolve({
            ...pendingFile,
            id,
            version: version + 1,
            status: up.status ?? 'ACTIVE',
            sizeBytes:
              typeof up.sizeBytes === 'number' ||
              typeof up.sizeBytes === 'bigint'
                ? BigInt(up.sizeBytes)
                : 524288000n,
            sha256: up.sha256 ?? null,
            expiresAt: null,
          });
        }),
      findExpiredPendingUploads: vi.fn().mockResolvedValue([]),
    };

    mockReplicaRepo = {
      insertMany: vi.fn().mockImplementation((replicas: unknown[]) => {
        return Promise.resolve(
          (replicas as FileReplica[]).map((r) => ({
            ...r,
            attempts: 0,
            lastError: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          })),
        );
      }),
      listByFile: vi.fn().mockResolvedValue([]),
    };

    mockUsageRepo = {
      tryReserve: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(undefined),
    };

    mockOutboxRepo = {
      enqueue: vi.fn().mockResolvedValue(undefined),
    };

    mockPolicyRegistry = {
      get: vi.fn().mockReturnValue(defaultPolicy),
    };

    mockAuthzService = {
      authorize: vi.fn().mockReturnValue({ allowed: true }),
      canAccessTenant: vi.fn().mockReturnValue(true),
    };

    mockConfigService = {
      eventsEnabled: true,
      appBaseUrl: 'http://localhost:7030',
    };

    const mockTrx = {};
    mockDbService = {
      getDb: vi.fn().mockReturnValue({
        transaction: () => ({
          execute: async (fn: (trx: unknown) => Promise<unknown>) =>
            fn(mockTrx),
        }),
      }),
    };

    service = new PresignedUploadService(
      mockStorageRegistry as unknown as StorageRegistry,
      mockFileRepo as unknown as FileRepository,
      mockReplicaRepo as unknown as ReplicaRepository,
      mockUsageRepo as unknown as UsageRepository,
      mockOutboxRepo as unknown as OutboxRepository,
      mockPolicyRegistry as unknown as PolicyRegistry,
      mockAuthzService as unknown as AuthorizationService,
      mockConfigService as unknown as AppConfigService,
      mockDbService as unknown as DatabaseService,
    );
  });

  describe('initiate()', () => {
    it('creates presigned upload URL and inserts PENDING_UPLOAD record', async () => {
      const result = await service.initiate(defaultCtx, {
        filename: 'annual_fair.mp4',
        sizeBytes: 524288000,
        mimeType: 'video/mp4',
        branchId: 'branch-north',
        folder: 'media',
        visibility: 'tenant',
      });

      expect(result.fileId).toBeDefined();
      expect(result.uploadUrl).toBe(
        'https://s3.example.com/upload-target?sig=abc',
      );
      expect(result.requiredHeaders).toEqual({ 'Content-Type': 'video/mp4' });
      expect(result.expiresAt).toBeDefined();

      expect(mockUsageRepo.tryReserve).toHaveBeenCalledWith(
        'esma-tenant',
        'school-1',
        524288000n,
        1,
      );
      expect(mockSeaweedDriver.getPresignedUploadUrl).toHaveBeenCalled();
      expect(mockFileRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'PENDING_UPLOAD',
          originalFilename: 'annual_fair.mp4',
          mimetype: 'video/mp4',
          subTenantId: 'branch-north',
          sizeBytes: 524288000n,
        }),
      );
    });

    it('rejects with ForbiddenError when caller lacks branch grant', async () => {
      const unauthorizedCtx: RequestContext = {
        ...defaultCtx,
        actor: {
          ...defaultCtx.actor,
          branchGrants: ['branch-south'],
          isSchoolAdmin: false,
          isPlatformAdmin: false,
        },
      };

      await expect(
        service.initiate(unauthorizedCtx, {
          filename: 'test.mp4',
          sizeBytes: 1000,
          mimeType: 'video/mp4',
          branchId: 'branch-north',
        }),
      ).rejects.toThrow(ForbiddenError);

      expect(mockUsageRepo.tryReserve).not.toHaveBeenCalled();
    });

    it('rejects with UnsupportedMediaTypeError when mimeType is not in policy allowlist', async () => {
      await expect(
        service.initiate(defaultCtx, {
          filename: 'malicious.exe',
          sizeBytes: 1000,
          mimeType: 'application/x-msdownload',
        }),
      ).rejects.toThrow(UnsupportedMediaTypeError);

      expect(mockUsageRepo.tryReserve).not.toHaveBeenCalled();
    });

    it('rejects with PayloadTooLargeError when size exceeds policy maxFileSizeBytes', async () => {
      await expect(
        service.initiate(defaultCtx, {
          filename: 'huge_file.mp4',
          sizeBytes: 1024 * 1024 * 600, // 600 MiB (limit is 500 MiB)
          mimeType: 'video/mp4',
        }),
      ).rejects.toThrow(PayloadTooLargeError);

      expect(mockUsageRepo.tryReserve).not.toHaveBeenCalled();
    });

    it('rejects with PolicyViolationError when visibility is disallowed', async () => {
      mockPolicyRegistry.get.mockReturnValue({
        ...defaultPolicy,
        allowedVisibilities: ['tenant'],
      });

      await expect(
        service.initiate(defaultCtx, {
          filename: 'test.mp4',
          sizeBytes: 1000,
          mimeType: 'video/mp4',
          visibility: 'public',
        }),
      ).rejects.toThrow(PolicyViolationError);
    });

    it('rejects with QuotaExceededError and does not insert record when quota is full', async () => {
      mockUsageRepo.tryReserve.mockResolvedValue(false);

      await expect(
        service.initiate(defaultCtx, {
          filename: 'fair.mp4',
          sizeBytes: 524288000,
          mimeType: 'video/mp4',
        }),
      ).rejects.toThrow(QuotaExceededError);

      expect(mockFileRepo.insert).not.toHaveBeenCalled();
    });

    it('releases reserved quota if SeaweedFS presigning fails', async () => {
      mockSeaweedDriver.getPresignedUploadUrl.mockRejectedValue(
        new Error('S3 signature error'),
      );

      await expect(
        service.initiate(defaultCtx, {
          filename: 'fair.mp4',
          sizeBytes: 1000,
          mimeType: 'video/mp4',
        }),
      ).rejects.toThrow();

      expect(mockUsageRepo.release).toHaveBeenCalledWith(
        'esma-tenant',
        'school-1',
        1000n,
        1,
      );
    });

    it('releases reserved quota if DB insert fails', async () => {
      mockFileRepo.insert.mockRejectedValue(new Error('DB failure'));

      await expect(
        service.initiate(defaultCtx, {
          filename: 'fair.mp4',
          sizeBytes: 1000,
          mimeType: 'video/mp4',
        }),
      ).rejects.toThrow();

      expect(mockUsageRepo.release).toHaveBeenCalledWith(
        'esma-tenant',
        'school-1',
        1000n,
        1,
      );
    });

    it('throws StorageUnavailableError if SeaweedFS driver is unconfigured', async () => {
      mockSeaweedDriver.isConfigured.mockReturnValue(false);

      await expect(
        service.initiate(defaultCtx, {
          filename: 'fair.mp4',
          sizeBytes: 1000,
          mimeType: 'video/mp4',
        }),
      ).rejects.toThrow(StorageUnavailableError);
    });

    it('validates required fields', async () => {
      await expect(
        service.initiate(defaultCtx, {
          filename: '',
          sizeBytes: 1000,
          mimeType: 'video/mp4',
        }),
      ).rejects.toThrow(ValidationError);

      await expect(
        service.initiate(defaultCtx, {
          filename: 'test.mp4',
          sizeBytes: 0,
          mimeType: 'video/mp4',
        }),
      ).rejects.toThrow(ValidationError);

      await expect(
        service.initiate(defaultCtx, {
          filename: 'test.mp4',
          sizeBytes: 1000,
          mimeType: '',
        }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe('complete()', () => {
    it('confirms S3 existence, updates file to ACTIVE, enqueues outbox event, and returns manifest', async () => {
      mockFileRepo.findById.mockResolvedValue(pendingFile);

      const manifest = await service.complete(defaultCtx, pendingFile.id, {
        clientEtag: 'etag-client',
      });

      expect(manifest.success).toBe(true);
      expect(manifest.data.fileId).toBe(pendingFile.id);
      expect(manifest.data.filename).toBe('fair.mp4');
      expect(manifest.data.mimetype).toBe('video/mp4');

      expect(mockSeaweedDriver.stat).toHaveBeenCalledWith({
        provider: 'seaweedfs',
        key: pendingFile.storageKey,
      });

      expect(mockFileRepo.updateStatus).toHaveBeenCalledWith(
        pendingFile.id,
        1,
        expect.objectContaining({
          status: 'ACTIVE',
          sizeBytes: 524288000,
          expiresAt: null,
        }),
        expect.anything(),
      );

      expect(mockReplicaRepo.insertMany).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            fileId: pendingFile.id,
            provider: 'seaweedfs',
            role: 'primary',
            status: 'AVAILABLE',
            providerKey: pendingFile.storageKey,
          }),
        ],
        expect.anything(),
      );

      expect(mockOutboxRepo.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: 'file.uploaded',
          partitionKey: pendingFile.id,
          eventType: 'file.uploaded',
        }),
        expect.anything(),
      );
    });

    it('adjusts quota when actual object size exceeds reserved size', async () => {
      mockFileRepo.findById.mockResolvedValue({
        ...pendingFile,
        sizeBytes: 500000000n,
      });
      mockSeaweedDriver.stat.mockResolvedValue({
        size: 524288000, // 24288000 bytes larger
        etag: 'etag-1',
        contentType: 'video/mp4',
      });

      await service.complete(defaultCtx, pendingFile.id);

      expect(mockUsageRepo.tryReserve).toHaveBeenCalledWith(
        'esma-tenant',
        'school-1',
        24288000n,
        0,
        expect.anything(),
      );
    });

    it('adjusts quota when actual object size is smaller than reserved size', async () => {
      mockFileRepo.findById.mockResolvedValue({
        ...pendingFile,
        sizeBytes: 524288000n,
      });
      mockSeaweedDriver.stat.mockResolvedValue({
        size: 500000000, // 24288000 bytes smaller
        etag: 'etag-1',
        contentType: 'video/mp4',
      });

      await service.complete(defaultCtx, pendingFile.id);

      expect(mockUsageRepo.release).toHaveBeenCalledWith(
        'esma-tenant',
        'school-1',
        24288000n,
        0,
        expect.anything(),
      );
    });

    it('returns NotFoundError (404) on non-existent file', async () => {
      mockFileRepo.findById.mockResolvedValue(null);

      await expect(
        service.complete(defaultCtx, 'non-existent-id'),
      ).rejects.toThrow(NotFoundError);
    });

    it('returns NotFoundError (404) on cross-tenant access to preserve tenant isolation', async () => {
      mockFileRepo.findById.mockResolvedValue({
        ...pendingFile,
        tenantId: 'other-school',
      });

      await expect(
        service.complete(defaultCtx, pendingFile.id),
      ).rejects.toThrow(NotFoundError);
    });

    it('returns ForbiddenError when branch grant is missing on branch-scoped file', async () => {
      mockFileRepo.findById.mockResolvedValue(pendingFile);
      const otherBranchCtx: RequestContext = {
        ...defaultCtx,
        actor: {
          ...defaultCtx.actor,
          branchGrants: ['branch-south'],
          isSchoolAdmin: false,
          isPlatformAdmin: false,
        },
      };

      await expect(
        service.complete(otherBranchCtx, pendingFile.id),
      ).rejects.toThrow(ForbiddenError);
    });

    it('raises StorageUnavailableError and does not commit usage when S3 object does not exist', async () => {
      mockFileRepo.findById.mockResolvedValue(pendingFile);
      mockSeaweedDriver.stat.mockResolvedValue(null); // S3 object missing

      await expect(
        service.complete(defaultCtx, pendingFile.id),
      ).rejects.toThrow(StorageUnavailableError);

      expect(mockFileRepo.updateStatus).not.toHaveBeenCalled();
      expect(mockReplicaRepo.insertMany).not.toHaveBeenCalled();
      expect(mockOutboxRepo.enqueue).not.toHaveBeenCalled();
    });

    it('is idempotent when file is already ACTIVE', async () => {
      const activeFile: FileRecord = {
        ...pendingFile,
        status: 'ACTIVE',
      };
      mockFileRepo.findById.mockResolvedValue(activeFile);
      mockReplicaRepo.listByFile.mockResolvedValue([
        {
          fileId: activeFile.id,
          provider: 'seaweedfs',
          role: 'primary',
          status: 'AVAILABLE',
          providerKey: activeFile.storageKey,
          providerMeta: {},
          url: null,
          etag: 'etag-123',
          attempts: 1,
          lastError: null,
          syncedAt: new Date(),
          createdAt: new Date(),
        },
      ]);

      const manifest = await service.complete(defaultCtx, activeFile.id);

      expect(manifest.data.fileId).toBe(activeFile.id);
      expect(mockSeaweedDriver.stat).not.toHaveBeenCalled();
      expect(mockFileRepo.updateStatus).not.toHaveBeenCalled();
    });

    it('rejects with ConflictError when file is in invalid status like QUARANTINED', async () => {
      mockFileRepo.findById.mockResolvedValue({
        ...pendingFile,
        status: 'QUARANTINED',
      });

      await expect(
        service.complete(defaultCtx, pendingFile.id),
      ).rejects.toThrow(ConflictError);
    });
  });

  describe('sweepExpired()', () => {
    it('sweeps abandoned PENDING_UPLOAD files, deletes S3 key, releases quota, and marks DELETED', async () => {
      const expiredFile: FileRecord = {
        id: 'expired-file-1',
        namespace: 'esma-tenant',
        tenantId: 'school-1',
        subTenantId: 'branch-1',
        folder: 'tmp',
        storageKey: 'tenants/school-1/branches/branch-1/tmp/expired.mp4',
        originalFilename: 'expired.mp4',
        mimetype: 'video/mp4',
        declaredMimetype: 'video/mp4',
        sizeBytes: 1000000n,
        sha256: null,
        visibility: 'tenant',
        status: 'PENDING_UPLOAD',
        scanStatus: 'NOT_REQUIRED',
        replicationStatus: 'NOT_REQUIRED',
        primaryProvider: 'seaweedfs',
        uploadedBy: 'user-1',
        tags: [],
        attributes: {},
        legacyPublicId: null,
        idempotencyKey: null,
        correlationId: 'corr-sweep',
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        expiresAt: new Date(Date.now() - 1000000),
      };

      mockFileRepo.findExpiredPendingUploads.mockResolvedValue([expiredFile]);

      const result = await service.sweepExpired(300);

      expect(result.sweptCount).toBe(1);
      expect(mockSeaweedDriver.delete).toHaveBeenCalledWith({
        provider: 'seaweedfs',
        key: expiredFile.storageKey,
      });
      expect(mockUsageRepo.release).toHaveBeenCalledWith(
        'esma-tenant',
        'school-1',
        1000000n,
        1,
        expect.anything(),
      );
      expect(mockFileRepo.updateStatus).toHaveBeenCalledWith(
        expiredFile.id,
        expiredFile.version,
        { status: 'DELETED' },
        expect.anything(),
      );
    });
  });
});
