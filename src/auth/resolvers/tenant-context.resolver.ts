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

      // Sub-tenant / Branch mapping
      const rawHeaderBranch = req.headers?.['x-branch-id'];
      const headerBranchId =
        typeof rawHeaderBranch === 'string' ? rawHeaderBranch : undefined;
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

      let subTenantId: string | undefined;

      if (headerBranchId && headerBranchId.trim().length > 0) {
        const trimmedBranch = headerBranchId.trim();
        assertSafeSegment(trimmedBranch, 'x-branch-id');
        if (
          tokenBranchIds.length > 0 &&
          !tokenBranchIds.includes(trimmedBranch)
        ) {
          throw new TenantMismatchError(
            `Header x-branch-id (${trimmedBranch}) is not among user's allowed branch grants`,
          );
        }
        subTenantId = trimmedBranch;
      } else if (tokenBranchIds.length > 0) {
        subTenantId = tokenBranchIds[0];
      }

      if (subTenantId) {
        assertSafeSegment(subTenantId, 'subTenantId');
      }

      // Actor ID: deterministic fallback
      const actorId = token.userId ?? token.sub ?? `token:${tokenTenantId}`;

      // Roles and Permissions normalization
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
      const roles = Array.from(
        new Set([...orgRoles, ...globalRoles, ...directRoles]),
      );

      const orgPerms = Array.isArray(token.access?.organization?.permissions)
        ? token.access.organization.permissions
        : [];
      const globalPerms = Array.isArray(token.access?.global?.permissions)
        ? token.access.global.permissions
        : [];
      const directPerms = Array.isArray(token.permissions)
        ? token.permissions
        : [];
      const permissions = Array.from(
        new Set([...orgPerms, ...globalPerms, ...directPerms]),
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
        subTenantId,
        actor: {
          id: String(actorId),
          type: 'user',
          roles,
          permissions,
          scopes: [],
          isPlatformAdmin: Boolean(token.platformAdmin),
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
