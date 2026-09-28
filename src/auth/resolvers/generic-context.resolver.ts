import { Injectable } from '@nestjs/common';
import {
  AuthenticatedHttpRequest,
  ContextResolver,
  RequestContext,
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

        // Handle JWT token authentication in generic context
        const namespace =
          typeof req.headers?.['x-namespace'] === 'string' &&
          req.headers['x-namespace'].trim().length > 0
            ? req.headers['x-namespace'].trim()
            : ((rawToken.namespace as string | undefined) ?? 'generic');
        assertSafeSegment(namespace, 'namespace');

        const tokenTenantId: string | undefined =
          typeof rawToken.organizationId === 'string'
            ? rawToken.organizationId
            : typeof rawToken.schoolId === 'string'
              ? rawToken.schoolId
              : typeof rawToken.tenantId === 'string'
                ? rawToken.tenantId
                : undefined;

        const rawHeaderTenant = req.headers?.['x-tenant-id'];
        let tenantId: string;

        if (
          typeof rawHeaderTenant === 'string' &&
          rawHeaderTenant.trim().length > 0
        ) {
          const headerTenant = rawHeaderTenant.trim();
          if (tokenTenantId && !rawToken.platformAdmin) {
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
        } else if (rawToken.platformAdmin) {
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
        } else if (rawToken.branchId) {
          subTenantId = rawToken.branchId;
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
              typeof rawToken.sub === 'string'
                ? rawToken.sub
                : typeof rawToken.userId === 'string'
                  ? rawToken.userId
                  : 'anonymous',
            type: 'user',
            roles: Array.isArray(rawToken.roles)
              ? rawToken.roles
              : rawToken.role
                ? [rawToken.role]
                : [],
            permissions: Array.isArray(rawToken.permissions)
              ? rawToken.permissions
              : [],
            scopes: Array.isArray(rawToken.scopes)
              ? (rawToken.scopes as string[])
              : [],
            isPlatformAdmin: Boolean(rawToken.platformAdmin),
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
