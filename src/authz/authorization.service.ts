import { Injectable } from '@nestjs/common';
import { RequestContext } from '../core/request-context.js';
import { AppConfigService } from '../config/config.service.js';
import {
  AuthzAction,
  AuthzDecision,
  AuthzResource,
  authorize,
  isEsmaAdminActor,
} from './authorize.js';
import { FileVisibility } from '../core/types.js';

export type { FileVisibility };

export interface FileAccessDescriptor {
  visibility: FileVisibility;
  tenantId: string;
  subTenantId?: string | null;
  namespace?: string;
  ownerId?: string;
}

@Injectable()
export class AuthorizationService {
  constructor(private readonly configService: AppConfigService) {}

  /**
   * Evaluates the authorization decision for a given action on a resource.
   */
  authorize(
    ctx: RequestContext,
    action: AuthzAction,
    resource: AuthzResource,
  ): AuthzDecision {
    const adminRolesConfig = this.configService.get().ADMIN_ALLOWED_ROLES;
    const adminAllowedRoles = adminRolesConfig
      ? adminRolesConfig.split(',').map((r) => r.trim()).filter((r) => r.length > 0)
      : [];

    return authorize(ctx, action, resource, adminAllowedRoles);
  }

  /**
   * Check if the caller can access data for a specific organization/tenant
   */
  canAccessTenant(context: RequestContext, targetTenantId: string): boolean {
    const adminRolesConfig = this.configService.get().ADMIN_ALLOWED_ROLES;
    const adminAllowedRoles = adminRolesConfig
      ? adminRolesConfig.split(',').map((r) => r.trim()).filter((r) => r.length > 0)
      : [];

    if (isEsmaAdminActor(context, adminAllowedRoles)) {
      return true;
    }
    return context.tenantId === targetTenantId;
  }

  /**
   * Check if a caller has permission to view/read a specific file based on visibility
   */
  canReadFile(
    context: RequestContext | null,
    file: FileAccessDescriptor,
  ): boolean {
    // 1. Public files are accessible to everyone
    if (file.visibility === 'public') {
      return true;
    }

    // Non-public files require authentication
    if (!context) {
      return false;
    }

    const resource: AuthzResource = {
      namespace: file.namespace ?? context.namespace,
      tenantId: file.tenantId,
      subTenantId: file.subTenantId,
      uploadedBy: file.ownerId,
      visibility: file.visibility,
    };

    const decision = this.authorize(context, 'read', resource);
    return decision.allowed;
  }
}
