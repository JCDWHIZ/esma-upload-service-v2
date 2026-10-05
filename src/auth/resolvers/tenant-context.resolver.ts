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
} from '../../core/errors/app-error.js';
import { assertSafeSegment } from '../../core/storage-key.service.js';
import { getCorrelationId } from '../../observability/correlation-context.js';
import { resolveOrGenerateCorrelationId } from '../../observability/correlation-id.interceptor.js';
import {
  UploadPermissions,
  normalizePermissions,
  type UploadPermission,
} from '../../authz/permissions.js';

@Injectable()
export class EsmaTenantContextResolver implements ContextResolver {
  resolve(req: AuthenticatedHttpRequest): Promise<RequestContext> {
    try {
      const rawToken =
        req.user ??
        req.token ??
        (req.principal as VerifiedTokenClaims | undefined);
      if (!rawToken || typeof rawToken !== 'object') {
        throw new UnauthenticatedError(
          'Authentication token is required to resolve tenant context',
        );
      }
      const token = rawToken;

      // Tenant / Organization mapping
      const tokenTenantId = token.organizationId ?? token.schoolId;
      if (!tokenTenantId || typeof tokenTenantId !== 'string') {
        throw new UnauthenticatedError(
          'Token is missing organizationId / schoolId for tenant context',
        );
      }

      // Validate against x-school-id header if supplied
      const headerSchoolId = req.headers?.['x-school-id'];
      if (headerSchoolId !== undefined) {
        if (
          typeof headerSchoolId !== 'string' ||
          headerSchoolId !== tokenTenantId
        ) {
          throw new TenantMismatchError(
            `Header x-school-id (${String(headerSchoolId)}) does not match token tenant ID (${tokenTenantId})`,
          );
        }
      }

      assertSafeSegment(tokenTenantId, 'tenantId');

      // Branch mapping from token claims
      const tokenBranchId = token.branchId;
      const tokenBranches = Array.isArray(token.branches) ? token.branches : [];

      const tokenBranchIds: string[] = [];
      if (
        typeof tokenBranchId === 'string' &&
        tokenBranchId.trim().length > 0
      ) {
        tokenBranchIds.push(tokenBranchId.trim());
      }
      for (const b of tokenBranches) {
        if (typeof b === 'string' && b.trim().length > 0) {
          tokenBranchIds.push(b.trim());
        } else if (
          typeof b === 'object' &&
          b !== null &&
          'id' in b &&
          typeof b.id === 'string' &&
          b.id.trim().length > 0
        ) {
          tokenBranchIds.push(b.id.trim());
        }
      }
      const uniqueBranchGrants = Array.from(new Set(tokenBranchIds));

      // Actor ID: deterministic fallback
      const actorId = token.userId ?? token.sub ?? `token:${tokenTenantId}`;

      // Roles normalization
      const orgRoles = Array.isArray(token.access?.organization?.roles)
        ? token.access.organization.roles
        : [];
      const globalRoles = Array.isArray(token.access?.global?.roles)
        ? token.access.global.roles
        : [];
      const directRoles = Array.isArray(token.roles)
        ? token.roles
        : typeof token.role === 'string' && token.role.trim().length > 0
          ? [token.role.trim()]
          : [];
      const groupRoles = Array.isArray(token.groups)
        ? token.groups
        : [];
      const roles = Array.from(
        new Set(
          [...orgRoles, ...globalRoles, ...directRoles, ...groupRoles]
            .filter(
              (r): r is string => typeof r === 'string' && r.trim().length > 0,
            )
            .map((r) => r.trim()),
        ),
      );

      // Permissions normalization: search access.global.permissions for endpoint permissions.
      // Falls back to org/direct permissions only when global permissions are not provided.
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
        globalPerms.length > 0
          ? globalPerms
          : [...orgPerms, ...directPerms];
      const permissions = normalizePermissions(rawPerms);

      const isSchoolAdmin =
        permissions.includes(UploadPermissions.BRANCHES_MANAGE) ||
        permissions.includes(UploadPermissions.QUOTAS_VIEW);

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
        ].includes(p as UploadPermission),
      );

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
        namespace: 'esma-tenant',
        tenantId: tokenTenantId,
        subTenantId: undefined,
        actor: {
          id: String(actorId),
          type: 'user',
          roles,
          permissions,
          scopes: [],
          isPlatformAdmin,
          branchGrants: uniqueBranchGrants,
          isSchoolAdmin,
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
