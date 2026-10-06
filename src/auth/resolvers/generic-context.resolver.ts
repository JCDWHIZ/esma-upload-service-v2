import { Injectable } from '@nestjs/common';
import {
  AuthenticatedHttpRequest,
  ContextResolver,
  RequestContext,
  VerifiedTokenClaims,
  freezeContext,
  parseAttributes,
} from '../context.js';
import {
  TenantMismatchError,
  UnauthenticatedError,
  ValidationError,
} from '../../core/errors/app-error.js';
import { assertSafeSegment } from '../../core/storage-key.service.js';
import { getCorrelationId } from '../../observability/correlation-context.js';
import { resolveOrGenerateCorrelationId } from '../../observability/correlation-id.interceptor.js';
import {
  normalizePermissions,
  UploadPermissions,
} from '../../authz/permissions.js';
import { ApiClient } from '../../core/types.js';

@Injectable()
export class GenericContextResolver implements ContextResolver {
  resolve(req: AuthenticatedHttpRequest): Promise<RequestContext> {
    try {
      const rawClient =
        req.apiClient ??
        (req.principal &&
        typeof req.principal === 'object' &&
        'keyPrefix' in req.principal
          ? (req.principal as ApiClient)
          : undefined);

      const client = rawClient;
      if (!client || typeof client !== 'object' || !client.id) {
        const rawToken =
          req.user ??
          req.token ??
          (req.principal &&
          typeof req.principal === 'object' &&
          !('keyPrefix' in req.principal)
            ? req.principal
            : undefined);

        if (!rawToken || typeof rawToken !== 'object') {
          throw new UnauthenticatedError(
            'Authentication is required to resolve generic context',
          );
        }

        const token = rawToken as VerifiedTokenClaims;

        // Handle JWT token authentication in generic context
        const namespace =
          typeof req.headers?.['x-namespace'] === 'string' &&
          req.headers['x-namespace'].trim().length > 0
            ? req.headers['x-namespace'].trim()
            : ((token.namespace as string | undefined) ?? 'generic');
        assertSafeSegment(namespace, 'namespace');

        const tokenTenantId: string | undefined =
          typeof token.organizationId === 'string'
            ? token.organizationId
            : typeof token.schoolId === 'string'
              ? token.schoolId
              : typeof token.tenantId === 'string'
                ? token.tenantId
                : undefined;

        const rawTokenRoles = [
          ...(Array.isArray(token.roles)
            ? token.roles
            : typeof token.role === 'string'
              ? [token.role]
              : []),
          ...(Array.isArray(token.groups)
            ? (token.groups as unknown[]).filter(
                (g): g is string => typeof g === 'string',
              )
            : []),
          ...(Array.isArray(token.access?.global?.roles)
            ? token.access.global.roles
            : []),
          ...(Array.isArray(token.access?.organization?.roles)
            ? token.access.organization.roles
            : []),
        ].filter(
          (r): r is string => typeof r === 'string' && r.trim().length > 0,
        );

        const globalPerms = Array.isArray(token.access?.global?.permissions)
          ? token.access.global.permissions
          : [];
        const orgPerms = Array.isArray(token.access?.organization?.permissions)
          ? token.access.organization.permissions
          : [];
        const directPerms = Array.isArray(token.permissions)
          ? token.permissions
          : [];
        const rawPerms =
          globalPerms.length > 0 ? globalPerms : [...orgPerms, ...directPerms];
        const permissions = normalizePermissions(rawPerms);

        const isPlatformAdmin = permissions.some((p) =>
          [
            UploadPermissions.QUOTAS_MANAGE,
            UploadPermissions.QUOTAS_VIEW,
            'storage_quota_view',
            'storage_quota_edit',
            UploadPermissions.SYSTEM_FILES_UPLOAD,
            UploadPermissions.SYSTEM_FILES_DELETE,
            UploadPermissions.SYSTEM_FILES_READ,
            UploadPermissions.SYSTEM_FILES_LIST,
            UploadPermissions.TENANTS_USAGE_VIEW,
            UploadPermissions.AUDIT_VIEW,
            UploadPermissions.FILES_BULK_DELETE,
          ].includes(p),
        );

        const rawHeaderTenant = req.headers?.['x-tenant-id'];
        let tenantId: string;

        if (
          typeof rawHeaderTenant === 'string' &&
          rawHeaderTenant.trim().length > 0
        ) {
          const headerTenant = rawHeaderTenant.trim();
          if (tokenTenantId && !isPlatformAdmin) {
            if (headerTenant !== tokenTenantId) {
              throw new TenantMismatchError(
                `Header x-tenant-id (${headerTenant}) does not match token tenant ID (${tokenTenantId})`,
                { code: 'TENANT_MISMATCH' },
              );
            }
          }
          tenantId = headerTenant;
        } else if (tokenTenantId) {
          tenantId = tokenTenantId;
        } else if (isPlatformAdmin) {
          tenantId = 'system';
        } else {
          throw new ValidationError(
            'Header x-tenant-id or token tenant claim is required for generic context',
          );
        }
        assertSafeSegment(tenantId, 'tenantId');

        const rawSubTenant = req.headers?.['x-sub-tenant-id'];
        let subTenantId: string | undefined;
        if (
          typeof rawSubTenant === 'string' &&
          rawSubTenant.trim().length > 0
        ) {
          subTenantId = rawSubTenant.trim();
          assertSafeSegment(subTenantId, 'subTenantId');
        } else if (
          typeof token.branchId === 'string' &&
          token.branchId.trim().length > 0
        ) {
          subTenantId = token.branchId.trim();
        }

        const rawAttributes =
          req.headers?.['x-attributes'] ??
          (req.body as { attributes?: unknown } | undefined)?.attributes;
        const attributes = parseAttributes(rawAttributes);

        const correlationId =
          getCorrelationId() ??
          resolveOrGenerateCorrelationId(req.headers?.['x-correlation-id']);
        const ipAddress = req.ip ?? req.socket?.remoteAddress ?? '127.0.0.1';
        const userAgent =
          typeof req.headers?.['user-agent'] === 'string'
            ? req.headers['user-agent']
            : undefined;

        const jwtContext: RequestContext = {
          namespace,
          tenantId,
          subTenantId,
          actor: {
            id:
              typeof token.sub === 'string'
                ? token.sub
                : typeof token.userId === 'string'
                  ? token.userId
                  : 'anonymous',
            type: 'user',
            roles: rawTokenRoles,
            permissions,
            scopes: Array.isArray(token.scopes)
              ? (token.scopes as unknown[]).filter(
                  (s): s is string => typeof s === 'string',
                )
              : [],
            isPlatformAdmin,
          },
          correlationId,
          ipAddress,
          userAgent,
          attributes,
        };

        return Promise.resolve(freezeContext(jwtContext));
      }

      const namespace = client.namespace;
      if (!namespace || typeof namespace !== 'string') {
        throw new ValidationError(
          'API client has an invalid or missing namespace',
        );
      }
      assertSafeSegment(namespace, 'client.namespace');

      // Header x-namespace verification if provided
      const headerNamespace = req.headers?.['x-namespace'];
      if (headerNamespace !== undefined) {
        if (
          typeof headerNamespace !== 'string' ||
          headerNamespace.trim() !== namespace
        ) {
          throw new TenantMismatchError(
            `Header x-namespace (${String(headerNamespace)}) does not match client namespace (${namespace})`,
            {
              code: 'TENANT_MISMATCH',
            },
          );
        }
      }

      // Tenant resolution and authorization
      const rawHeaderTenantId = req.headers?.['x-tenant-id'];
      let tenantId: string;

      if (
        typeof rawHeaderTenantId === 'string' &&
        rawHeaderTenantId.trim().length > 0
      ) {
        tenantId = rawHeaderTenantId.trim();
      } else if (
        Array.isArray(client.tenantIds) &&
        client.tenantIds.length === 1 &&
        !client.allowAnyTenant
      ) {
        tenantId = client.tenantIds[0];
      } else {
        throw new ValidationError(
          'Header x-tenant-id is required for generic context',
        );
      }

      assertSafeSegment(tenantId, 'x-tenant-id');

      // Tenant boundary check
      if (!client.allowAnyTenant) {
        const allowedTenants = Array.isArray(client.tenantIds)
          ? client.tenantIds
          : [];
        if (!allowedTenants.includes(tenantId)) {
          throw new TenantMismatchError(
            `API client '${client.name ?? client.id}' is not authorized to access tenant '${tenantId}'`,
            {
              code: 'TENANT_MISMATCH',
            },
          );
        }
      }

      // Sub-tenant resolution
      const rawSubTenantId = req.headers?.['x-sub-tenant-id'];
      let subTenantId: string | undefined;
      if (
        typeof rawSubTenantId === 'string' &&
        rawSubTenantId.trim().length > 0
      ) {
        subTenantId = rawSubTenantId.trim();
        assertSafeSegment(subTenantId, 'x-sub-tenant-id');
      }

      // Attributes parsing
      const rawAttributes =
        req.headers?.['x-attributes'] ??
        (req.body as { attributes?: unknown } | undefined)?.attributes;
      const attributes = parseAttributes(rawAttributes);

      // Network & Correlation metadata
      const correlationId =
        getCorrelationId() ??
        resolveOrGenerateCorrelationId(req.headers?.['x-correlation-id']);
      const ipAddress = req.ip ?? req.socket?.remoteAddress ?? '127.0.0.1';
      const userAgent =
        typeof req.headers?.['user-agent'] === 'string'
          ? req.headers['user-agent']
          : undefined;

      const context: RequestContext = {
        namespace,
        tenantId,
        subTenantId,
        actor: {
          id: String(client.id),
          type: 'service',
          roles: [],
          permissions: [],
          scopes: Array.isArray(client.scopes) ? client.scopes : [],
          isPlatformAdmin: false,
        },
        correlationId,
        ipAddress,
        userAgent,
        attributes,
      };

      return Promise.resolve(freezeContext(context));
    } catch (err) {
      return Promise.reject(
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }
}
