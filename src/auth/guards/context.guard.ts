import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { NAMESPACE_METADATA_KEY } from '../decorators/namespace.decorator.js';
import {
  AuthenticatedHttpRequest,
  ContextNamespace,
  ContextResolver,
} from '../context.js';
import { EsmaTenantContextResolver } from '../resolvers/tenant-context.resolver.js';
import { EsmaAdminContextResolver } from '../resolvers/admin-context.resolver.js';
import { GenericContextResolver } from '../resolvers/generic-context.resolver.js';
import { getCorrelationContext } from '../../observability/correlation-context.js';

@Injectable()
export class ContextGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenantResolver: EsmaTenantContextResolver,
    private readonly adminResolver: EsmaAdminContextResolver,
    private readonly genericResolver: GenericContextResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }

    const http = context.switchToHttp();
    const req = http.getRequest<AuthenticatedHttpRequest>();

    // 1. Determine target namespace from Reflector metadata
    const metadataNamespace =
      this.reflector.getAllAndOverride<ContextNamespace>(
        NAMESPACE_METADATA_KEY,
        [context.getHandler(), context.getClass()],
      );

    // 2. Select matching resolver
    const resolver = this.selectResolver(metadataNamespace, req);

    // 3. Resolve RequestContext
    const requestContext = await resolver.resolve(req);

    // 4. Attach to request.ctx
    req.ctx = requestContext;

    // 5. Enrich correlation storage if active
    const currentStore = getCorrelationContext();
    if (currentStore) {
      currentStore.namespace = requestContext.namespace;
      currentStore.tenantId = requestContext.tenantId;
      currentStore.actorId = requestContext.actor.id;
    }

    return true;
  }

  private selectResolver(
    namespace: ContextNamespace | undefined,
    req: AuthenticatedHttpRequest,
  ): ContextResolver {
    if (namespace === 'esma-tenant') {
      return this.tenantResolver;
    }
    if (namespace === 'esma-admin') {
      return this.adminResolver;
    }
    if (namespace === 'generic') {
      return this.genericResolver;
    }

    // Dynamic auto-detection fallback if no @Namespace decorator is present
    if (
      req.apiClient ||
      (req.principal &&
        typeof req.principal === 'object' &&
        'keyPrefix' in req.principal)
    ) {
      return this.genericResolver;
    }

    const token = req.user ?? req.token ?? req.principal;
    if (token && typeof token === 'object') {
      if (token.organizationId || token.schoolId) {
        return this.tenantResolver;
      }
    }

    return this.adminResolver;
  }
}
