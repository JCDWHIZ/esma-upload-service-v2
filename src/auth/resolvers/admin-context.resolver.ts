import { Injectable } from '@nestjs/common';
import {
  AuthenticatedHttpRequest,
  ContextResolver,
  RequestContext,
  VerifiedTokenClaims,
  freezeContext,
  parseAttributes,
} from '../context.js';
import { UnauthenticatedError } from '../../core/errors/app-error.js';
import { getCorrelationId } from '../../observability/correlation-context.js';
import { resolveOrGenerateCorrelationId } from '../../observability/correlation-id.interceptor.js';
import { normalizePermissions } from '../../authz/permissions.js';

@Injectable()
export class EsmaAdminContextResolver implements ContextResolver {
  resolve(req: AuthenticatedHttpRequest): Promise<RequestContext> {
    try {
      const rawToken =
        req.user ??
        req.token ??
        (req.principal as VerifiedTokenClaims | undefined);
      if (!rawToken || typeof rawToken !== 'object') {
        throw new UnauthenticatedError(
          'Authentication token is required to resolve admin context',
        );
      }
      const token = rawToken;

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
      const permissions = normalizePermissions([
        ...orgPerms,
        ...globalPerms,
        ...directPerms,
      ]);

      // Actor ID: deterministic fallback
      const actorId =
        token.userId ??
        token.sub ??
        (typeof token.email === 'string' && token.email.trim().length > 0
          ? `admin:${token.email.trim()}`
          : 'admin:system');

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
        namespace: 'esma-admin',
        tenantId: 'system',
        subTenantId: undefined,
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
