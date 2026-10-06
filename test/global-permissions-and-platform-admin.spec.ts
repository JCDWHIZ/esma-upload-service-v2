import { EsmaTenantContextResolver } from '../src/auth/resolvers/tenant-context.resolver.js';
import { EsmaAdminContextResolver } from '../src/auth/resolvers/admin-context.resolver.js';
import { GenericContextResolver } from '../src/auth/resolvers/generic-context.resolver.js';
import { AuthenticatedHttpRequest } from '../src/auth/context.js';
import {
  normalizePermission,
  normalizePermissions,
  UploadPermissions,
} from '../src/authz/permissions.js';
import { isEsmaAdminActor } from '../src/authz/matrix-rules.js';

describe('Global Permissions and Platform Admin without token.platformAdmin claim', () => {
  describe('normalizePermission & normalizePermissions', () => {
    it('normalizes upload.quoatas.view to canonical quotas_view', () => {
      expect(normalizePermission('upload.quoatas.view')).toBe('quotas_view');
      expect(normalizePermission('upload.quotas.view')).toBe('quotas_view');
    });

    it('normalizes upload.quoatas.manage and quotas edit variants', () => {
      expect(normalizePermission('upload.quoatas.manage')).toBe(
        'quotas_manage',
      );
      expect(normalizePermission('upload.quotas.manage')).toBe('quotas_manage');
      expect(normalizePermission('upload.quoatas.edit')).toBe('quotas_manage');
      expect(normalizePermission('upload.quotas.edit')).toBe('quotas_manage');
    });

    it('normalizes files and branches permissions with upload. prefix', () => {
      expect(normalizePermission('upload.files.upload')).toBe('files_upload');
      expect(normalizePermission('upload.files.read')).toBe('files_read');
      expect(normalizePermission('upload.files.view')).toBe('files_read');
      expect(normalizePermission('upload.files.list')).toBe('files_list');
      expect(normalizePermission('upload.files.delete')).toBe('files_delete');
      expect(normalizePermission('upload.branches.manage')).toBe(
        'branches_manage',
      );
    });

    it('includes canonical permission along with alias in normalizePermissions', () => {
      const perms = normalizePermissions(['upload.quoatas.view']);
      expect(perms).toContain(UploadPermissions.QUOTAS_VIEW);
      expect(perms).toContain('upload_quotas_view');
      expect(perms).toContain('upload_quoatas_view');
    });
  });

  describe('Context Resolvers with User Token Payload', () => {
    const userTokenPayload = {
      iss: 'identity-issuer',
      sub: 'user-guid-001',
      aud: 'upload-service',
      azp: 'backoffice-portal',
      organizationId: 'org-tenant-123',
      membershipId: 'mem-456',
      branchId: 'branch-main',
      branches: ['branch-main'],
      email: 'admin@school.ng',
      phone_number: '+2348012345678',
      loginId: 'first.last',
      name: 'First Last',
      permissionVersion: '9f3a1c2b',
      groups: ['portal-users'],
      access: {
        global: {
          roles: ['PLATFORM_ADMIN'],
          permissions: ['upload.quoatas.view'],
        },
        organization: {
          roles: ['BURSAR'],
          permissions: [],
        },
        client: {
          roles: ['portal-client'],
          permissions: [],
        },
      },
      // Note: platformAdmin boolean is intentionally omitted
    };

    it('TenantContextResolver: only searches access.global.permissions and derives isPlatformAdmin from PLATFORM_ADMIN role', async () => {
      const resolver = new EsmaTenantContextResolver();
      const req = {
        headers: {
          'x-correlation-id': 'corr-user-001',
        },
        user: userTokenPayload,
      } as unknown as AuthenticatedHttpRequest;

      const ctx = await resolver.resolve(req);

      expect(ctx.namespace).toBe('esma-tenant');
      expect(ctx.tenantId).toBe('org-tenant-123');
      expect(ctx.actor.id).toBe('user-guid-001');
      expect(ctx.actor.isPlatformAdmin).toBe(true);
      expect(ctx.actor.roles).toContain('PLATFORM_ADMIN');
      expect(ctx.actor.roles).toContain('BURSAR');
      expect(ctx.actor.roles).toContain('portal-users');
      expect(ctx.actor.permissions).toContain(UploadPermissions.QUOTAS_VIEW);
      expect(ctx.actor.isSchoolAdmin).toBe(true);

      // Verify that isEsmaAdminActor recognizes this actor as an ESMA / Platform Admin
      expect(isEsmaAdminActor(ctx)).toBe(true);
    });

    it('AdminContextResolver: resolves admin context correctly without token.platformAdmin', async () => {
      const resolver = new EsmaAdminContextResolver();
      const req = {
        headers: {
          'x-correlation-id': 'corr-admin-002',
        },
        user: userTokenPayload,
      } as unknown as AuthenticatedHttpRequest;

      const ctx = await resolver.resolve(req);

      expect(ctx.namespace).toBe('esma-admin');
      expect(ctx.tenantId).toBe('system');
      expect(ctx.actor.isPlatformAdmin).toBe(true);
      expect(ctx.actor.permissions).toContain(UploadPermissions.QUOTAS_VIEW);
      expect(isEsmaAdminActor(ctx)).toBe(true);
    });

    it('GenericContextResolver: resolves generic context correctly without token.platformAdmin', async () => {
      const resolver = new GenericContextResolver();
      const req = {
        headers: {
          'x-correlation-id': 'corr-generic-003',
        },
        user: userTokenPayload,
      } as unknown as AuthenticatedHttpRequest;

      const ctx = await resolver.resolve(req);

      expect(ctx.actor.isPlatformAdmin).toBe(true);
      expect(ctx.actor.permissions).toContain(UploadPermissions.QUOTAS_VIEW);
      expect(ctx.actor.roles).toContain('PLATFORM_ADMIN');
      expect(isEsmaAdminActor(ctx)).toBe(true);
    });
  });
});
