import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthorizationGuard } from '../src/authz/guards/authorization.guard.js';
import { AppConfigService } from '../src/config/config.service.js';
import { FileRepository } from '../src/db/repositories/file.repository.js';
import {
  DefaultResourceLoader,
  FileResourceLoader,
} from '../src/authz/resource-loader.js';
import { AUDIT_SINK, AuditEvent, AuditSink } from '../src/authz/audit-sink.js';
import {
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
} from '../src/core/errors/app-error.js';
import {
  AuthenticatedHttpRequest,
  RequestContext,
} from '../src/auth/context.js';
import { FileRecord } from '../src/core/types.js';
import { REQUIRE_ACTION_KEY } from '../src/authz/decorators/require-action.decorator.js';

describe('AuthorizationGuard & Anti-Enumeration 404 Tests', () => {
  let guard: AuthorizationGuard;
  let reflector: Reflector;
  let mockFileRepo: Partial<FileRepository>;
  let recordedAuditEvents: AuditEvent[];

  const mockAuditSink: AuditSink = {
    record: (event: AuditEvent) => {
      recordedAuditEvents.push(event);
    },
  };

  const mockConfigService = {
    get: () => ({
      ADMIN_ALLOWED_ROLES: 'superadmin,SUPER ADMIN,admin',
    }),
  };

  beforeEach(async () => {
    recordedAuditEvents = [];
    mockFileRepo = {
      findById: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthorizationGuard,
        Reflector,
        FileResourceLoader,
        DefaultResourceLoader,
        {
          provide: AppConfigService,
          useValue: mockConfigService,
        },
        {
          provide: FileRepository,
          useValue: mockFileRepo,
        },
        {
          provide: AUDIT_SINK,
          useValue: mockAuditSink,
        },
      ],
    }).compile();

    guard = module.get<AuthorizationGuard>(AuthorizationGuard);
    reflector = module.get<Reflector>(Reflector);
  });

  const createMockContext = (
    req: Partial<AuthenticatedHttpRequest>,
    handlerAction?: string,
  ): ExecutionContext => {
    jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
      if (key === REQUIRE_ACTION_KEY) {
        return handlerAction;
      }
      return undefined;
    });

    return {
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => req,
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
  };

  const createTestRequestContext = (
    tenantId = 'school-alpha',
    overrides: Partial<RequestContext> = {},
  ): RequestContext => ({
    namespace: 'esma-tenant',
    tenantId,
    subTenantId: undefined,
    actor: {
      id: 'actor-1',
      type: 'user',
      roles: ['teacher'],
      permissions: ['files_read', 'files_delete'],
      scopes: [],
      branchGrants: [],
      isSchoolAdmin: false,
    },
    correlationId: 'guard-corr-id',
    ipAddress: '127.0.0.1',
    attributes: {},
    ...overrides,
  });

  it('passes through when no @RequireAction is declared', async () => {
    const req: Partial<AuthenticatedHttpRequest> = {};
    const context = createMockContext(req, undefined);

    const result = await guard.canActivate(context);
    expect(result).toBe(true);
    expect(recordedAuditEvents.length).toBe(0);
  });

  it('throws UnauthenticatedError when RequestContext is missing', async () => {
    const req: Partial<AuthenticatedHttpRequest> = {};
    const context = createMockContext(req, 'read');

    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthenticatedError,
    );
  });

  describe('Anti-Enumeration 404 Security Rule (Cross-Tenant File Access)', () => {
    it('returns 404 (NotFoundError) and NOT 403 when file belongs to another tenant', async () => {
      const foreignFileRecord: Partial<FileRecord> = {
        id: 'file-xyz-999',
        namespace: 'esma-tenant',
        tenantId: 'school-beta', // Foreign tenant!
        subTenantId: null,
        uploadedBy: 'other-user',
        visibility: 'tenant',
      };

      (mockFileRepo.findById as jest.Mock).mockResolvedValue(foreignFileRecord);

      const req: Partial<AuthenticatedHttpRequest> = {
        params: { fileId: 'file-xyz-999' },
        ctx: createTestRequestContext('school-alpha'), // Caller is in school-alpha
      };

      const context = createMockContext(req, 'read');

      // Crucial test: must throw NotFoundError (404), never ForbiddenError (403)!
      await expect(guard.canActivate(context)).rejects.toThrow(NotFoundError);
      await expect(guard.canActivate(context)).rejects.toThrow(
        "File 'file-xyz-999' not found",
      );

      // Verify audit sink recorded the denied cross-tenant attempt
      expect(recordedAuditEvents.length).toBeGreaterThan(0);
      const audit = recordedAuditEvents[0];
      expect(audit.decision.ruleId).toBe('CROSS_TENANT_NOT_FOUND');
      expect(audit.tenantId).toBe('school-alpha');
      expect(audit.resource?.tenantId).toBe('school-beta');
    });

    it('allows ESMA admin to access cross-tenant files without 404 masking', async () => {
      const foreignFileRecord: Partial<FileRecord> = {
        id: 'file-xyz-999',
        namespace: 'esma-tenant',
        tenantId: 'school-beta',
        subTenantId: null,
        uploadedBy: 'other-user',
        visibility: 'tenant',
      };

      (mockFileRepo.findById as jest.Mock).mockResolvedValue(foreignFileRecord);

      const req: Partial<AuthenticatedHttpRequest> = {
        params: { fileId: 'file-xyz-999' },
        ctx: createTestRequestContext('system', {
          namespace: 'esma-admin',
          actor: {
            id: 'super-admin-1',
            type: 'user',
            roles: ['SUPER ADMIN'],
            permissions: [],
            scopes: [],
          },
        }),
      };

      const context = createMockContext(req, 'read');
      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });
  });

  describe('Same-Tenant Authorization Checks', () => {
    it('throws ForbiddenError (403) when branch-scoped user tries to delete school root file', async () => {
      const schoolRootFile: Partial<FileRecord> = {
        id: 'root-file-1',
        namespace: 'esma-tenant',
        tenantId: 'school-alpha',
        subTenantId: null, // school root file
        uploadedBy: 'someone',
        visibility: 'tenant',
      };

      (mockFileRepo.findById as jest.Mock).mockResolvedValue(schoolRootFile);

      const req: Partial<AuthenticatedHttpRequest> = {
        params: { fileId: 'root-file-1' },
        ctx: createTestRequestContext('school-alpha', {
          subTenantId: 'branch-1',
          actor: {
            id: 'teacher-branch-1',
            type: 'user',
            roles: ['teacher'],
            permissions: ['files_delete'],
            scopes: [],
            branchGrants: ['branch-1'],
            isSchoolAdmin: false,
          },
        }),
      };

      const context = createMockContext(req, 'delete');

      // Since tenant matches, violation of branch rules produces 403 ForbiddenError
      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenError);
    });

    it('allows delete when branch-scoped user deletes file in their assigned branch', async () => {
      const branchFile: Partial<FileRecord> = {
        id: 'branch-file-1',
        namespace: 'esma-tenant',
        tenantId: 'school-alpha',
        subTenantId: 'branch-1',
        uploadedBy: 'someone',
        visibility: 'tenant',
      };

      (mockFileRepo.findById as jest.Mock).mockResolvedValue(branchFile);

      const req: Partial<AuthenticatedHttpRequest> = {
        params: { fileId: 'branch-file-1' },
        ctx: createTestRequestContext('school-alpha', {
          subTenantId: 'branch-1',
          actor: {
            id: 'teacher-branch-1',
            type: 'user',
            roles: ['teacher'],
            permissions: ['files_delete'],
            scopes: [],
            branchGrants: ['branch-1'],
            isSchoolAdmin: false,
          },
        }),
      };

      const context = createMockContext(req, 'delete');
      const result = await guard.canActivate(context);
      expect(result).toBe(true);

      // Verify fileRecord was attached to request
      expect(req.fileRecord).toEqual(branchFile);
    });

    it('handles non-file upload operation using DefaultResourceLoader', async () => {
      const req: Partial<AuthenticatedHttpRequest> = {
        params: {},
        query: { branchId: 'branch-north' },
        ctx: createTestRequestContext('school-alpha', {
          actor: {
            id: 'admin-1',
            type: 'user',
            roles: ['admin'],
            permissions: [],
            scopes: [],
            isSchoolAdmin: true,
          },
        }),
      };

      const context = createMockContext(req, 'upload');
      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });
  });
});
