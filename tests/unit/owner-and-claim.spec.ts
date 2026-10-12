import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ClaimService } from '../../src/files/claim.service.js';
import { FileRepository } from '../../src/db/repositories/file.repository.js';
import { ReplicaRepository } from '../../src/db/repositories/replica.repository.js';
import { DatabaseService } from '../../src/db/database.service.js';
import { AppConfigService } from '../../src/config/config.service.js';
import { OutboxWriter } from '../../src/events/outbox-writer.js';
import { RequestContext } from '../../src/core/request-context.js';
import {
  AlreadyClaimedError,
  FileInfectedError,
  ForbiddenError,
  NotFoundError,
  ScanUnavailableError,
  ValidationError,
  NamespaceNotAllowedError,
  TooManyPendingUploadsError,
} from '../../src/core/errors/app-error.js';
import { FileRecord } from '../../src/core/types.js';
import { FileQueryService } from '../../src/files/file-query.service.js';
import { AuthorizationService } from '../../src/authz/authorization.service.js';
import { DeleteService } from '../../src/files/delete.service.js';

describe('UR-06, UR-29 & UR-30: Owner Attributes, Direct Upload, and Claim Flow', () => {
  let claimService: ClaimService;
  let mockFileRepo: Partial<FileRepository>;
  let mockReplicaRepo: Partial<ReplicaRepository>;
  let mockDbService: Partial<DatabaseService>;
  let mockConfigService: Partial<AppConfigService>;
  let mockOutboxWriter: Partial<OutboxWriter>;

  const serviceContext: RequestContext = {
    namespace: 'support-attachments',
    tenantId: 'tenant-school-1',
    actor: {
      type: 'service',
      id: 'support-service',
      roles: ['service'],
      scopes: ['files:read', 'files:write'],
    },
    correlationId: 'corr-claim-1',
    ipAddress: '127.0.0.1',
    attributes: {},
  };

  const userContext: RequestContext = {
    namespace: 'support-attachments',
    tenantId: 'tenant-school-1',
    actor: {
      type: 'user',
      id: 'user-uploader-1',
      roles: ['guardian'],
      scopes: ['files.file.upload'],
      permissions: ['files.file.upload'],
    },
    correlationId: 'corr-user-1',
    ipAddress: '127.0.0.1',
    attributes: {},
  };

  function createMockFile(overrides: Partial<FileRecord> = {}): FileRecord {
    return {
      id: '0198f3a2-7c1e-7b40-9d2a-5e6f1a8c0001',
      namespace: 'support-attachments',
      tenantId: 'tenant-school-1',
      subTenantId: null,
      folder: '',
      storageKey: 'tenant-school-1/support-attachments/0198f3a2.pdf',
      originalFilename: 'ticket_attachment.pdf',
      mimetype: 'application/pdf',
      declaredMimetype: 'application/pdf',
      sizeBytes: 1024n,
      sha256: 'abcd1234',
      visibility: 'private',
      status: 'ACTIVE',
      scanStatus: 'CLEAN',
      replicationStatus: 'NOT_REQUIRED',
      primaryProvider: 'local',
      uploadedBy: 'user-uploader-1',
      actingService: null,
      tags: [],
      attributes: {},
      derivatives: {},
      legacyPublicId: null,
      idempotencyKey: null,
      correlationId: 'corr-mock-1',
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      expiresAt: null,
      claimed: false,
      claimedAt: null,
      unclaimedExpiresAt: new Date(Date.now() + 86400000),
      ...overrides,
    };
  }

  beforeEach(() => {
    mockFileRepo = {
      findById: vi.fn(),
      updateStatus: vi.fn().mockImplementation((id, version, updates) => {
        return Promise.resolve(createMockFile({ ...updates, id, version: version + 1 }));
      }),
      findByOwner: vi.fn().mockResolvedValue([]),
      countUnclaimedForUser: vi.fn().mockResolvedValue({ count: 0, totalBytes: 0 }),
      findExpiredUnclaimed: vi.fn().mockResolvedValue([]),
    };

    mockReplicaRepo = {
      listByFile: vi.fn().mockResolvedValue([]),
    };

    mockDbService = {
      getDb: vi.fn().mockReturnValue(null), // single-driver/non-tx fallback
    };

    mockConfigService = {
      get: vi.fn().mockReturnValue({
        APP_BASE_URL: 'https://upload.esma.example/uploads',
      } as any),
      eventsEnabled: true,
      unclaimedTtlHours: 24,
      unclaimedMaxFilesPerUser: 50,
      unclaimedMaxBytesPerUser: 524288000,
    };

    mockOutboxWriter = {
      enqueue: vi.fn().mockResolvedValue({} as any),
    };

    claimService = new ClaimService(
      mockFileRepo as FileRepository,
      mockReplicaRepo as ReplicaRepository,
      mockDbService as DatabaseService,
      mockConfigService as AppConfigService,
      mockOutboxWriter as OutboxWriter,
    );
  });

  describe('UR-30: Claim Service Contract', () => {
    it('rejects claim attempts made by user principals with 403 Forbidden', async () => {
      await expect(
        claimService.claim(userContext, '0198f3a2-7c1e-7b40-9d2a-5e6f1a8c0001', {
          ownerType: 'SUPPORT_TICKET',
          ownerId: 'ticket-123',
        }),
      ).rejects.toThrow(ForbiddenError);
    });

    it('rejects claim when ownerType or ownerId is missing with ValidationError', async () => {
      await expect(
        claimService.claim(serviceContext, '0198f3a2-7c1e-7b40-9d2a-5e6f1a8c0001', {
          ownerType: '',
          ownerId: 'ticket-123',
        }),
      ).rejects.toThrow(ValidationError);
    });

    it('returns 404 NotFoundError when file does not exist or belongs to another tenant', async () => {
      mockFileRepo.findById = vi.fn().mockResolvedValue(null);

      await expect(
        claimService.claim(serviceContext, 'f-missing', {
          ownerType: 'SUPPORT_TICKET',
          ownerId: 'ticket-123',
        }),
      ).rejects.toThrow(NotFoundError);

      // File of another tenant
      mockFileRepo.findById = vi.fn().mockResolvedValue(
        createMockFile({ tenantId: 'other-school' }),
      );

      await expect(
        claimService.claim(serviceContext, 'f-other', {
          ownerType: 'SUPPORT_TICKET',
          ownerId: 'ticket-123',
        }),
      ).rejects.toThrow(NotFoundError);
    });

    it('rejects claiming infected files with 422 FileInfectedError', async () => {
      mockFileRepo.findById = vi.fn().mockResolvedValue(
        createMockFile({ scanStatus: 'INFECTED' }),
      );

      await expect(
        claimService.claim(serviceContext, 'f-infected', {
          ownerType: 'SUPPORT_TICKET',
          ownerId: 'ticket-123',
        }),
      ).rejects.toThrow(FileInfectedError);
    });

    it('rejects claiming files where virus scan failed with 503 ScanUnavailableError', async () => {
      mockFileRepo.findById = vi.fn().mockResolvedValue(
        createMockFile({ scanStatus: 'ERROR' }),
      );

      await expect(
        claimService.claim(serviceContext, 'f-error', {
          ownerType: 'SUPPORT_TICKET',
          ownerId: 'ticket-123',
        }),
      ).rejects.toThrow(ScanUnavailableError);
    });

    it('allows claiming PENDING files and transitions claimed=true, clearing unclaimed expiry', async () => {
      const pendingFile = createMockFile({
        scanStatus: 'PENDING',
        claimed: false,
        unclaimedExpiresAt: new Date(Date.now() + 86400000),
      });
      mockFileRepo.findById = vi.fn().mockResolvedValue(pendingFile);

      const res = await claimService.claim(serviceContext, pendingFile.id, {
        ownerType: 'SUPPORT_TICKET',
        ownerId: 'ticket-999',
        kind: 'attachment',
      });

      expect(res.data.claimed).toBe(true);
      expect(res.data.attributes).toMatchObject({
        ownerType: 'SUPPORT_TICKET',
        ownerId: 'ticket-999',
        kind: 'attachment',
      });
      expect(mockFileRepo.updateStatus).toHaveBeenCalledWith(
        pendingFile.id,
        pendingFile.version,
        expect.objectContaining({
          claimed: true,
          unclaimedExpiresAt: null,
          attributes: expect.objectContaining({
            ownerType: 'SUPPORT_TICKET',
            ownerId: 'ticket-999',
            kind: 'attachment',
          }),
        }),
      );
    });

    it('is idempotent when claiming the same file for the exact same owner', async () => {
      const alreadyClaimedFile = createMockFile({
        claimed: true,
        claimedAt: new Date(),
        attributes: {
          ownerType: 'SUPPORT_TICKET',
          ownerId: 'ticket-100',
          kind: 'attachment',
        },
      });
      mockFileRepo.findById = vi.fn().mockResolvedValue(alreadyClaimedFile);

      const res = await claimService.claim(serviceContext, alreadyClaimedFile.id, {
        ownerType: 'SUPPORT_TICKET',
        ownerId: 'ticket-100',
        kind: 'attachment',
      });

      expect(res.data.claimed).toBe(true);
      // updateStatus should not be re-called when already matching
      expect(mockFileRepo.updateStatus).not.toHaveBeenCalled();
    });

    it('throws 409 AlreadyClaimedError when claiming for a different owner', async () => {
      const alreadyClaimedFile = createMockFile({
        claimed: true,
        attributes: {
          ownerType: 'SUPPORT_TICKET',
          ownerId: 'ticket-100',
          kind: 'attachment',
        },
      });
      mockFileRepo.findById = vi.fn().mockResolvedValue(alreadyClaimedFile);

      await expect(
        claimService.claim(serviceContext, alreadyClaimedFile.id, {
          ownerType: 'SUPPORT_TICKET',
          ownerId: 'ticket-DIFFERENT',
          kind: 'attachment',
        }),
      ).rejects.toThrow(AlreadyClaimedError);
    });
  });

  describe('UR-29: Direct Browser Upload & Unclaimed File Access', () => {
    let fileQueryService: FileQueryService;
    let authzService: AuthorizationService;

    beforeEach(() => {
      authzService = new AuthorizationService(mockConfigService as AppConfigService);
      fileQueryService = new FileQueryService(
        mockFileRepo as FileRepository,
        mockReplicaRepo as ReplicaRepository,
        authzService,
        mockConfigService as AppConfigService,
      );
    });

    it('allows uploader to view own unclaimed file metadata (polling) without read permissions', async () => {
      const unclaimedFile = createMockFile({
        claimed: false,
        uploadedBy: 'user-uploader-1',
        scanStatus: 'PENDING',
      });
      mockFileRepo.findById = vi.fn().mockResolvedValue(unclaimedFile);

      // Caller has no read permissions
      const res = await fileQueryService.getMetadata(userContext, unclaimedFile.id);
      expect(res.data.fileId).toBe(unclaimedFile.id);
      expect(res.data.scanStatus).toBe('PENDING');
      expect(res.data.claimed).toBe(false);
    });

    it('returns 404 NotFoundError when a different user in the same organization views unclaimed file metadata', async () => {
      const unclaimedFile = createMockFile({
        claimed: false,
        uploadedBy: 'user-uploader-1',
      });
      mockFileRepo.findById = vi.fn().mockResolvedValue(unclaimedFile);

      const otherUserContext: RequestContext = {
        ...userContext,
        actor: {
          ...userContext.actor,
          id: 'user-other-person-2',
        },
      };

      await expect(
        fileQueryService.getMetadata(otherUserContext, unclaimedFile.id),
      ).rejects.toThrow(NotFoundError);
    });

    it('allows service principals to view unclaimed metadata', async () => {
      const unclaimedFile = createMockFile({
        claimed: false,
        uploadedBy: 'user-uploader-1',
      });
      mockFileRepo.findById = vi.fn().mockResolvedValue(unclaimedFile);

      const res = await fileQueryService.getMetadata(serviceContext, unclaimedFile.id);
      expect(res.data.fileId).toBe(unclaimedFile.id);
    });
  });

  describe('UR-06: Owner Attributes Bulk Delete', () => {
    let deleteService: DeleteService;

    beforeEach(() => {
      const authzService = new AuthorizationService(mockConfigService as AppConfigService);
      deleteService = new DeleteService(
        {} as any,
        authzService,
        mockConfigService as AppConfigService,
        mockDbService as DatabaseService,
        mockFileRepo as FileRepository,
        mockReplicaRepo as ReplicaRepository,
        {} as any,
        {} as any,
        mockOutboxWriter as OutboxWriter,
      );
      // Stub delete single
      vi.spyOn(deleteService, 'delete').mockResolvedValue();
    });

    it('rejects deleteByOwner when ownerType or ownerId is missing with ValidationError', async () => {
      await expect(
        deleteService.deleteByOwner(serviceContext, '', 'T1'),
      ).rejects.toThrow(ValidationError);

      await expect(
        deleteService.deleteByOwner(serviceContext, 'SUPPORT_TICKET', ''),
      ).rejects.toThrow(ValidationError);
    });

    it('finds and deletes all matching files for the owner in the tenant', async () => {
      const file1 = createMockFile({ id: 'f-1' });
      const file2 = createMockFile({ id: 'f-2' });
      mockFileRepo.findByOwner = vi.fn().mockResolvedValue([file1, file2]);

      const res = await deleteService.deleteByOwner(
        serviceContext,
        'SUPPORT_TICKET',
        'T1',
        'support-attachments',
      );

      expect(res.deleted).toBe(2);
      expect(mockFileRepo.findByOwner).toHaveBeenCalledWith(
        'tenant-school-1',
        'SUPPORT_TICKET',
        'T1',
        'support-attachments',
        1000,
      );
      expect(deleteService.delete).toHaveBeenCalledTimes(2);
    });
  });
});
