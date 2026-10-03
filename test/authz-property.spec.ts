import * as fc from 'fast-check';
import {
  authorize,
  AuthzAction,
  AuthzResource,
} from '../src/authz/authorize.js';
import { RequestContext } from '../src/auth/context.js';

describe('Authorization Property-Based Tests (fast-check)', () => {
  const actions: AuthzAction[] = ['upload', 'read', 'list', 'delete', 'admin'];

  // Arbitrary safe alphanumeric ID (1-32 chars)
  const safeIdArb = fc.stringMatching(/^[a-zA-Z0-9_-]{1,32}$/);

  it('Property: For any two distinct tenants, no action is allowed across them for non-admin callers', () => {
    fc.assert(
      fc.property(
        safeIdArb,
        safeIdArb,
        fc.constantFrom(...actions),
        fc.constantFrom('tenant' as const, 'private' as const),
        (tenantA, tenantB, action, visibility) => {
          // Pre-condition: tenants must be distinct
          fc.pre(tenantA !== tenantB);

          const ctx: RequestContext = {
            namespace: 'esma-tenant',
            tenantId: tenantA,
            subTenantId: undefined,
            actor: {
              id: 'user-a',
              type: 'user',
              roles: ['teacher', 'user'],
              permissions: ['files_upload', 'files_read', 'files_delete'],
              scopes: [],
              branchGrants: [],
              isSchoolAdmin: false,
            },
            correlationId: 'prop-test-corr',
            ipAddress: '127.0.0.1',
            attributes: {},
          };

          const resource: AuthzResource = {
            namespace: 'esma-tenant',
            tenantId: tenantB,
            visibility,
          };

          const decision = authorize(ctx, action, resource);
          expect(decision.allowed).toBe(false);
          expect(decision.ruleId).toBe('TENANT_MISMATCH');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Property (F-42): String prefix collisions (e.g. sch_1 vs sch_10, b1 vs b10) never permit access', () => {
    fc.assert(
      fc.property(
        safeIdArb,
        safeIdArb,
        fc.constantFrom('0', '1', '_ext', '-suffix'),
        (baseTenant, baseBranch, suffix) => {
          const tenantA = baseTenant;
          const tenantB = `${baseTenant}${suffix}`;
          const branchA = baseBranch;
          const branchB = `${baseBranch}${suffix}`;

          // Precondition: suffix made them different
          fc.pre(tenantA !== tenantB && branchA !== branchB);

          // Test 1: Tenant prefix collision
          const tenantCtx: RequestContext = {
            namespace: 'esma-tenant',
            tenantId: tenantA,
            actor: {
              id: 'user-tenant-a',
              type: 'user',
              roles: ['admin'],
              permissions: [],
              scopes: [],
              isSchoolAdmin: true,
            },
            correlationId: 'f42-corr',
            ipAddress: '127.0.0.1',
            attributes: {},
          };

          const foreignTenantResource: AuthzResource = {
            namespace: 'esma-tenant',
            tenantId: tenantB,
            visibility: 'tenant',
          };

          const tenantDecision = authorize(
            tenantCtx,
            'read',
            foreignTenantResource,
          );
          expect(tenantDecision.allowed).toBe(false);
          expect(tenantDecision.ruleId).toBe('TENANT_MISMATCH');

          // Test 2: Branch prefix collision on delete
          const branchCtx: RequestContext = {
            namespace: 'esma-tenant',
            tenantId: tenantA,
            subTenantId: branchA,
            actor: {
              id: 'user-branch-a',
              type: 'user',
              roles: ['teacher'],
              permissions: ['files_delete'],
              scopes: [],
              branchGrants: [branchA],
              isSchoolAdmin: false,
            },
            correlationId: 'f42-branch-corr',
            ipAddress: '127.0.0.1',
            attributes: {},
          };

          const foreignBranchResource: AuthzResource = {
            namespace: 'esma-tenant',
            tenantId: tenantA,
            subTenantId: branchB, // Prefix of branchA, but not equal!
          };

          const branchDecision = authorize(
            branchCtx,
            'delete',
            foreignBranchResource,
          );
          expect(branchDecision.allowed).toBe(false);
          expect(branchDecision.ruleId).toBe('TENANT_DELETE_BRANCH_MISMATCH');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Property: Mismatched namespaces without ESMA admin authority are always denied', () => {
    fc.assert(
      fc.property(
        safeIdArb,
        safeIdArb,
        safeIdArb,
        fc.constantFrom(...actions),
        (namespaceA, namespaceB, tenant, action) => {
          fc.pre(namespaceA !== namespaceB);

          const ctx: RequestContext = {
            namespace: namespaceA,
            tenantId: tenant,
            actor: {
              id: 'regular-user',
              type: 'user',
              roles: ['member'],
              permissions: [],
              scopes: [],
            },
            correlationId: 'ns-prop-corr',
            ipAddress: '127.0.0.1',
            attributes: {},
          };

          const resource: AuthzResource = {
            namespace: namespaceB,
            tenantId: tenant,
            visibility: 'tenant',
          };

          const decision = authorize(ctx, action, resource);
          expect(decision.allowed).toBe(false);
          expect(decision.ruleId).toBe('NAMESPACE_MISMATCH');
        },
      ),
      { numRuns: 100 },
    );
  });
});
