import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { TenantPurgeService, PURGE_COMPLETED_TOPIC } from '../../src/workers/tenant-purge.service.js';
import { TenantExportService, EXPORT_COMPLETED_TOPIC } from '../../src/workers/tenant-export.service.js';
import { buildZipArchive } from '../../src/workers/zip-builder.js';
import { TenantQuotaService } from '../../src/admin/tenant-quota.service.js';
import { TenantUsageReconciler } from '../../src/admin/tenant-usage-reconciler.service.js';
import { DeleteService } from '../../src/files/delete.service.js';
import { FileReadService } from '../../src/files/file-read.service.js';
import { TenantPurgingError, ForbiddenError } from '../../src/core/errors/app-error.js';
import type { RequestContext } from '../../src/core/request-context.js';

describe('M3 Lifecycle Operations & Hardening (UR-18 through UR-23)', () => {
  describe('UR-18: Tenant Purge Orchestrator', () => {
    let purgeService: TenantPurgeService;
    let mockDbService: any;
    let mockStorageRegistry: any;
    let mockOutboxRepo: any;
    let mockAuditService: any;
    let mockDriver: any;

    beforeEach(() => {
      mockDriver = {
        name: 'seaweedfs',
        delete: vi.fn().mockResolvedValue(undefined),
      };

      mockStorageRegistry = {
        get: vi.fn().mockReturnValue(mockDriver),
      };

      mockOutboxRepo = {
        enqueue: vi.fn().mockResolvedValue(undefined),
      };

      mockAuditService = {
        log: vi.fn().mockResolvedValue(undefined),
      };

      mockDbService = {
        getDb: vi.fn(),
      };

      purgeService = new TenantPurgeService(
        mockDbService,
        mockStorageRegistry,
        mockOutboxRepo,
        mockAuditService,
      );
    });

    it('should skip purge if owners filter is present and does not include "files"', async () => {
      const receipt = await purgeService.purgeTenant({
        requestId: 'req-skip-1',
        organizationId: 'org-1',
        requestedAt: new Date().toISOString(),
        owners: ['database', 'logs'],
      });

      expect(receipt.status).toBe('SKIPPED');
      expect(receipt.counts.files).toBe(0);
      expect(mockOutboxRepo.enqueue).not.toHaveBeenCalled();
    });

    it('should refuse purge when files are under legal hold (UR-18.2)', async () => {
      const mockDb = {
        getExecutor: vi.fn().mockReturnValue({
          transformQuery: (q: any) => q,
          compileQuery: (q: any) => ({ sql: '', parameters: [] }),
          executeQuery: vi.fn().mockResolvedValue({
            rows: [{ count: '3' }], // 3 held files
          }),
        }),
      };
      mockDbService.getDb.mockReturnValue(mockDb);

      const receipt = await purgeService.purgeTenant({
        requestId: 'req-held-1',
        organizationId: 'org-held',
        requestedAt: new Date().toISOString(),
        owners: ['files'],
      });

      expect(receipt.status).toBe('REFUSED');
      expect(receipt.reason).toBe('LEGAL_HOLD');
      expect(mockOutboxRepo.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: PURGE_COMPLETED_TOPIC,
          partitionKey: 'org-held',
          envelope: expect.objectContaining({
            status: 'REFUSED',
            reason: 'LEGAL_HOLD',
          }),
        }),
      );
    });

    it('should purge files, remove replicas, write TENANT_PURGED audit, and emit completed receipt (UR-18.3, UR-18.4)', async () => {
      const file1Id = '01920000-0000-7000-8000-000000000001';
      const file2Id = '01920000-0000-7000-8000-000000000002';

      let callIndex = 0;
      const mockDb: any = {
        getExecutor: vi.fn().mockReturnValue({
          transformQuery: (q: any) => q,
          compileQuery: (q: any) => ({ sql: '', parameters: [] }),
          executeQuery: vi.fn().mockImplementation(async () => {
            callIndex++;
            if (callIndex === 1) {
              // 1. Legal hold count query -> 0
              return { rows: [{ count: '0' }] };
            } else if (callIndex === 2) {
              // 2. Set is_purging = true query
              return { rows: [] };
            } else if (callIndex === 3) {
              // 3. Query all files
              return {
                rows: [
                  { id: file1Id, size_bytes: '1000', namespace: 'student-documents' },
                  { id: file2Id, size_bytes: '2500', namespace: 'support-attachments' },
                ],
              };
            } else if (callIndex === 4) {
              // 4. Query replicas for batch
              return {
                rows: [
                  { id: 'rep-1', file_id: file1Id, provider: 'seaweedfs', provider_key: 'k1' },
                  { id: 'rep-2', file_id: file2Id, provider: 'seaweedfs', provider_key: 'k2' },
                ],
              };
            }
            return { rows: [] };
          }),
        }),
        transaction: vi.fn().mockReturnValue({
          execute: vi.fn().mockImplementation(async (cb) => {
            const trxMock = {
              getExecutor: vi.fn().mockReturnValue({
                transformQuery: (q: any) => q,
                compileQuery: (q: any) => ({ sql: '', parameters: [] }),
                executeQuery: vi.fn().mockResolvedValue({ rows: [] }),
              }),
            };
            return cb(trxMock);
          }),
        }),
      };
      mockDbService.getDb.mockReturnValue(mockDb);

      const receipt = await purgeService.purgeTenant({
        requestId: 'req-purge-success',
        organizationId: 'org-clean',
        requestedAt: new Date().toISOString(),
        owners: ['files'],
      });

      expect(receipt.status).toBe('COMPLETED');
      expect(receipt.counts.files).toBe(2);
      expect(receipt.counts.bytes).toBe(3500);
      expect(receipt.counts.replicas).toBe(2);

      // Verify checksum is deterministic sorted fileIds sha256
      const expectedHash = crypto
        .createHash('sha256')
        .update([file1Id, file2Id].sort().join('\n'))
        .digest('hex');
      expect(receipt.checksum).toBe(`sha256:${expectedHash}`);

      // Verify replicas were deleted from storage driver
      expect(mockDriver.delete).toHaveBeenCalledTimes(2);

      // Verify audit row TENANT_PURGED was written
      expect(mockAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'TENANT_PURGED',
          outcome: 'SUCCESS',
          tenantId: 'org-clean',
        }),
      );

      // Verify receipt was published to outbox
      expect(mockOutboxRepo.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: PURGE_COMPLETED_TOPIC,
          partitionKey: 'org-clean',
          envelope: expect.objectContaining({
            status: 'COMPLETED',
            checksum: `sha256:${expectedHash}`,
          }),
        }),
      );
    });
  });

  describe('UR-19: Tenant Export Worker & ZIP Bundle Builder', () => {
    it('should build a valid PKWARE ZIP archive using buildZipArchive', () => {
      const fileData = Buffer.from('hello world from tenant export file', 'utf8');
      const manifestData = Buffer.from('{"fileId":"f1","path":"files/doc.txt"}\n', 'utf8');

      const zipBuffer = buildZipArchive([
        { path: 'manifest.jsonl', data: manifestData },
        { path: 'files/test/doc.txt', data: fileData },
      ]);

      expect(zipBuffer).toBeInstanceOf(Buffer);
      expect(zipBuffer.length).toBeGreaterThan(0);
      // Valid ZIP files start with PK\x03\x04 signature
      expect(zipBuffer.readUInt32LE(0)).toBe(0x04034b50);
    });

    it('should export non-infected files, store ZIP in tenant-exports, emit domain event and receipt (UR-19)', async () => {
      const mockDriver = {
        name: 'seaweedfs',
        downloadStream: vi.fn().mockResolvedValue({
          stream: Readable.from([Buffer.from('export-test-content')]),
        }),
        upload: vi.fn().mockResolvedValue({ ref: { provider: 'seaweedfs', key: 'key.zip' } }),
      };

      const mockStorageRegistry: any = {
        get: vi.fn().mockReturnValue(mockDriver),
      };

      const mockOutboxRepo: any = {
        enqueue: vi.fn().mockResolvedValue(undefined),
      };

      const mockDomainEventPublisher: any = {
        publish: vi.fn().mockResolvedValue(undefined),
      };

      const mockFileRepo: any = {
        insert: vi.fn().mockResolvedValue(undefined),
      };

      const mockReplicaRepo: any = {
        insertMany: vi.fn().mockResolvedValue([]),
      };

      const mockDb: any = {
        getExecutor: vi.fn().mockReturnValue({
          transformQuery: (q: any) => q,
          compileQuery: (q: any) => ({ sql: '', parameters: [] }),
          executeQuery: vi.fn().mockResolvedValue({
            rows: [
              {
                id: 'file-export-1',
                namespace: 'student-documents',
                original_filename: 'report.pdf',
                mimetype: 'application/pdf',
                size_bytes: '19',
                sha256: 'abc123sha',
                attributes: { ownerType: 'STUDENT', ownerId: 'S1' },
                created_at: new Date().toISOString(),
                storage_key: 'org/student-documents/2026/10/file-export-1.pdf',
                primary_provider: 'seaweedfs',
              },
            ],
          }),
        }),
      };

      const mockDbService: any = {
        getDb: vi.fn().mockReturnValue(mockDb),
      };

      const exportService = new TenantExportService(
        mockDbService,
        mockStorageRegistry,
        mockOutboxRepo,
        mockDomainEventPublisher,
        mockFileRepo,
        mockReplicaRepo,
      );

      const receipt = await exportService.exportTenant({
        requestId: 'req-export-1',
        organizationId: 'org-export',
        requestedAt: new Date().toISOString(),
      });

      expect(receipt.status).toBe('COMPLETED');
      expect(receipt.counts.files).toBe(1);
      expect(receipt.bundleFileId).toBeDefined();

      // Verify bundle was written to storage driver
      expect(mockDriver.upload).toHaveBeenCalledWith(
        expect.objectContaining({
          mimetype: 'application/zip',
          visibility: 'private',
        }),
      );

      // Verify bundle file record saved in tenant-exports namespace
      expect(mockFileRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          namespace: 'tenant-exports',
          tenantId: 'org-export',
          mimetype: 'application/zip',
          claimed: true,
          retainUntil: expect.any(Date),
        }),
      );

      // Verify files.tenant.exported.v1 public domain event was emitted
      expect(mockDomainEventPublisher.publish).toHaveBeenCalledWith(
        null,
        expect.objectContaining({
          eventType: 'files.tenant.exported.v1',
          organizationId: 'org-export',
          data: expect.objectContaining({
            requestId: 'req-export-1',
            files: 1,
          }),
        }),
      );

      // Verify completion receipt published on esma.platform.tenant-export-completed.v1
      expect(mockOutboxRepo.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: EXPORT_COMPLETED_TOPIC,
          partitionKey: 'org-export',
          envelope: expect.objectContaining({
            status: 'COMPLETED',
            bundleFileId: receipt.bundleFileId,
          }),
        }),
      );
    });
  });

  describe('UR-18.5 & UR-21: Quota & Purge Gate Hardening', () => {
    let quotaService: TenantQuotaService;
    let mockDbService: any;
    let mockConfigService: any;
    let mockDomainEventPublisher: any;
    let mockAuditService: any;

    beforeEach(() => {
      mockDbService = { getDb: vi.fn() };
      mockConfigService = { defaultTenantQuotaBytes: 1073741824 };
      mockDomainEventPublisher = { publish: vi.fn() };
      mockAuditService = { log: vi.fn() };

      quotaService = new TenantQuotaService(
        mockDbService,
        mockConfigService,
        mockDomainEventPublisher,
        mockAuditService,
      );
    });

    it('should refuse uploads with 403 tenant_purging when tenant is undergoing purge (UR-18.5)', async () => {
      vi.spyOn(quotaService, 'getEffectiveQuota').mockResolvedValue({
        tenantId: 'org-purging',
        effectiveQuotaBytes: 1073741824,
        planQuotaBytes: 1073741824,
        overrideQuotaBytes: null,
        overrideReason: null,
        overrideExpiresAt: null,
        isSuspended: false,
        isPurging: true, // Organization is currently purging!
        usedBytes: 100,
      });

      const ctx: RequestContext = {
        tenantId: 'org-purging',
        namespace: 'student-documents',
        actor: { type: 'user', id: 'u1', roles: [], scopes: [] },
        correlationId: 'corr-1',
        ipAddress: '127.0.0.1',
        attributes: {},
      };

      await expect(
        quotaService.checkUploadQuota('org-purging', 500, ctx),
      ).rejects.toThrow(TenantPurgingError);
    });

    it('should exempt platform-archives namespace from quota checks (UR-21)', async () => {
      const getQuotaSpy = vi.spyOn(quotaService, 'getEffectiveQuota');

      const ctx: RequestContext = {
        tenantId: 'org-platform',
        namespace: 'platform-archives',
        actor: { type: 'service', id: 'srv-1', actingService: 'platform', roles: [], scopes: [] },
        correlationId: 'corr-2',
        ipAddress: '127.0.0.1',
        attributes: {},
      };

      // Uploading 10 GB into platform-archives
      await quotaService.checkUploadQuota('org-platform', 10 * 1024 * 1024 * 1024, ctx);

      // getEffectiveQuota was never called because platform-archives is exempt
      expect(getQuotaSpy).not.toHaveBeenCalled();
    });
  });

  describe('UR-21: Platform Archives Namespace Delete Authorization', () => {
    let deleteService: DeleteService;
    let mockFileRepo: any;
    let mockAuthzService: any;

    beforeEach(() => {
      mockFileRepo = {
        findById: vi.fn(),
      };
      mockAuthzService = {
        canAccessTenant: vi.fn().mockReturnValue(true),
        authorize: vi.fn().mockReturnValue({ allowed: true }),
      };

      deleteService = new DeleteService(
        {} as any,
        mockAuthzService,
        {} as any,
        {} as any,
        mockFileRepo,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );
    });

    it('should refuse deletion of platform-archives file without platform.files.admin permission (UR-21)', async () => {
      mockFileRepo.findById.mockResolvedValue({
        id: 'file-arch-1',
        tenantId: 'org-platform',
        namespace: 'platform-archives',
        status: 'ACTIVE',
        held: false,
      });

      const ctxWithoutPerm: RequestContext = {
        tenantId: 'org-platform',
        namespace: 'platform-archives',
        actor: {
          type: 'service',
          id: 'srv-1',
          permissions: ['files.file.delete', 'files.file.read'],
          roles: [],
          scopes: [],
        },
        correlationId: 'corr-3',
        ipAddress: '127.0.0.1',
        attributes: {},
      };

      await expect(
        deleteService.delete(ctxWithoutPerm, 'file-arch-1'),
      ).rejects.toThrow(ForbiddenError);
    });

    it('should permit deletion of platform-archives file when platform.files.admin permission is held (UR-21)', async () => {
      mockFileRepo.findById.mockResolvedValue({
        id: 'file-arch-2',
        tenantId: 'org-platform',
        namespace: 'platform-archives',
        status: 'DELETED', // already deleted so it returns early after authz
        held: false,
      });

      const ctxWithAdmin: RequestContext = {
        tenantId: 'org-platform',
        namespace: 'platform-archives',
        actor: {
          type: 'service',
          id: 'srv-admin',
          permissions: ['platform.files.admin'],
          roles: [],
          scopes: [],
        },
        correlationId: 'corr-4',
        ipAddress: '127.0.0.1',
        attributes: {},
      };

      await expect(
        deleteService.delete(ctxWithAdmin, 'file-arch-2'),
      ).resolves.toBeUndefined();
    });
  });

  describe('UR-12 & UR-23: Usage & Egress Metering', () => {
    it('should format storage.bytes, storage.files, and storage.egress.bytes events to exact UR-12 & UR-23 specs', async () => {
      const mockOutboxRepo: any = {
        enqueue: vi.fn().mockResolvedValue(undefined),
      };

      let queryCall = 0;
      const mockDb: any = {
        getExecutor: vi.fn().mockReturnValue({
          transformQuery: (q: any) => q,
          compileQuery: (q: any) => ({ sql: '', parameters: [] }),
          executeQuery: vi.fn().mockImplementation(async () => {
            queryCall++;
            if (queryCall === 1) {
              // activeStats
              return {
                rows: [
                  { tenant_id: 'org-usage-1', active_bytes: '5000000', active_files: '12' },
                ],
              };
            } else if (queryCall === 2) {
              // tenant_daily_egress
              return {
                rows: [{ bytes_served: '250000' }],
              };
            }
            return { rows: [] };
          }),
        }),
        selectFrom: vi.fn().mockReturnValue({
          selectAll: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              execute: vi.fn().mockResolvedValue([
                { bytes_used: 5000000, file_count: 12 },
              ]),
            }),
          }),
        }),
      };

      const mockDbService: any = {
        getDb: vi.fn().mockReturnValue(mockDb),
      };

      const reconciler = new TenantUsageReconciler(mockDbService, mockOutboxRepo);

      const targetDate = new Date('2026-10-15T01:00:00Z');
      const result = await reconciler.runDailyReconciliation(targetDate);

      expect(result.organizationsProcessed).toBe(1);
      expect(result.eventsEmitted).toBe(3); // bytes, files, and egress

      // Verify storage.bytes event envelope
      expect(mockOutboxRepo.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: 'esma.platform.usage.v1',
          partitionKey: 'org-usage-1',
          envelope: expect.objectContaining({
            eventType: 'USAGE_REPORTED',
            organizationId: 'org-usage-1',
            usageDate: '2026-10-14',
            meter: 'storage.bytes',
            aggregation: 'LAST',
            quantity: 5000000,
            unit: 'bytes',
            source: 'esma-upload-service',
          }),
        }),
      );

      // Verify storage.files event envelope
      expect(mockOutboxRepo.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: 'esma.platform.usage.v1',
          partitionKey: 'org-usage-1',
          envelope: expect.objectContaining({
            eventType: 'USAGE_REPORTED',
            organizationId: 'org-usage-1',
            usageDate: '2026-10-14',
            meter: 'storage.files',
            aggregation: 'LAST',
            quantity: 12,
            unit: 'files',
            source: 'esma-upload-service',
          }),
        }),
      );

      // Verify storage.egress.bytes event envelope (UR-23)
      expect(mockOutboxRepo.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: 'esma.platform.usage.v1',
          partitionKey: 'org-usage-1',
          envelope: expect.objectContaining({
            eventType: 'USAGE_REPORTED',
            organizationId: 'org-usage-1',
            usageDate: '2026-10-14',
            meter: 'storage.egress.bytes',
            aggregation: 'SUM',
            quantity: 250000,
            unit: 'bytes',
            source: 'esma-upload-service',
          }),
        }),
      );
    });
  });
});
