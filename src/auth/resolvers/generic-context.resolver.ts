import { Injectable, Optional } from '@nestjs/common';
import {
  AuthenticatedHttpRequest,
  ContextResolver,
  RequestContext,
  RequestContextActor,
  VerifiedTokenClaims,
  freezeContext,
  parseAttributes,
} from '../context.js';
import {
  NamespaceNotAllowedError,
  OrganizationMismatchError,
  OrganizationRequiredError,
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
import { AppConfigService } from '../../config/config.service.js';

@Injectable()
export class GenericContextResolver implements ContextResolver {
  constructor(@Optional() private readonly configService?: AppConfigService) {}

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

        // Parse scopes
        const scopes = [
          ...(typeof token.scope === 'string' ? token.scope.split(' ') : []),
          ...(Array.isArray(token.scopes) ? token.scopes : []),
        ]
          .map((s) => (typeof s === 'string' ? s.trim() : ''))
          .filter(Boolean);

        const isClientCredentials = token.grant_type === 'client_credentials';
        const isServicePrincipal =
          isClientCredentials && scopes.includes('internal.files');

        // Handle namespace selection: header X-Namespace is primary
        const headerNamespace = req.headers?.['x-namespace'];
        const namespace =
          typeof headerNamespace === 'string' &&
          headerNamespace.trim().length > 0
            ? headerNamespace.trim()
            : ((token.namespace as string | undefined) ?? 'generic-default');
        assertSafeSegment(namespace, 'namespace');

        // Check service client allowed namespaces (UR-02.5)
        if (isServicePrincipal) {
          const clientId = token.azp ?? token.sub ?? 'unknown-service';
          let allowedMap: Record<string, string[]> = {
            'esma-storage-client': ['*'],
          };
          try {
            const rawConfigMap =
              this.configService?.raw?.SERVICE_CLIENT_NAMESPACES;
            if (rawConfigMap) {
              allowedMap = JSON.parse(rawConfigMap) as Record<string, string[]>;
            }
          } catch {
            // fallback
          }
          const allowedList = allowedMap[clientId] ?? [];
          const hasAccess =
            allowedList.includes('*') || allowedList.includes(namespace);
          if (!hasAccess) {
            throw new NamespaceNotAllowedError(
              `Service client "${clientId}" is not authorized to access namespace "${namespace}"`,
            );
          }
        }

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
        const clientPerms = Array.isArray(token.access?.client?.permissions)
          ? token.access.client.permissions
          : [];

        const rawPerms = isServicePrincipal
          ? clientPerms
          : globalPerms.length > 0
            ? globalPerms
            : [...orgPerms, ...directPerms];
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
            'platform.files.admin',
          ].includes(p),
        );

        // Header resolution: accept X-Organization-Id or legacy x-tenant-id
        const rawHeaderOrg = (req.headers?.['x-organization-id'] ??
          req.headers?.['x-tenant-id']) as string | undefined;

        let tenantId: string;

        if (isServicePrincipal) {
          // UR-02: X-Organization-Id is required for service principals
          if (!rawHeaderOrg || rawHeaderOrg.trim().length === 0) {
            throw new OrganizationRequiredError(
              'Header X-Organization-Id is required for service principals',
            );
          }
          tenantId = rawHeaderOrg.trim();
        } else {
          // User token
          const tokenTenantId: string | undefined =
            typeof token.organizationId === 'string'
              ? token.organizationId
              : typeof token.schoolId === 'string'
                ? token.schoolId
                : typeof token.tenantId === 'string'
                  ? token.tenantId
                  : undefined;

          if (rawHeaderOrg && rawHeaderOrg.trim().length > 0 && tokenTenantId) {
            if (rawHeaderOrg.trim() !== tokenTenantId && !isPlatformAdmin) {
              throw new OrganizationMismatchError(
                `Header X-Organization-Id (${rawHeaderOrg.trim()}) does not match token organizationId (${tokenTenantId})`,
              );
            }
          }

          if (tokenTenantId) {
            tenantId = tokenTenantId;
          } else if (rawHeaderOrg && rawHeaderOrg.trim().length > 0) {
            tenantId = rawHeaderOrg.trim();
          } else if (isPlatformAdmin) {
            tenantId = 'system';
          } else {
            throw new ValidationError(
              'Header X-Organization-Id or token organizationId is required',
            );
          }
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

        let actor: RequestContextActor;
        if (isServicePrincipal) {
          const clientId = token.azp ?? token.sub ?? 'service-client';
          actor = {
            id: clientId,
            type: 'service',
            actingService: clientId,
            roles: [],
            permissions,
            scopes,
            isPlatformAdmin: false,
          };
        } else {
          actor = {
            id:
              typeof token.sub === 'string'
                ? token.sub
                : typeof token.userId === 'string'
                  ? token.userId
                  : 'anonymous',
            type: 'user',
            roles: rawTokenRoles,
            permissions,
            scopes,
            isPlatformAdmin,
            actSub: token.act?.sub,
            supportGrantId: token.supportGrantId,
          };
        }

        const rawTraceparent = req.headers?.['traceparent'];
        let traceId: string | undefined;
        if (typeof rawTraceparent === 'string') {
          const parts = rawTraceparent.split('-');
          if (parts.length >= 4 && parts[1]?.length === 32) {
            traceId = parts[1];
          }
        }

        const jwtContext: RequestContext = {
          namespace,
          tenantId,
          subTenantId,
          actor,
          correlationId,
          traceId,
          ipAddress,
          userAgent,
          attributes,
        };

        return Promise.resolve(freezeContext(jwtContext));
      }

      // API Client Resolution
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
          throw new OrganizationMismatchError(
            `Header x-namespace (${String(headerNamespace)}) does not match client namespace (${namespace})`,
          );
        }
      }

      // Tenant resolution: accept X-Organization-Id or legacy x-tenant-id
      const rawHeaderTenantId = (req.headers?.['x-organization-id'] ??
        req.headers?.['x-tenant-id']) as string | undefined;
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
        throw new OrganizationRequiredError(
          'Header X-Organization-Id is required for generic context',
        );
      }

      assertSafeSegment(tenantId, 'X-Organization-Id');

      // Tenant boundary check
      if (!client.allowAnyTenant) {
        const allowedTenants = Array.isArray(client.tenantIds)
          ? client.tenantIds
          : [];
        if (!allowedTenants.includes(tenantId)) {
          throw new OrganizationMismatchError(
            `API client '${client.name ?? client.id}' is not authorized to access tenant '${tenantId}'`,
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
          actingService: String(client.name ?? client.id),
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
