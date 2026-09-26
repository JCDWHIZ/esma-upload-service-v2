import {
  parseAttributes,
  freezeContext,
  RequestContext,
  AuthenticatedHttpRequest,
  VerifiedTokenClaims,
} from '../src/auth/context.js';
import { EsmaTenantContextResolver } from '../src/auth/resolvers/tenant-context.resolver.js';
import { EsmaAdminContextResolver } from '../src/auth/resolvers/admin-context.resolver.js';
import { GenericContextResolver } from '../src/auth/resolvers/generic-context.resolver.js';
import {
  TenantMismatchError,
  UnauthenticatedError,
  ValidationError,
} from '../src/core/errors/app-error.js';
import { ApiClient } from '../src/core/types.js';

describe('RequestContext & Resolvers (P1-08)', () => {
  describe('parseAttributes', () => {
    it('returns empty frozen object for undefined, null, or empty string', () => {
      expect(parseAttributes(undefined)).toEqual({});
      expect(Object.isFrozen(parseAttributes(undefined))).toBe(true);
      expect(parseAttributes(null)).toEqual({});
      expect(parseAttributes('')).toEqual({});
    });

    it('parses valid JSON string header', () => {
      const parsed = parseAttributes('{"department":"finance","env":"prod"}');
      expect(parsed).toEqual({ department: 'finance', env: 'prod' });
      expect(Object.isFrozen(parsed)).toBe(true);
    });

    it('parses valid object from request body', () => {
      const parsed = parseAttributes({ role: 'teacher', classroom: '101' });
      expect(parsed).toEqual({ role: 'teacher', classroom: '101' });
      expect(Object.isFrozen(parsed)).toBe(true);
    });

    it('rejects invalid JSON syntax', () => {
      expect(() => parseAttributes('{invalid-json')).toThrow(ValidationError);
    });

    it('rejects non-object types (e.g. array, number, boolean)', () => {
      expect(() => parseAttributes('[1, 2, 3]')).toThrow(ValidationError);
      expect(() => parseAttributes(123)).toThrow(ValidationError);
      expect(() => parseAttributes(true)).toThrow(ValidationError);
    });

    it('rejects attributes exceeding 20 keys', () => {
      const overLimit: Record<string, string> = {};
      for (let i = 1; i <= 21; i++) {
        overLimit[`key_${i}`] = `value_${i}`;
      }
      expect(() => parseAttributes(overLimit)).toThrow(ValidationError);
    });

    it('rejects empty or overlong keys', () => {
      expect(() => parseAttributes({ '': 'val' })).toThrow(ValidationError);
      const longKey = 'k'.repeat(257);
      expect(() => parseAttributes({ [longKey]: 'val' })).toThrow(
        ValidationError,
      );
    });

    it('rejects non-string values or overlong values', () => {
      expect(() => parseAttributes({ key1: 123 as unknown as string })).toThrow(
        ValidationError,
      );
      expect(() =>
        parseAttributes({ key1: false as unknown as string }),
      ).toThrow(ValidationError);
      expect(() =>
        parseAttributes({
          key1: { nested: 'obj' } as unknown as string,
        }),
      ).toThrow(ValidationError);
      const longVal = 'v'.repeat(257);
      expect(() => parseAttributes({ key1: longVal })).toThrow(ValidationError);
    });
  });

  describe('freezeContext', () => {
    it('deeply freezes RequestContext and its nested collections', () => {
      const ctx: RequestContext = {
        namespace: 'esma-tenant',
        tenantId: 'sch_123',
        actor: {
          id: 'user_1',
          type: 'user',
          roles: ['teacher', 'admin'],
          permissions: ['FILES_READ'],
          scopes: ['files:read'],
          isPlatformAdmin: false,
        },
        correlationId: '018f1a2b-3c4d-7e8f-9a0b-1c2d3e4f5a6b',
        ipAddress: '127.0.0.1',
        attributes: { key: 'val' },
      };

      const frozen = freezeContext(ctx);
      expect(Object.isFrozen(frozen)).toBe(true);
      expect(Object.isFrozen(frozen.actor)).toBe(true);
      expect(Object.isFrozen(frozen.actor.roles)).toBe(true);
      expect(Object.isFrozen(frozen.actor.permissions)).toBe(true);
      expect(Object.isFrozen(frozen.actor.scopes)).toBe(true);
      expect(Object.isFrozen(frozen.attributes)).toBe(true);

      // Attempted mutation should fail in strict mode
      expect(() => {
        // @ts-expect-error mutating readonly property
        frozen.tenantId = 'changed';
      }).toThrow();
      expect(() => {
        (frozen.actor.roles as unknown as string[]).push('new_role');
      }).toThrow();
    });
  });

  describe('EsmaTenantContextResolver', () => {
    const resolver = new EsmaTenantContextResolver();

    it('resolves standard verified modern OIDC token', async () => {
      const req = {
        headers: {
          'x-correlation-id': '018f1a2b-3c4d-7e8f-9a0b-1c2d3e4f5a6b',
          'x-school-id': 'd4530b09-703e-4759-bac9-f2aa192f1beb',
          'user-agent': 'JestTestRunner/1.0',
        },
        ip: '192.168.1.10',
        user: {
          sub: 'df6bc72b-da11-4811-b3fb-d64dc47b497c',
          organizationId: 'd4530b09-703e-4759-bac9-f2aa192f1beb',
          branches: [{ id: 'branch-north' }, { id: 'branch-south' }],
          access: {
            organization: {
              roles: ['TEACHER'],
              permissions: ['UPLOAD_FILES', 'VIEW_FILES'],
            },
            global: {
              roles: ['MEMBER'],
              permissions: [],
            },
          },
          platformAdmin: false,
        },
      } as unknown as AuthenticatedHttpRequest;

      const ctx = await resolver.resolve(req);
      expect(ctx.namespace).toBe('esma-tenant');
      expect(ctx.tenantId).toBe('d4530b09-703e-4759-bac9-f2aa192f1beb');
      expect(ctx.subTenantId).toBe('branch-north');
      expect(ctx.actor.id).toBe('df6bc72b-da11-4811-b3fb-d64dc47b497c');
      expect(ctx.actor.type).toBe('user');
      expect(ctx.actor.roles).toEqual(['TEACHER', 'MEMBER']);
      expect(ctx.actor.permissions).toEqual(['UPLOAD_FILES', 'VIEW_FILES']);
      expect(ctx.actor.isPlatformAdmin).toBe(false);
      expect(ctx.correlationId).toBe('018f1a2b-3c4d-7e8f-9a0b-1c2d3e4f5a6b');
      expect(ctx.ipAddress).toBe('192.168.1.10');
      expect(ctx.userAgent).toBe('JestTestRunner/1.0');
      expect(Object.isFrozen(ctx)).toBe(true);
    });

    it('resolves legacy style token with schoolId, branchId, and userId', async () => {
      const req = {
        headers: {},
        ip: '10.0.0.1',
        user: {
          userId: 'user_456',
          schoolId: 'sch_999',
          branchId: 'br_west',
          role: 'ADMIN',
        },
      } as unknown as AuthenticatedHttpRequest;

      const ctx = await resolver.resolve(req);
      expect(ctx.tenantId).toBe('sch_999');
      expect(ctx.subTenantId).toBe('br_west');
      expect(ctx.actor.id).toBe('user_456');
      expect(ctx.actor.roles).toEqual(['ADMIN']);
    });

    it('provides deterministic actor.id when userId / sub are missing', async () => {
      const req = {
        headers: {},
        user: {
          schoolId: 'sch_abc',
        },
      } as unknown as AuthenticatedHttpRequest;

      const ctx = await resolver.resolve(req);
      expect(ctx.actor.id).toBe('token:sch_abc');
    });

    it('enforces matching x-branch-id header with token branches', async () => {
      const req = {
        headers: {
          'x-branch-id': 'branch-south',
        },
        user: {
          schoolId: 'sch_1',
          branches: ['branch-north', 'branch-south'],
        },
      } as unknown as AuthenticatedHttpRequest;

      const ctx = await resolver.resolve(req);
      expect(ctx.subTenantId).toBe('branch-south');
    });

    it('rejects x-branch-id header that does not match token branch grants', async () => {
      const req = {
        headers: {
          'x-branch-id': 'branch-unauthorized',
        },
        user: {
          schoolId: 'sch_1',
          branches: ['branch-north', 'branch-south'],
        },
      } as unknown as AuthenticatedHttpRequest;

      await expect(resolver.resolve(req)).rejects.toThrow(TenantMismatchError);
    });

    it('rejects mismatch between x-school-id header and token organizationId', async () => {
      const req = {
        headers: {
          'x-school-id': 'school-B',
        },
        user: {
          organizationId: 'school-A',
        },
      } as unknown as AuthenticatedHttpRequest;

      await expect(resolver.resolve(req)).rejects.toThrow(TenantMismatchError);
    });

    it('rejects hostile segments in x-school-id or tenantId', async () => {
      const reqTraversal = {
        headers: {},
        user: {
          schoolId: '../../etc/passwd',
        },
      } as unknown as AuthenticatedHttpRequest;
      await expect(resolver.resolve(reqTraversal)).rejects.toThrow(
        ValidationError,
      );

      const reqNullByte = {
        headers: {
          'x-branch-id': 'branch\0null',
        },
        user: {
          schoolId: 'sch_valid',
        },
      } as unknown as AuthenticatedHttpRequest;
      await expect(resolver.resolve(reqNullByte)).rejects.toThrow(
        ValidationError,
      );
    });

    it('throws UnauthenticatedError if token is missing', async () => {
      const req = { headers: {} } as unknown as AuthenticatedHttpRequest;
      await expect(resolver.resolve(req)).rejects.toThrow(UnauthenticatedError);
    });

    it('throws UnauthenticatedError if token has no organizationId or schoolId', async () => {
      const req = {
        headers: {},
        user: { sub: 'user_123' },
      } as unknown as AuthenticatedHttpRequest;
      await expect(resolver.resolve(req)).rejects.toThrow(UnauthenticatedError);
    });
  });

  describe('EsmaAdminContextResolver', () => {
    const resolver = new EsmaAdminContextResolver();

    it('resolves admin context with system tenantId and esma-admin namespace', async () => {
      const req = {
        headers: {
          'x-correlation-id': 'corr-admin-12345',
          'x-attributes': '{"audit_reason":"support_inspection"}',
        },
        user: {
          sub: 'admin_guid_1',
          email: 'admin@esma.com',
          access: {
            organization: {
              roles: ['SUPER ADMIN'],
              permissions: ['STORAGE_QUOTA_EDIT', 'STORAGE_FILES_MANAGE'],
            },
          },
          platformAdmin: true,
        },
      } as unknown as AuthenticatedHttpRequest;

      const ctx = await resolver.resolve(req);
      expect(ctx.namespace).toBe('esma-admin');
      expect(ctx.tenantId).toBe('system');
      expect(ctx.subTenantId).toBeUndefined();
      expect(ctx.actor.id).toBe('admin_guid_1');
      expect(ctx.actor.roles).toEqual(['SUPER ADMIN']);
      expect(ctx.actor.permissions).toEqual([
        'STORAGE_QUOTA_EDIT',
        'STORAGE_FILES_MANAGE',
      ]);
      expect(ctx.actor.isPlatformAdmin).toBe(true);
      expect(ctx.attributes).toEqual({ audit_reason: 'support_inspection' });
      expect(Object.isFrozen(ctx)).toBe(true);
    });

    it('fallback actor.id uses email or admin:system if userId/sub missing', async () => {
      const reqWithEmail = {
        headers: {},
        user: {
          email: 'ops@esma.com',
        },
      } as unknown as AuthenticatedHttpRequest;
      const ctx1 = await resolver.resolve(reqWithEmail);
      expect(ctx1.actor.id).toBe('admin:ops@esma.com');

      const reqEmpty = {
        headers: {},
        user: {} as VerifiedTokenClaims,
      } as unknown as AuthenticatedHttpRequest;
      const ctx2 = await resolver.resolve(reqEmpty);
      expect(ctx2.actor.id).toBe('admin:system');
    });

    it('throws UnauthenticatedError if admin token missing', async () => {
      const req = { headers: {} } as unknown as AuthenticatedHttpRequest;
      await expect(resolver.resolve(req)).rejects.toThrow(UnauthenticatedError);
    });
  });

  describe('GenericContextResolver', () => {
    const resolver = new GenericContextResolver();

    const mockClient: ApiClient = {
      id: 'client_api_01',
      name: 'Partner Integration Service',
      keyPrefix: 'gus_test',
      keyHash: 'hash',
      namespace: 'partner-sync',
      tenantIds: ['tenant_A', 'tenant_B'],
      allowAnyTenant: false,
      scopes: ['files:write', 'files:read'],
      status: 'ACTIVE',
      expiresAt: null,
      lastUsedAt: null,
      createdAt: new Date(),
      revokedAt: null,
    };

    it('resolves generic API client context for allowed tenant', async () => {
      const req = {
        headers: {
          'x-tenant-id': 'tenant_A',
          'x-namespace': 'partner-sync',
          'x-sub-tenant-id': 'dept_fin',
        },
        apiClient: mockClient,
      } as unknown as AuthenticatedHttpRequest;

      const ctx = await resolver.resolve(req);
      expect(ctx.namespace).toBe('partner-sync');
      expect(ctx.tenantId).toBe('tenant_A');
      expect(ctx.subTenantId).toBe('dept_fin');
      expect(ctx.actor.id).toBe('client_api_01');
      expect(ctx.actor.type).toBe('service');
      expect(ctx.actor.scopes).toEqual(['files:write', 'files:read']);
      expect(Object.isFrozen(ctx)).toBe(true);
    });

    it('rejects request when tenant is not in allowed tenant list', async () => {
      const req = {
        headers: {
          'x-tenant-id': 'tenant_C',
        },
        apiClient: mockClient,
      } as unknown as AuthenticatedHttpRequest;

      await expect(resolver.resolve(req)).rejects.toThrow(TenantMismatchError);
    });

    it('allows any tenant if client has allowAnyTenant: true', async () => {
      const anyTenantClient: ApiClient = {
        ...mockClient,
        allowAnyTenant: true,
        tenantIds: [],
      };

      const req = {
        headers: {
          'x-tenant-id': 'any_school_xyz',
        },
        apiClient: anyTenantClient,
      } as unknown as AuthenticatedHttpRequest;

      const ctx = await resolver.resolve(req);
      expect(ctx.tenantId).toBe('any_school_xyz');
    });

    it('auto-selects tenantId if client has single tenant and header is omitted', async () => {
      const singleTenantClient: ApiClient = {
        ...mockClient,
        tenantIds: ['sole_tenant_1'],
      };

      const req = {
        headers: {},
        apiClient: singleTenantClient,
      } as unknown as AuthenticatedHttpRequest;

      const ctx = await resolver.resolve(req);
      expect(ctx.tenantId).toBe('sole_tenant_1');
    });

    it('throws ValidationError if x-tenant-id missing and client has multiple tenants', async () => {
      const req = {
        headers: {},
        apiClient: mockClient,
      } as unknown as AuthenticatedHttpRequest;

      await expect(resolver.resolve(req)).rejects.toThrow(ValidationError);
    });

    it('rejects header x-namespace mismatch', async () => {
      const req = {
        headers: {
          'x-tenant-id': 'tenant_A',
          'x-namespace': 'wrong-namespace',
        },
        apiClient: mockClient,
      } as unknown as AuthenticatedHttpRequest;

      await expect(resolver.resolve(req)).rejects.toThrow(TenantMismatchError);
    });

    it('rejects hostile segments in x-tenant-id or x-sub-tenant-id', async () => {
      const reqHostileTenant = {
        headers: {
          'x-tenant-id': '../traversal',
        },
        apiClient: { ...mockClient, allowAnyTenant: true },
      } as unknown as AuthenticatedHttpRequest;
      await expect(resolver.resolve(reqHostileTenant)).rejects.toThrow(
        ValidationError,
      );

      const reqHostileSub = {
        headers: {
          'x-tenant-id': 'tenant_A',
          'x-sub-tenant-id': 'sub/with/slash',
        },
        apiClient: mockClient,
      } as unknown as AuthenticatedHttpRequest;
      await expect(resolver.resolve(reqHostileSub)).rejects.toThrow(
        ValidationError,
      );
    });

    it('throws UnauthenticatedError if API client is missing', async () => {
      const req = { headers: {} } as unknown as AuthenticatedHttpRequest;
      await expect(resolver.resolve(req)).rejects.toThrow(UnauthenticatedError);
    });
  });
});
