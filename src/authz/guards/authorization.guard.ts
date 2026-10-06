import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Type,
} from '@nestjs/common';
import { ModuleRef, Reflector } from '@nestjs/core';
import { AppConfigService } from '../../config/config.service.js';
import { AuthenticatedHttpRequest } from '../../auth/context.js';
import {
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
} from '../../core/errors/app-error.js';
import { REQUIRE_ACTION_KEY } from '../decorators/require-action.decorator.js';
import { RESOURCE_LOADER_KEY } from '../decorators/resource-loader.decorator.js';
import {
  DefaultResourceLoader,
  FileResourceLoader,
  ResourceLoader,
} from '../resource-loader.js';
import { AUDIT_SINK } from '../audit-sink.js';
import type { AuditSink } from '../audit-sink.js';
import {
  AuthzAction,
  AuthzResource,
  authorize,
  isEsmaAdminActor,
} from '../authorize.js';

@Injectable()
export class AuthorizationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly configService: AppConfigService,
    private readonly moduleRef: ModuleRef,
    private readonly fileResourceLoader: FileResourceLoader,
    private readonly defaultResourceLoader: DefaultResourceLoader,
    @Inject(AUDIT_SINK) private readonly auditSink: AuditSink,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }

    // 1. Read required action metadata
    const action = this.reflector.getAllAndOverride<AuthzAction>(
      REQUIRE_ACTION_KEY,
      [context.getHandler(), context.getClass()],
    );

    // If no action is declared on handler or controller, pass through
    if (!action) {
      return true;
    }

    const req = context.switchToHttp().getRequest<AuthenticatedHttpRequest>();
    const ctx = req.ctx;
    if (!ctx) {
      throw new UnauthenticatedError(
        'RequestContext is required for authorization',
      );
    }

    // 2. Select appropriate ResourceLoader
    const customLoaderType = this.reflector.getAllAndOverride<
      Type<ResourceLoader>
    >(RESOURCE_LOADER_KEY, [context.getHandler(), context.getClass()]);

    let loader: ResourceLoader;
    if (customLoaderType) {
      loader = this.moduleRef.get(customLoaderType, { strict: false });
    } else if (
      typeof req.params?.fileId === 'string' &&
      req.params.fileId.trim().length > 0
    ) {
      loader = this.fileResourceLoader;
    } else {
      loader = this.defaultResourceLoader;
    }

    const resource = await loader.load(req);
    const resolvedResource: AuthzResource =
      resource ?? this.defaultResourceLoader.load(req);

    // 3. Admin allowed roles from configuration
    const adminRolesConfig = this.configService.get().ADMIN_ALLOWED_ROLES;
    const adminAllowedRoles = adminRolesConfig
      ? adminRolesConfig
          .split(',')
          .map((r) => r.trim())
          .filter((r) => r.length > 0)
      : [];

    // 4. Anti-Enumeration Security Check (ARCH §4.2, F-42):
    // When accessing a specific file that belongs to a different tenant,
    // return 404 instead of 403 to prevent cross-tenant existence enumeration.
    const isSpecificFile = Boolean(req.params?.fileId);
    if (
      isSpecificFile &&
      resolvedResource.tenantId !== ctx.tenantId &&
      !isEsmaAdminActor(ctx, adminAllowedRoles)
    ) {
      try {
        await this.auditSink.record({
          action,
          decision: {
            allowed: false,
            reason: 'Cross-tenant resource access denied and hidden as 404',
            ruleId: 'CROSS_TENANT_NOT_FOUND',
          },
          actorId: ctx.actor.id,
          actorType: ctx.actor.type,
          namespace: ctx.namespace,
          tenantId: ctx.tenantId,
          subTenantId: ctx.subTenantId,
          resource: resolvedResource,
          correlationId: ctx.correlationId,
          timestamp: new Date(),
        });
      } catch {
        // AuditSink errors must not mask security exceptions
      }

      const fileIdStr = String(req.params.fileId);
      throw new NotFoundError(`File '${fileIdStr}' not found`);
    }

    // 5. Evaluate pure authorization decision
    const decision = authorize(
      ctx,
      action,
      resolvedResource,
      adminAllowedRoles,
    );

    // 6. Record audit event
    try {
      await this.auditSink.record({
        action,
        decision,
        actorId: ctx.actor.id,
        actorType: ctx.actor.type,
        namespace: ctx.namespace,
        tenantId: ctx.tenantId,
        subTenantId: ctx.subTenantId,
        resource: resolvedResource,
        correlationId: ctx.correlationId,
        timestamp: new Date(),
      });
    } catch {
      // Audit failure does not disrupt request pipeline
    }

    // 7. Enforce decision
    if (!decision.allowed) {
      throw new ForbiddenError(decision.reason, {
        code: decision.ruleId,
      });
    }

    return true;
  }
}
