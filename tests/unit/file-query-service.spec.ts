import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FileQueryService } from '../../src/files/file-query.service.js';
import { AuthorizationService } from '../../src/authz/authorization.service.js';
import { AppConfigService } from '../../src/config/config.service.js';
import {
  ForbiddenError,
  NotFoundError,
} from '../../src/core/errors/app-error.js';
import type { RequestContext } from '../../src/core/request-context.js';
import type { FileRecord, FileReplica } from '../../src/core/types.js';
import type { FileRepository } from '../../src/db/repositories/file.repository.js';
import type { ReplicaRepository } from '../../src/db/repositories/replica.repository.js';

describe('FileQueryService [P2-08]', () => {
  let fileQueryService: FileQueryService;
  let authzService: AuthorizationService;
  let configService: AppConfigService;
  let mockFileRepo: {
    findById: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
  };
  let mockReplicaRepo: {
    listByFile: ReturnType<typeof vi.fn>;
  };

  let mockFiles: Map<string, FileRecord>;
  let mockReplicas: Map<string, FileReplica[]>;

  const mockContext: RequestContext = {
    namespace: 'esma-tenant',
    tenantId: 'school-123',
    subTenantId: 'branch-456',
    actor: {
      id: 'usr-1',
      type: 'user',
      roles: ['teacher'],
      scopes: ['files:read'],
    },
    correlationId: 'corr-query-123',
    ipAddress: '127.0.0.1',
    attributes: {},
  };

  function createMockFile(overrides: Partial<FileRecord> = {}): FileRecord {
    return {
      id: '0198f3a2-7c1e-7b40-9d2a-5e6f1a8c3b90',
      namespace: 'esma-tenant',
      tenantId: 'school-123',
      subTenantId: 'branch-456',
      folder: 'exams',
      storageKey: 'schools/school-123/branches/branch-456/exams/test.pdf',
      originalFilename: 'math_exam.pdf',
      mimetype: 'application/pdf',
      declaredMimetype: 'application/pdf',
      sizeBytes: 20480n,
      sha256: 'deadbeef123',
      visibility: 'tenant',
      status: 'ACTIVE',
      scanStatus: 'CLEAN',
      replicationStatus: 'NOT_REQUIRED',
      primaryProvider: 'local',
      uploadedBy: 'usr-1',
      tags: ['exam', 'math'],
      attributes: { year: '2026' },
      legacyPublicId: null,
      idempotencyKey: null,
      correlationId: 'corr-upload',
      version: 1,
      createdAt: new Date('2026-09-28T10:00:00.000Z'),
      updatedAt: new Date('2026-09-28T10:00:00.000Z'),
      deletedAt: null,
      ...overrides,
    };
  }

  function createMockReplica(
    overrides: Partial<FileReplica> = {},
  ): FileReplica {
    return {
      fileId: '0198f3a2-7c1e-7b40-9d2a-5e6f1a8c3b90',
      provider: 'local',
      role: 'primary',
      status: 'AVAILABLE',
      providerKey: 'schools/school-123/branches/branch-456/exams/test.pdf',
      providerMeta: {},
      url: null,
      etag: 'etag-abc',
      attempts: 0,
      lastError: null,
      syncedAt: new Date('2026-09-28T10:00:01.000Z'),
      createdAt: new Date('2026-09-28T10:00:00.000Z'),
      updatedAt: new Date('2026-09-28T10:00:01.000Z'),
      ...overrides,
    };
  }

  beforeEach(() => {
    mockFiles = new Map();
    mockReplicas = new Map();

    configService = {
      raw: {
        APP_BASE_URL: 'https://upload.esma.example',
      },
      get: () => configService.raw,
      appBaseUrl: 'https://upload.esma.example',
    } as unknown as AppConfigService;

    authzService = {
      authorize: vi.fn().mockReturnValue({
        allowed: true,
        reason: 'Authorized',
        ruleId: 'RULE_ALLOW',
      }),
      canAccessTenant: vi.fn().mockReturnValue(true),
    } as unknown as AuthorizationService;

    mockFileRepo = {
      findById: vi.fn().mockImplementation((id: string) => {
        return Promise.resolve(mockFiles.get(id) ?? null);
      }),
      list: vi.fn().mockResolvedValue({
        items: [],
        nextCursor: null,
        hasMore: false,
      }),
    };

    mockReplicaRepo = {
      listByFile: vi.fn().mockImplementation((fileId: string) => {
        return Promise.resolve(mockReplicas.get(fileId) ?? []);
      }),
    };

    fileQueryService = new FileQueryService(
      mockFileRepo as unknown as FileRepository,
      mockReplicaRepo as unknown as ReplicaRepository,
      authzService,
      configService,
    );
  });

  describe('list [P2-08]', () => {
    it('scopes listing strictly to caller namespace and tenant', async () => {
      await fileQueryService.list(mockContext, { folder: 'reports' });

      expect(mockFileRepo.list).toHaveBeenCalledWith(
        expect.objectContaining({
          namespace: 'esma-tenant',
          tenantId: 'school-123',
          subTenantId: 'branch-456',
          folder: 'reports',
        }),
        undefined,
        20,
      );
    });

    it('maps repository items to formatted FileSummary objects', async () => {
      const file = createMockFile();
      mockFileRepo.list.mockResolvedValueOnce({
        items: [file],
        nextCursor: 'cursor-token-123',
        hasMore: true,
      });

      const result = await fileQueryService.list(
        mockContext,
        {},
        'cursor-prev',
        10,
      );

      expect(result.total).toBe(1);
      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).toBe('cursor-token-123');
      expect(result.items[0]).toEqual({
        fileId: file.id,
        namespace: file.namespace,
        tenantId: file.tenantId,
        subTenantId: file.subTenantId,
        folder: file.folder,
        originalFilename: file.originalFilename,
        mimetype: file.mimetype,
        size: 20480,
        sha256: file.sha256,
        visibility: 'tenant',
        status: 'ACTIVE',
        primaryProvider: 'local',
        tags: ['exam', 'math'],
        canonicalUrl: `https://upload.esma.example/uploads/api/v1/files/${file.id}`,
        createdAt: '2026-09-28T10:00:00.000Z',
        updatedAt: '2026-09-28T10:00:00.000Z',
      });
    });

    it('passes tag filter as tags array when single tag is given', async () => {
      await fileQueryService.list(mockContext, { tag: 'invoice' });

      expect(mockFileRepo.list).toHaveBeenCalledWith(
        expect.objectContaining({
          tags: ['invoice'],
        }),
        undefined,
        20,
      );
    });
  });

  describe('getMetadata [P2-08]', () => {
    it('returns complete manifest matching ARCH §9.2 schema', async () => {
      const file = createMockFile();
      const replica = createMockReplica();
      mockFiles.set(file.id, file);
      mockReplicas.set(file.id, [replica]);

      const res = await fileQueryService.getMetadata(mockContext, file.id);

      expect(res.success).toBe(true);
      expect(res.message).toBe('File metadata retrieved successfully.');
      expect(res.data.fileId).toBe(file.id);
      expect(res.data.filename).toBe('math_exam.pdf');
      expect(res.data.size).toBe(20480);
      expect(res.data.canonicalUrl).toBe(
        `https://upload.esma.example/uploads/api/v1/files/${file.id}`,
      );
      expect(res.data.replicas.local).toEqual({
        status: 'AVAILABLE',
        syncedAt: '2026-09-28T10:00:01.000Z',
      });
    });

    it('throws NotFoundError when fileId does not exist', async () => {
      await expect(
        fileQueryService.getMetadata(mockContext, 'non-existent'),
      ).rejects.toThrow(NotFoundError);
    });

    it('throws NotFoundError when file status is DELETED or DELETING', async () => {
      const deletedFile = createMockFile({
        id: 'f-del',
        status: 'DELETED',
      });
      const deletingFile = createMockFile({
        id: 'f-deleting',
        status: 'DELETING',
      });
      mockFiles.set('f-del', deletedFile);
      mockFiles.set('f-deleting', deletingFile);

      await expect(
        fileQueryService.getMetadata(mockContext, 'f-del'),
      ).rejects.toThrow(NotFoundError);
      await expect(
        fileQueryService.getMetadata(mockContext, 'f-deleting'),
      ).rejects.toThrow(NotFoundError);
    });

    it('throws NotFoundError when cross-tenant access is attempted', async () => {
      const otherFile = createMockFile({
        id: 'f-other',
        tenantId: 'other-school',
      });
      mockFiles.set('f-other', otherFile);

      vi.spyOn(authzService, 'canAccessTenant').mockReturnValue(false);

      await expect(
        fileQueryService.getMetadata(mockContext, 'f-other'),
      ).rejects.toThrow(NotFoundError);
    });

    it('throws ForbiddenError when read action is denied by authz matrix', async () => {
      const file = createMockFile({ id: 'f-denied' });
      mockFiles.set('f-denied', file);

      vi.spyOn(authzService, 'authorize').mockReturnValue({
        allowed: false,
        reason: 'Private file cannot be read by student',
        ruleId: 'DENY_PRIVATE_READ',
      });

      await expect(
        fileQueryService.getMetadata(mockContext, 'f-denied'),
      ).rejects.toThrow(ForbiddenError);
    });
  });
});
