import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { RevocationService } from '../../src/auth/revocation.service.js';
import { TenantQuotaService } from '../../src/admin/tenant-quota.service.js';
import { DomainEventPublisher } from '../../src/events/domain-event.publisher.js';
import { sanitizeSvgFile } from '../../src/ingest/sanitize.js';
import {
  TokenRevokedError,
  TokenStaleError,
  TenantSuspendedError,
  QuotaExceededError,
  LegalHoldError,
  ValidationError,
  UnauthenticatedError,
} from '../../src/core/errors/app-error.js';
import { RequestContext } from '../../src/core/request-context.js';
import { DeleteService } from '../../src/files/delete.service.js';

function createMockKysely(
  handler: (sqlText: string) => any[],
) {
  return {
    getExecutor: () => ({
      executeQuery: async (compiled: { sql: string; parameters: any[] }) => {
        return {
          rows: handler(compiled.sql),
        };
      },
    }),
  };
}

describe('M2 Platform Requirements: UR-09 to UR-17', () => {
  describe('UR-09: Token Revocation & Permission Versioning', () => {
    let revocationService: RevocationService;
    let mockRedisClient: any;
    let mockRedisService: any;
    let mockMetrics: any;

    beforeEach(() => {
      mockRedisClient = {
        get: vi.fn(),
      };
      mockRedisService = {
        isReady: vi.fn().mockReturnValue(true),
        getClient: vi.fn().mockReturnValue(mockRedisClient),
      };
      mockMetrics = {
        revocationRedisUnavailableTotal: {
          inc: vi.fn(),
        },
      };
      revocationService = new RevocationService(
        mockRedisService as any,
        mockMetrics as any,
      );
    });

    it('passes verification when session is valid and version is fresh', async () => {
      mockRedisClient.get.mockImplementation(async (key: string) => {
        if (key === 'esma:revoked:sid:sess-123') return null;
        if (key === 'esma:org-permission-version:org-100') return '2';
        return null;
      });

      await expect(
        revocationService.checkRevocation(
          { sid: 'sess-123', organizationId: 'org-100', permissionVersion: 2 } as any,
          'GET',
        ),
      ).resolves.toBeUndefined();
    });

    it('rejects with TokenRevokedError (401 token_revoked) when sid is in revocation store', async () => {
      mockRedisClient.get.mockImplementation(async (key: string) => {
        if (key === 'esma:revoked:sid:sess-revoked') return '1';
        return null;
      });

      await expect(
        revocationService.checkRevocation(
          { sid: 'sess-revoked', organizationId: 'org-100', permissionVersion: 2 } as any,
          'GET',
        ),
      ).rejects.toThrow(TokenRevokedError);
    });

    it('rejects with TokenStaleError (401 token_stale) when token permissionVersion < current org version', async () => {
      mockRedisClient.get.mockImplementation(async (key: string) => {
        if (key === 'esma:org-permission-version:org-100') return '5';
        return null;
      });

      await expect(
        revocationService.checkRevocation(
          { sid: 'sess-fresh', organizationId: 'org-100', permissionVersion: 3 } as any,
          'POST',
        ),
      ).rejects.toThrow(TokenStaleError);
    });

    it('fails open for read requests (GET) when Redis is unavailable and records metric', async () => {
      mockRedisService.isReady.mockReturnValue(false);
      mockRedisService.getClient.mockReturnValue(null);

      await expect(
        revocationService.checkRevocation(
          { sid: 'sess-123', organizationId: 'org-100', permissionVersion: 2 } as any,
          'GET',
        ),
      ).resolves.toBeUndefined();

      expect(mockMetrics.revocationRedisUnavailableTotal.inc).toHaveBeenCalled();
    });

    it('fails closed for mutations (POST) when Redis is unavailable and records metric', async () => {
      mockRedisService.isReady.mockReturnValue(false);
      mockRedisService.getClient.mockReturnValue(null);

      await expect(
        revocationService.checkRevocation(
          { sid: 'sess-123', organizationId: 'org-100', permissionVersion: 2 } as any,
          'POST',
        ),
      ).rejects.toThrow(UnauthenticatedError);

      expect(mockMetrics.revocationRedisUnavailableTotal.inc).toHaveBeenCalled();
    });
  });

  describe('UR-13: Commercial Quota Gate & Suspension', () => {
    let quotaService: TenantQuotaService;
    let mockDbService: any;
    let mockOutboxWriter: any;
    let mockDomainPublisher: any;

    beforeEach(() => {
      mockOutboxWriter = { enqueue: vi.fn().mockResolvedValue(undefined) };
      mockDomainPublisher = { publish: vi.fn().mockResolvedValue({}) };
    });

    it('throws TenantSuspendedError (403 tenant_suspended) when tenant is suspended', async () => {
      mockDbService = { getDb: () => ({}) };
      quotaService = new TenantQuotaService(
        mockDbService as any,
        {} as any,
        mockDomainPublisher as any,
        {} as any,
      );

      vi.spyOn(quotaService, 'getEffectiveQuota').mockResolvedValue({
        tenantId: 'org-suspended',
        effectiveQuotaBytes: 100000000,
        planQuotaBytes: 100000000,
        overrideQuotaBytes: null,
        overrideReason: null,
        overrideExpiresAt: null,
        isSuspended: true,
        isPurging: false,
        usedBytes: 0,
      });

      const ctx: RequestContext = {
        namespace: 'imports',
        tenantId: 'org-suspended',
        actor: { type: 'user', id: 'user-1', roles: [], scopes: [] },
        correlationId: 'corr-1',
        ipAddress: '127.0.0.1',
        attributes: {},
      };

      await expect(
        quotaService.checkUploadQuota('org-suspended', 1000, ctx),
      ).rejects.toThrow(TenantSuspendedError);
    });

    it('throws QuotaExceededError (507 quota_exceeded) with quotaBytes, usedBytes, requestedBytes', async () => {
      const quotaLimit = 1000000;
      const currentUsed = 950000;
      const requested = 100000;

      mockDbService = { getDb: () => ({}) };
      quotaService = new TenantQuotaService(
        mockDbService as any,
        {} as any,
        mockDomainPublisher as any,
        {} as any,
      );

      vi.spyOn(quotaService, 'getEffectiveQuota').mockResolvedValue({
        tenantId: 'org-overquota',
        effectiveQuotaBytes: quotaLimit,
        planQuotaBytes: quotaLimit,
        overrideQuotaBytes: null,
        overrideReason: null,
        overrideExpiresAt: null,
        isSuspended: false,
        isPurging: false,
        usedBytes: currentUsed,
      });

      const ctx: RequestContext = {
        namespace: 'imports',
        tenantId: 'org-overquota',
        actor: { type: 'user', id: 'user-1', roles: [], scopes: [] },
        correlationId: 'corr-1',
        ipAddress: '127.0.0.1',
        attributes: {},
      };

      let thrownError: any = null;
      try {
        await quotaService.checkUploadQuota('org-overquota', requested, ctx);
      } catch (err) {
        thrownError = err;
      }

      expect(thrownError).toBeInstanceOf(QuotaExceededError);
      expect(thrownError.status).toBe(507);
      expect(thrownError.code).toBe('quota_exceeded');
      expect(thrownError.quotaBytes).toBe(quotaLimit);
      expect(thrownError.usedBytes).toBe(currentUsed);
      expect(thrownError.requestedBytes).toBe(requested);
    });

    it('emits file.quota.threshold.v1 when crossing 80%, 95%, or 100% threshold', async () => {
      const quotaLimit = 1000000;
      const currentUsed = 750000; // 75%
      const requested = 100000;   // reaches 85% (crosses 80%)

      mockDbService = { getDb: () => ({}) };
      quotaService = new TenantQuotaService(
        mockDbService as any,
        {} as any,
        mockDomainPublisher as any,
        {} as any,
      );

      vi.spyOn(quotaService, 'getEffectiveQuota').mockResolvedValue({
        tenantId: 'org-thresh',
        effectiveQuotaBytes: quotaLimit,
        planQuotaBytes: quotaLimit,
        overrideQuotaBytes: null,
        overrideReason: null,
        overrideExpiresAt: null,
        isSuspended: false,
        isPurging: false,
        usedBytes: currentUsed,
      });

      const ctx: RequestContext = {
        namespace: 'imports',
        tenantId: 'org-thresh',
        actor: { type: 'user', id: 'user-1', roles: [], scopes: [] },
        correlationId: 'corr-1',
        ipAddress: '127.0.0.1',
        attributes: {},
      };

      await quotaService.checkUploadQuota('org-thresh', requested, ctx);
      expect(mockDomainPublisher.publish).toHaveBeenCalledWith(
        null,
        expect.objectContaining({
          eventType: 'file.quota.threshold.v1',
          organizationId: 'org-thresh',
          data: expect.objectContaining({
            thresholdPercent: 80,
          }),
        }),
      );
    });
  });

  describe('UR-15 & UR-31: SVG Sanitisation', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'svg-test-'));
    });

    it('strips <script> tags and inline on* event handlers from SVG', async () => {
      const svgPath = path.join(tmpDir, 'test.svg');
      const maliciousSvg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" onload="alert('pwned')">
          <script>alert(document.cookie);</script>
          <circle cx="50" cy="50" r="40" stroke="green" stroke-width="4" fill="yellow" />
          <foreignObject width="100" height="100">
            <iframe src="javascript:alert(1)"></iframe>
          </foreignObject>
        </svg>
      `;
      await fs.writeFile(svgPath, maliciousSvg, 'utf8');

      await sanitizeSvgFile(svgPath);

      const cleaned = await fs.readFile(svgPath, 'utf8');
      expect(cleaned).not.toContain('<script>');
      expect(cleaned).not.toContain('alert');
      expect(cleaned).not.toContain('onload=');
      expect(cleaned).not.toContain('<foreignObject>');
      expect(cleaned).toContain('<circle');
    });

    it('rejects malformed SVG with ValidationError (422 validation_failed)', async () => {
      const svgPath = path.join(tmpDir, 'malformed.svg');
      await fs.writeFile(svgPath, 'Not an SVG at all', 'utf8');

      await expect(sanitizeSvgFile(svgPath)).rejects.toThrow(ValidationError);
    });
  });

  describe('UR-14: Legal Hold & Retention Precedence', () => {
    it('throws LegalHoldError (409 legal_hold) when attempting to delete a held file', async () => {
      const mockFile = {
        id: 'file-held-1',
        tenantId: 'org-1',
        namespace: 'imports',
        held: true,
        status: 'ACTIVE',
        visibility: 'private',
        sizeBytes: 1000n,
      };

      const mockFileRepo = {
        findById: vi.fn().mockResolvedValue(mockFile),
      };
      const mockAuthz = {
        canAccessTenant: vi.fn().mockReturnValue(true),
        authorize: vi.fn().mockReturnValue({ allowed: true }),
      };

      const deleteService = new DeleteService(
        {} as any,
        mockAuthz as any,
        { eventsEnabled: false } as any,
        {} as any,
        mockFileRepo as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );

      const ctx: RequestContext = {
        namespace: 'imports',
        tenantId: 'org-1',
        actor: { type: 'user', id: 'u-1', roles: [], scopes: [] },
        correlationId: 'c-1',
        ipAddress: '127.0.0.1',
        attributes: {},
      };

      await expect(deleteService.delete(ctx, 'file-held-1')).rejects.toThrow(
        LegalHoldError,
      );
    });
  });

  describe('UR-11: Public Domain Events Envelope', () => {
    it('formats domain events conforming strictly to Section 4.6 envelope', async () => {
      const mockOutboxWriter = {
        enqueue: vi.fn().mockResolvedValue(undefined),
      };
      const publisher = new DomainEventPublisher(mockOutboxWriter as any);

      const ctx: RequestContext = {
        namespace: 'imports',
        tenantId: 'org-event-1',
        actor: {
          type: 'service',
          id: 'sis-importer',
          actingService: 'sis-sync',
          roles: [],
          scopes: [],
        },
        correlationId: 'corr-event-99',
        ipAddress: '127.0.0.1',
        attributes: {},
      };

      const envelope = await publisher.publish(null, {
        eventType: 'file.uploaded.v1',
        organizationId: 'org-event-1',
        context: ctx,
        traceId: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        data: {
          fileId: 'f-1',
          sizeBytes: 2048,
        },
      });

      expect(envelope).toBeDefined();
      expect(envelope.eventId).toBeDefined();
      expect(envelope.eventType).toBe('file.uploaded.v1');
      expect(envelope.organizationId).toBe('org-event-1');
      expect(envelope.producer).toBe('esma-upload-service');
      expect(envelope.traceId).toBe(
        '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      );
      expect(envelope.correlationId).toBe('corr-event-99');
      expect(envelope.actor).toEqual({
        type: 'SERVICE',
        id: 'sis-importer',
        actingService: 'sis-sync',
      });
      expect(envelope.data).toEqual({
        fileId: 'f-1',
        sizeBytes: 2048,
      });

      expect(mockOutboxWriter.enqueue).toHaveBeenCalledWith(
        null,
        expect.objectContaining({
          eventType: 'file.uploaded.v1',
          partitionKey: 'org-event-1',
        }),
        'esma.files.events.v1',
      );
    });
  });
});
