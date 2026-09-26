import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { ExecutionContext } from '@nestjs/common';
import { ContextGuard } from '../src/auth/guards/context.guard.js';
import { EsmaTenantContextResolver } from '../src/auth/resolvers/tenant-context.resolver.js';
import { EsmaAdminContextResolver } from '../src/auth/resolvers/admin-context.resolver.js';
import { GenericContextResolver } from '../src/auth/resolvers/generic-context.resolver.js';
import { Namespace } from '../src/auth/decorators/namespace.decorator.js';
import {
  runWithCorrelationId,
  getCorrelationContext,
} from '../src/observability/correlation-context.js';
import { ApiClient } from '../src/core/types.js';
import {
  AuthenticatedHttpRequest,
  RequestContext,
} from '../src/auth/context.js';

describe('ContextGuard (P1-08)', () => {
  let guard: ContextGuard;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        Reflector,
        EsmaTenantContextResolver,
        EsmaAdminContextResolver,
        GenericContextResolver,
        ContextGuard,
      ],
    }).compile();

    guard = module.get<ContextGuard>(ContextGuard);
  });

  function createMockExecutionContext(
    req: AuthenticatedHttpRequest,
    handler: (...args: unknown[]) => unknown,
    targetClass: unknown = class TestController {},
    contextType = 'http',
  ): ExecutionContext {
    return {
      getType: () => contextType as unknown as 'http',
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => ({}) as unknown,
        getNext: () => ({}) as unknown,
      }),
      getHandler: () => handler,
      getClass: () => targetClass as new (...args: unknown[]) => unknown,
      getArgs: () => [] as unknown[],
      getArgByIndex: () => undefined as unknown,
      switchToRpc: () =>
        ({}) as unknown as ReturnType<ExecutionContext['switchToRpc']>,
      switchToWs: () =>
        ({}) as unknown as ReturnType<ExecutionContext['switchToWs']>,
    } as unknown as ExecutionContext;
  }

  it('bypasses non-http contexts safely', async () => {
    const handler = () => undefined;
    const context = createMockExecutionContext(
      {} as AuthenticatedHttpRequest,
      handler,
      undefined,
      'rpc',
    );
    const result = await guard.canActivate(context);
    expect(result).toBe(true);
  });

  it('selects EsmaTenantContextResolver when @Namespace("esma-tenant") is present', async () => {
    class TenantController {
      @Namespace('esma-tenant')
      uploadFile(this: void) {
        return undefined;
      }
    }

    const handler = TenantController.prototype.uploadFile;
    const req = {
      headers: {
        'x-correlation-id': '018f1a2b-3c4d-7e8f-9a0b-1c2d3e4f5a6b',
      },
      user: {
        organizationId: 'sch_tenant_1',
        sub: 'user_99',
      },
    } as unknown as AuthenticatedHttpRequest;

    const context = createMockExecutionContext(req, handler, TenantController);

    await runWithCorrelationId(
      '018f1a2b-3c4d-7e8f-9a0b-1c2d3e4f5a6b',
      async () => {
        const allowed = await guard.canActivate(context);
        expect(allowed).toBe(true);
        expect(req.ctx).toBeDefined();
        const ctx = req.ctx as RequestContext;
        expect(ctx.namespace).toBe('esma-tenant');
        expect(ctx.tenantId).toBe('sch_tenant_1');
        expect(ctx.actor.id).toBe('user_99');
        expect(Object.isFrozen(ctx)).toBe(true);

        const store = getCorrelationContext();
        expect(store?.namespace).toBe('esma-tenant');
        expect(store?.tenantId).toBe('sch_tenant_1');
        expect(store?.actorId).toBe('user_99');
      },
    );
  });

  it('selects EsmaAdminContextResolver when @Namespace("esma-admin") is present', async () => {
    class AdminController {
      @Namespace('esma-admin')
      manageQuota(this: void) {
        return undefined;
      }
    }

    const handler = AdminController.prototype.manageQuota;
    const req = {
      headers: {},
      user: {
        sub: 'admin_007',
        access: {
          organization: {
            roles: ['SUPER ADMIN'],
          },
        },
      },
    } as unknown as AuthenticatedHttpRequest;

    const context = createMockExecutionContext(req, handler, AdminController);
    const allowed = await guard.canActivate(context);

    expect(allowed).toBe(true);
    expect(req.ctx).toBeDefined();
    const ctx = req.ctx as RequestContext;
    expect(ctx.namespace).toBe('esma-admin');
    expect(ctx.tenantId).toBe('system');
    expect(ctx.actor.roles).toEqual(['SUPER ADMIN']);
  });

  it('selects GenericContextResolver when @Namespace("generic") is present', async () => {
    class GenericController {
      @Namespace('generic')
      consume(this: void) {
        return undefined;
      }
    }

    const mockClient: ApiClient = {
      id: 'api_client_1',
      name: 'Client A',
      keyPrefix: 'gus_test',
      keyHash: 'hash',
      namespace: 'custom-partner',
      tenantIds: ['tenant_target'],
      allowAnyTenant: false,
      scopes: ['files:write'],
      status: 'ACTIVE',
      expiresAt: null,
      lastUsedAt: null,
      createdAt: new Date(),
      revokedAt: null,
    };

    const handler = GenericController.prototype.consume;
    const req = {
      headers: {
        'x-tenant-id': 'tenant_target',
      },
      apiClient: mockClient,
    } as unknown as AuthenticatedHttpRequest;

    const context = createMockExecutionContext(req, handler, GenericController);
    const allowed = await guard.canActivate(context);

    expect(allowed).toBe(true);
    expect(req.ctx).toBeDefined();
    const ctx = req.ctx as RequestContext;
    expect(ctx.namespace).toBe('custom-partner');
    expect(ctx.tenantId).toBe('tenant_target');
    expect(ctx.actor.type).toBe('service');
  });

  it('auto-detects appropriate resolver if @Namespace decorator is not set', async () => {
    class UnannotatedController {
      doAction(this: void) {
        return undefined;
      }
    }
    const handler = UnannotatedController.prototype.doAction;

    // 1. ApiClient present -> Generic
    const mockClient: ApiClient = {
      id: 'api_client_2',
      name: 'Client B',
      keyPrefix: 'gus_test',
      keyHash: 'hash',
      namespace: 'auto-partner',
      tenantIds: ['ten_1'],
      allowAnyTenant: false,
      scopes: [],
      status: 'ACTIVE',
      expiresAt: null,
      lastUsedAt: null,
      createdAt: new Date(),
      revokedAt: null,
    };
    const reqClient = {
      headers: { 'x-tenant-id': 'ten_1' },
      apiClient: mockClient,
    } as unknown as AuthenticatedHttpRequest;
    await guard.canActivate(
      createMockExecutionContext(reqClient, handler, UnannotatedController),
    );
    expect((reqClient.ctx as RequestContext).namespace).toBe('auto-partner');

    // 2. School / Organization token present -> Tenant
    const reqSchool = {
      headers: {},
      user: { schoolId: 'sch_auto' },
    } as unknown as AuthenticatedHttpRequest;
    await guard.canActivate(
      createMockExecutionContext(reqSchool, handler, UnannotatedController),
    );
    expect((reqSchool.ctx as RequestContext).namespace).toBe('esma-tenant');
    expect((reqSchool.ctx as RequestContext).tenantId).toBe('sch_auto');

    // 3. User token without organizationId -> Admin
    const reqAdmin = {
      headers: {},
      user: { sub: 'admin_no_org' },
    } as unknown as AuthenticatedHttpRequest;
    await guard.canActivate(
      createMockExecutionContext(reqAdmin, handler, UnannotatedController),
    );
    expect((reqAdmin.ctx as RequestContext).namespace).toBe('esma-admin');
    expect((reqAdmin.ctx as RequestContext).tenantId).toBe('system');
  });
});
