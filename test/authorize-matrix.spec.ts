import {
  authorize,
  AuthzAction,
  AuthzResource,
} from '../src/authz/authorize.js';
import { RequestContext } from '../src/auth/context.js';
import { UploadPermissions } from '../src/authz/permissions.js';

describe('ARCH §4.2 Authorization Matrix Table Tests', () => {
  const createRequestContext = (
    overrides: Partial<RequestContext> = {},
  ): RequestContext => ({
    namespace: 'esma-tenant',
    tenantId: 'school-123',
    subTenantId: undefined,
    actor: {
      id: 'user-1',
      type: 'user',
      roles: ['teacher'],
      permissions: ['files_upload', 'files_read', 'files_delete'],
      scopes: [],
      branchGrants: [],
      isSchoolAdmin: false,
    },
    correlationId: 'test-corr-id',
    ipAddress: '127.0.0.1',
    attributes: {},
    ...overrides,
  });

  describe('School-Level Token (no branch restriction)', () => {
    const schoolTokenCtx = createRequestContext({
      actor: {
        id: 'principal-1',
        type: 'user',
        roles: ['admin'],
        permissions: [
          UploadPermissions.BRANCHES_MANAGE,
          UploadPermissions.QUOTAS_VIEW,
        ],
        scopes: [],
        branchGrants: [],
        isSchoolAdmin: true,
      },
    });

    it('Upload at school scope -> Allow', () => {
      const resource: AuthzResource = {
        namespace: 'esma-tenant',
        tenantId: 'school-123',
        subTenantId: null,
      };
      const decision = authorize(schoolTokenCtx, 'upload', resource);
      expect(decision.allowed).toBe(true);
      expect(decision.ruleId).toBe('TENANT_UPLOAD_SCHOOL_SCOPE_ALLOWED');
    });

    it('Upload at branch B -> Allow', () => {
      const resource: AuthzResource = {
        namespace: 'esma-tenant',
        tenantId: 'school-123',
        subTenantId: 'branch-b',
      };
      const decision = authorize(schoolTokenCtx, 'upload', resource);
      expect(decision.allowed).toBe(true);
      expect(decision.ruleId).toBe('TENANT_UPLOAD_SCHOOL_TOKEN_BRANCH_ALLOWED');
    });

    it('List school scope -> Allow', () => {
      const resource: AuthzResource = {
        namespace: 'esma-tenant',
        tenantId: 'school-123',
        subTenantId: null,
      };
      const decision = authorize(schoolTokenCtx, 'list', resource);
      expect(decision.allowed).toBe(true);
      expect(decision.ruleId).toBe('TENANT_LIST_SCHOOL_SCOPE_ALLOWED');
    });

    it('List branch B -> Allow', () => {
      const resource: AuthzResource = {
        namespace: 'esma-tenant',
        tenantId: 'school-123',
        subTenantId: 'branch-b',
      };
      const decision = authorize(schoolTokenCtx, 'list', resource);
      expect(decision.allowed).toBe(true);
      expect(decision.ruleId).toBe('TENANT_LIST_SCHOOL_TOKEN_BRANCH_ALLOWED');
    });

    it('Delete file at school scope -> Allow if file.tenantId === token school', () => {
      const resource: AuthzResource = {
        namespace: 'esma-tenant',
        tenantId: 'school-123',
        subTenantId: null,
      };
      const decision = authorize(schoolTokenCtx, 'delete', resource);
      expect(decision.allowed).toBe(true);
      expect(decision.ruleId).toBe('TENANT_DELETE_SCHOOL_SCOPE_ALLOWED');
    });

    it('Delete file at branch scope -> Allow for school-level token', () => {
      const resource: AuthzResource = {
        namespace: 'esma-tenant',
        tenantId: 'school-123',
        subTenantId: 'branch-b',
      };
      const decision = authorize(schoolTokenCtx, 'delete', resource);
      expect(decision.allowed).toBe(true);
      expect(decision.ruleId).toBe('TENANT_DELETE_SCHOOL_SCOPE_ALLOWED');
    });

    it('Read file with tenant visibility -> Allow for same school', () => {
      const resource: AuthzResource = {
        namespace: 'esma-tenant',
        tenantId: 'school-123',
        visibility: 'tenant',
      };
      const decision = authorize(schoolTokenCtx, 'read', resource);
      expect(decision.allowed).toBe(true);
      expect(decision.ruleId).toBe('TENANT_READ_TENANT_VISIBILITY_ALLOWED');
    });
  });

  describe('Branch-Level Token (assigned branch grant: branch-b)', () => {
    const branchTokenCtx = createRequestContext({
      subTenantId: 'branch-b',
      actor: {
        id: 'teacher-branch-b',
        type: 'user',
        roles: ['teacher'],
        permissions: ['files_upload', 'files_read', 'files_delete'],
        scopes: [],
        branchGrants: ['branch-b'],
        isSchoolAdmin: false,
      },
    });

    it('Upload at school scope -> Deny (BRANCH_SCOPE_REQUIRED)', () => {
      const resource: AuthzResource = {
        namespace: 'esma-tenant',
        tenantId: 'school-123',
        subTenantId: null,
      };
      const decision = authorize(branchTokenCtx, 'upload', resource);
      expect(decision.allowed).toBe(false);
      expect(decision.ruleId).toBe(
        'TENANT_UPLOAD_BRANCH_TOKEN_CANNOT_UPLOAD_SCHOOL_SCOPE',
      );
    });

    it('Upload at permitted branch B -> Allow', () => {
      const resource: AuthzResource = {
        namespace: 'esma-tenant',
        tenantId: 'school-123',
        subTenantId: 'branch-b',
      };
      const decision = authorize(branchTokenCtx, 'upload', resource);
      expect(decision.allowed).toBe(true);
      expect(decision.ruleId).toBe('TENANT_UPLOAD_BRANCH_ALLOWED');
    });

    it('Upload at different branch C -> Deny', () => {
      const resource: AuthzResource = {
        namespace: 'esma-tenant',
        tenantId: 'school-123',
        subTenantId: 'branch-c',
      };
      const decision = authorize(branchTokenCtx, 'upload', resource);
      expect(decision.allowed).toBe(false);
      expect(decision.ruleId).toBe('TENANT_UPLOAD_BRANCH_MISMATCH');
    });

    it('List school scope -> Deny (BRANCH_SCOPE_REQUIRED)', () => {
      const resource: AuthzResource = {
        namespace: 'esma-tenant',
        tenantId: 'school-123',
        subTenantId: null,
      };
      const decision = authorize(branchTokenCtx, 'list', resource);
      expect(decision.allowed).toBe(false);
      expect(decision.ruleId).toBe(
        'TENANT_LIST_BRANCH_TOKEN_CANNOT_LIST_SCHOOL_SCOPE',
      );
    });

    it('List permitted branch B -> Allow', () => {
      const resource: AuthzResource = {
        namespace: 'esma-tenant',
        tenantId: 'school-123',
        subTenantId: 'branch-b',
      };
      const decision = authorize(branchTokenCtx, 'list', resource);
      expect(decision.allowed).toBe(true);
      expect(decision.ruleId).toBe('TENANT_LIST_BRANCH_ALLOWED');
    });

    it('List different branch C -> Deny', () => {
      const resource: AuthzResource = {
        namespace: 'esma-tenant',
        tenantId: 'school-123',
        subTenantId: 'branch-c',
      };
      const decision = authorize(branchTokenCtx, 'list', resource);
      expect(decision.allowed).toBe(false);
      expect(decision.ruleId).toBe('TENANT_LIST_BRANCH_MISMATCH');
    });

    it('Delete file belonging to permitted branch B -> Allow', () => {
      const resource: AuthzResource = {
        namespace: 'esma-tenant',
        tenantId: 'school-123',
        subTenantId: 'branch-b',
      };
      const decision = authorize(branchTokenCtx, 'delete', resource);
      expect(decision.allowed).toBe(true);
      expect(decision.ruleId).toBe('TENANT_DELETE_BRANCH_SCOPE_ALLOWED');
    });

    it('Delete file belonging to different branch C -> Deny (F-42 strict check)', () => {
      const resource: AuthzResource = {
        namespace: 'esma-tenant',
        tenantId: 'school-123',
        subTenantId: 'branch-c',
      };
      const decision = authorize(branchTokenCtx, 'delete', resource);
      expect(decision.allowed).toBe(false);
      expect(decision.ruleId).toBe('TENANT_DELETE_BRANCH_MISMATCH');
    });

    it('Delete school root file -> Deny for branch token', () => {
      const resource: AuthzResource = {
        namespace: 'esma-tenant',
        tenantId: 'school-123',
        subTenantId: null,
      };
      const decision = authorize(branchTokenCtx, 'delete', resource);
      expect(decision.allowed).toBe(false);
      expect(decision.ruleId).toBe('TENANT_DELETE_BRANCH_MISMATCH');
    });

    it('Read file with tenant visibility -> Allow if in same school', () => {
      const resource: AuthzResource = {
        namespace: 'esma-tenant',
        tenantId: 'school-123',
        subTenantId: 'branch-c', // even if stored under another branch, tenant visibility allows it
        visibility: 'tenant',
      };
      const decision = authorize(branchTokenCtx, 'read', resource);
      expect(decision.allowed).toBe(true);
      expect(decision.ruleId).toBe('TENANT_READ_TENANT_VISIBILITY_ALLOWED');
    });
  });

  describe('Visibility Rules (ARCH §4.3)', () => {
    const regularUserCtx = createRequestContext({
      actor: {
        id: 'user-alice',
        type: 'user',
        roles: ['teacher'],
        permissions: ['files_read'],
        scopes: [],
        branchGrants: [],
        isSchoolAdmin: false,
      },
    });

    const schoolAdminCtx = createRequestContext({
      actor: {
        id: 'admin-bob',
        type: 'user',
        roles: ['admin'],
        permissions: ['branches_manage', 'quotas_view', 'files_admin'],
        scopes: [],
        branchGrants: [],
        isSchoolAdmin: true,
      },
    });

    it('public visibility: allowed unconditionally', () => {
      const resource: AuthzResource = {
        namespace: 'esma-tenant',
        tenantId: 'other-school',
        visibility: 'public',
      };
      const decision = authorize(regularUserCtx, 'read', resource);
      expect(decision.allowed).toBe(true);
      expect(decision.ruleId).toBe('PUBLIC_VISIBILITY_ALLOWED');
    });

    it('tenant visibility: allowed within same tenant', () => {
      const resource: AuthzResource = {
        namespace: 'esma-tenant',
        tenantId: 'school-123',
        visibility: 'tenant',
      };
      const decision = authorize(regularUserCtx, 'read', resource);
      expect(decision.allowed).toBe(true);
      expect(decision.ruleId).toBe('TENANT_READ_TENANT_VISIBILITY_ALLOWED');
    });

    it('tenant visibility: rejected across different tenants', () => {
      const resource: AuthzResource = {
        namespace: 'esma-tenant',
        tenantId: 'different-school',
        visibility: 'tenant',
      };
      const decision = authorize(regularUserCtx, 'read', resource);
      expect(decision.allowed).toBe(false);
      expect(decision.ruleId).toBe('TENANT_MISMATCH');
    });

    it('private visibility: allowed for uploader', () => {
      const resource: AuthzResource = {
        namespace: 'esma-tenant',
        tenantId: 'school-123',
        uploadedBy: 'user-alice',
        visibility: 'private',
      };
      const decision = authorize(regularUserCtx, 'read', resource);
      expect(decision.allowed).toBe(true);
      expect(decision.ruleId).toBe('PRIVATE_VISIBILITY_OWNER_ALLOWED');
    });

    it('private visibility: allowed for school admin in same school', () => {
      const resource: AuthzResource = {
        namespace: 'esma-tenant',
        tenantId: 'school-123',
        uploadedBy: 'user-alice',
        visibility: 'private',
      };
      const decision = authorize(schoolAdminCtx, 'read', resource);
      expect(decision.allowed).toBe(true);
      expect(decision.ruleId).toBe('PRIVATE_VISIBILITY_ADMIN_ALLOWED');
    });

    it('private visibility: denied for non-uploader non-admin', () => {
      const otherUserCtx = createRequestContext({
        actor: {
          id: 'user-charlie',
          type: 'user',
          roles: ['teacher'],
          permissions: ['files_read'],
          scopes: [],
          branchGrants: [],
          isSchoolAdmin: false,
        },
      });
      const resource: AuthzResource = {
        namespace: 'esma-tenant',
        tenantId: 'school-123',
        uploadedBy: 'user-alice',
        visibility: 'private',
      };
      const decision = authorize(otherUserCtx, 'read', resource);
      expect(decision.allowed).toBe(false);
      expect(decision.ruleId).toBe('PRIVATE_VISIBILITY_DENIED');
    });
  });

  describe('ESMA Admin Platform Authority', () => {
    it('allows ESMA admin identified by configurable role', () => {
      const esmaAdminCtx = createRequestContext({
        namespace: 'esma-admin',
        tenantId: 'system',
        actor: {
          id: 'admin-super',
          type: 'user',
          roles: ['SUPER ADMIN'],
          permissions: [],
          scopes: [],
          branchGrants: [],
        },
      });

      const resource: AuthzResource = {
        namespace: 'esma-admin',
        tenantId: 'system',
      };

      const decision = authorize(esmaAdminCtx, 'admin', resource, [
        'SUPER ADMIN',
        'superadmin',
      ]);
      expect(decision.allowed).toBe(true);
      expect(decision.ruleId).toBe('ESMA_ADMIN_AUTHORIZED');
    });

    it('allows ESMA admin identified by canonical permission (quotas_manage)', () => {
      const esmaAdminCtx = createRequestContext({
        namespace: 'esma-admin',
        tenantId: 'system',
        actor: {
          id: 'admin-perm',
          type: 'user',
          roles: ['auditor'],
          permissions: [UploadPermissions.QUOTAS_MANAGE],
          scopes: [],
          branchGrants: [],
        },
      });

      const resource: AuthzResource = {
        namespace: 'esma-tenant',
        tenantId: 'any-school',
      };

      const decision = authorize(esmaAdminCtx, 'read', resource);
      expect(decision.allowed).toBe(true);
      expect(decision.ruleId).toBe('ESMA_ADMIN_AUTHORIZED');
    });
  });

  describe('Generic API Client Scopes', () => {
    const createClientCtx = (scopes: string[]): RequestContext => ({
      namespace: 'custom-partner',
      tenantId: 'client-tenant',
      actor: {
        id: 'client-service-1',
        type: 'service',
        roles: [],
        permissions: [],
        scopes,
      },
      correlationId: 'corr-client',
      ipAddress: '10.0.0.1',
      attributes: {},
    });

    const resource: AuthzResource = {
      namespace: 'custom-partner',
      tenantId: 'client-tenant',
    };

    it('allows upload when client has files:write scope', () => {
      const ctx = createClientCtx(['files:write']);
      const decision = authorize(ctx, 'upload', resource);
      expect(decision.allowed).toBe(true);
      expect(decision.ruleId).toBe('GENERIC_ACTION_ALLOWED');
    });

    it('denies upload when client only has files:read scope', () => {
      const ctx = createClientCtx(['files:read']);
      const decision = authorize(ctx, 'upload', resource);
      expect(decision.allowed).toBe(false);
      expect(decision.ruleId).toBe('GENERIC_SCOPE_MISSING');
    });

    it('allows all operations when client has wildcard * or files:admin scope', () => {
      const ctx = createClientCtx(['*']);
      const actions: AuthzAction[] = [
        'upload',
        'read',
        'list',
        'delete',
        'admin',
      ];
      for (const action of actions) {
        const decision = authorize(ctx, action, resource);
        expect(decision.allowed).toBe(true);
      }
    });
  });
});
