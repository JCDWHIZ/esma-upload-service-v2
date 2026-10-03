import { RequestContext } from '../auth/context.js';
import { FileVisibility } from '../core/types.js';
import { UploadPermissions } from './permissions.js';

export type AuthzAction = 'upload' | 'read' | 'list' | 'delete' | 'admin';

export interface AuthzResource {
  namespace: string;
  tenantId: string;
  subTenantId?: string | null;
  uploadedBy?: string;
  visibility?: FileVisibility;
}

export interface AuthzDecision {
  allowed: boolean;
  reason: string;
  ruleId: string;
}

export interface AuthzEvaluationContext {
  ctx: RequestContext;
  action: AuthzAction;
  resource: AuthzResource;
  adminAllowedRoles?: string[];
}

export interface MatrixRule {
  id: string;
  description: string;
  matches: (input: AuthzEvaluationContext) => boolean;
  evaluate: (input: AuthzEvaluationContext) => AuthzDecision;
}

/**
 * Normalizes string comparison helper.
 */
function hasRole(
  roles: readonly string[] | undefined,
  targetRoles: string[],
): boolean {
  if (!roles || roles.length === 0) return false;
  const normalizedTargets = targetRoles.map((r) => r.trim().toLowerCase());
  return roles.some((r) => normalizedTargets.includes(r.trim().toLowerCase()));
}

/**
 * Checks whether the actor possesses ESMA Admin / Platform Admin authority.
 * Uses configurable ADMIN_ALLOWED_ROLES (default: superadmin, esma_admin)
 * and canonical ESMA platform permissions. Does NOT treat regular school "admin" as ESMA Admin.
 */
export function isEsmaAdminActor(
  ctx: RequestContext,
  adminAllowedRoles?: string[],
): boolean {
  // 1. Check roles against configurable allowed admin roles
  const allowedRoles =
    adminAllowedRoles && adminAllowedRoles.length > 0
      ? adminAllowedRoles
      : ['superadmin', 'super admin', 'esma_admin'];

  if (hasRole(ctx.actor.roles, allowedRoles)) {
    return true;
  }

  // 2. Check canonical ESMA Admin permissions
  const perms = ctx.actor.permissions ?? [];
  if (
    perms.includes(UploadPermissions.QUOTAS_MANAGE) ||
    perms.includes(UploadPermissions.SYSTEM_FILES_UPLOAD) ||
    perms.includes(UploadPermissions.SYSTEM_FILES_DELETE) ||
    perms.includes(UploadPermissions.SYSTEM_FILES_READ) ||
    perms.includes(UploadPermissions.SYSTEM_FILES_LIST) ||
    perms.includes(UploadPermissions.TENANTS_USAGE_VIEW) ||
    perms.includes(UploadPermissions.AUDIT_VIEW) ||
    perms.includes(UploadPermissions.FILES_BULK_DELETE)
  ) {
    return true;
  }

  // Fallback for explicit platformAdmin boolean if present during transition
  if (ctx.actor.isPlatformAdmin === true) {
    return true;
  }

  return false;
}

/**
 * Checks whether the actor is a school admin within their tenant.
 */
export function isSchoolAdminActor(ctx: RequestContext): boolean {
  if (ctx.actor.isSchoolAdmin === true) {
    return true;
  }

  const perms = ctx.actor.permissions ?? [];
  if (
    perms.includes(UploadPermissions.BRANCHES_MANAGE) ||
    perms.includes(UploadPermissions.QUOTAS_VIEW) ||
    perms.includes(UploadPermissions.FILES_ADMIN)
  ) {
    return true;
  }

  return hasRole(ctx.actor.roles, [
    'admin',
    'school_admin',
    'school admin',
    'principal',
  ]);
}

/**
 * Determines whether the actor is branch-scoped (restricted to specific branches).
 */
export function isBranchScopedActor(ctx: RequestContext): boolean {
  if (isSchoolAdminActor(ctx)) {
    return false;
  }
  const grants = ctx.actor.branchGrants ?? [];
  if (grants.length > 0 && !grants.includes('*')) {
    return true;
  }
  if (
    typeof ctx.subTenantId === 'string' &&
    ctx.subTenantId.trim().length > 0
  ) {
    return true;
  }
  return false;
}

/**
 * Resolves the actor's permitted branch set.
 */
export function getActorBranchSet(ctx: RequestContext): Set<string> {
  const set = new Set<string>();
  if (
    typeof ctx.subTenantId === 'string' &&
    ctx.subTenantId.trim().length > 0
  ) {
    set.add(ctx.subTenantId.trim());
  }
  for (const b of ctx.actor.branchGrants ?? []) {
    if (typeof b === 'string' && b.trim().length > 0 && b !== '*') {
      set.add(b.trim());
    }
  }
  return set;
}

/**
 * Declarative rule table encoding ARCH §4.2, ARCH §4.3 and F-42.
 */
export const MATRIX_RULES: readonly MatrixRule[] = Object.freeze([
  // Rule 1: Public Visibility Read Access
  {
    id: 'PUBLIC_VISIBILITY_ALLOWED',
    description: 'Any caller may read files with public visibility',
    matches: ({ action, resource }) =>
      action === 'read' && resource.visibility === 'public',
    evaluate: () => ({
      allowed: true,
      reason: 'Public file read permitted',
      ruleId: 'PUBLIC_VISIBILITY_ALLOWED',
    }),
  },

  // Rule 2: ESMA Admin Operations
  // Applies when the caller has ESMA admin authority AND is performing system-level actions
  // or cross-tenant inspection.
  {
    id: 'ESMA_ADMIN_AUTHORIZED',
    description:
      'ESMA Admins possess platform privileges for system files, admin operations, and cross-tenant inspection',
    matches: ({ ctx, action, resource, adminAllowedRoles }) => {
      if (!isEsmaAdminActor(ctx, adminAllowedRoles)) {
        return false;
      }
      // If resource is in esma-admin namespace or actor is in esma-admin namespace
      if (
        resource.namespace === 'esma-admin' ||
        ctx.namespace === 'esma-admin'
      ) {
        return true;
      }
      // Action is explicitly admin
      if (action === 'admin') {
        return true;
      }
      // Cross-tenant access: actor accessing a different tenant than their own
      if (ctx.tenantId !== resource.tenantId) {
        return ['read', 'list', 'delete', 'admin'].includes(action);
      }
      // Otherwise, let same-tenant requests evaluate under tenant rules
      return false;
    },
    evaluate: ({ action, resource }) => ({
      allowed: true,
      reason: `ESMA Admin authorized for action '${action}' on resource in '${resource.namespace}'`,
      ruleId: 'ESMA_ADMIN_AUTHORIZED',
    }),
  },

  // Rule 3: Namespace Mismatch Check
  {
    id: 'NAMESPACE_MISMATCH',
    description: 'Context namespace must strictly match resource namespace',
    matches: ({ ctx, resource, adminAllowedRoles }) =>
      !isEsmaAdminActor(ctx, adminAllowedRoles) &&
      ctx.namespace !== resource.namespace,
    evaluate: ({ ctx, resource }) => ({
      allowed: false,
      reason: `Context namespace '${ctx.namespace}' does not match resource namespace '${resource.namespace}'`,
      ruleId: 'NAMESPACE_MISMATCH',
    }),
  },

  // Rule 4: Tenant Mismatch Check (Strict equality, fixing F-42 prefix issues)
  {
    id: 'TENANT_MISMATCH',
    description: 'Context tenantId must strictly match resource tenantId',
    matches: ({ ctx, resource, adminAllowedRoles }) =>
      !isEsmaAdminActor(ctx, adminAllowedRoles) &&
      ctx.tenantId !== resource.tenantId,
    evaluate: ({ ctx, resource }) => ({
      allowed: false,
      reason: `Context tenantId '${ctx.tenantId}' does not match resource tenantId '${resource.tenantId}'`,
      ruleId: 'TENANT_MISMATCH',
    }),
  },

  // Rule 5: ESMA Tenant Namespace Rules
  {
    id: 'ESMA_TENANT_RULES',
    description:
      'ARCH §4.2 rules for school scope vs branch scope in esma-tenant namespace',
    matches: ({ resource }) => resource.namespace === 'esma-tenant',
    evaluate: ({ ctx, action, resource }) => {
      const isBranchScoped = isBranchScopedActor(ctx);
      const branchSet = getActorBranchSet(ctx);
      const targetBranch =
        resource.subTenantId && resource.subTenantId.trim().length > 0
          ? resource.subTenantId.trim()
          : undefined;

      // 5.1 Upload Action
      if (action === 'upload') {
        if (!targetBranch) {
          // Upload at school root scope
          if (isBranchScoped) {
            return {
              allowed: false,
              reason: 'Branch-scoped tokens cannot upload at school root scope',
              ruleId: 'TENANT_UPLOAD_BRANCH_TOKEN_CANNOT_UPLOAD_SCHOOL_SCOPE',
            };
          }
          return {
            allowed: true,
            reason: 'School-level token allowed to upload at school scope',
            ruleId: 'TENANT_UPLOAD_SCHOOL_SCOPE_ALLOWED',
          };
        } else {
          // Upload at branch B
          if (isBranchScoped && !branchSet.has(targetBranch)) {
            return {
              allowed: false,
              reason: `Actor is not authorized to upload to branch '${targetBranch}'`,
              ruleId: 'TENANT_UPLOAD_BRANCH_MISMATCH',
            };
          }
          return {
            allowed: true,
            reason: `Upload allowed to branch '${targetBranch}'`,
            ruleId: isBranchScoped
              ? 'TENANT_UPLOAD_BRANCH_ALLOWED'
              : 'TENANT_UPLOAD_SCHOOL_TOKEN_BRANCH_ALLOWED',
          };
        }
      }

      // 5.2 List Action
      if (action === 'list') {
        if (!targetBranch) {
          // List school root scope
          if (isBranchScoped) {
            return {
              allowed: false,
              reason: 'Branch-scoped tokens cannot list at school root scope',
              ruleId: 'TENANT_LIST_BRANCH_TOKEN_CANNOT_LIST_SCHOOL_SCOPE',
            };
          }
          return {
            allowed: true,
            reason: 'School-level token allowed to list at school scope',
            ruleId: 'TENANT_LIST_SCHOOL_SCOPE_ALLOWED',
          };
        } else {
          // List branch B
          if (isBranchScoped && !branchSet.has(targetBranch)) {
            return {
              allowed: false,
              reason: `Actor is not authorized to list branch '${targetBranch}'`,
              ruleId: 'TENANT_LIST_BRANCH_MISMATCH',
            };
          }
          return {
            allowed: true,
            reason: `List allowed for branch '${targetBranch}'`,
            ruleId: isBranchScoped
              ? 'TENANT_LIST_BRANCH_ALLOWED'
              : 'TENANT_LIST_SCHOOL_TOKEN_BRANCH_ALLOWED',
          };
        }
      }

      // 5.3 Delete Action
      if (action === 'delete') {
        if (!targetBranch) {
          // File has no branch (school root file)
          if (isBranchScoped) {
            return {
              allowed: false,
              reason: 'Branch-scoped tokens cannot delete school root files',
              ruleId: 'TENANT_DELETE_BRANCH_MISMATCH',
            };
          }
          return {
            allowed: true,
            reason: 'School-level token allowed to delete school scope file',
            ruleId: 'TENANT_DELETE_SCHOOL_SCOPE_ALLOWED',
          };
        } else {
          // File belongs to branch B. Strict exact check eliminates F-42 prefix bug.
          if (isBranchScoped && !branchSet.has(targetBranch)) {
            return {
              allowed: false,
              reason: `Branch-scoped token cannot delete files outside assigned branch '${targetBranch}'`,
              ruleId: 'TENANT_DELETE_BRANCH_MISMATCH',
            };
          }
          return {
            allowed: true,
            reason: `Delete allowed for file in branch '${targetBranch}'`,
            ruleId: isBranchScoped
              ? 'TENANT_DELETE_BRANCH_SCOPE_ALLOWED'
              : 'TENANT_DELETE_SCHOOL_SCOPE_ALLOWED',
          };
        }
      }

      // 5.4 Read Action
      if (action === 'read') {
        const visibility = resource.visibility ?? 'tenant';
        if (visibility === 'tenant') {
          // Tenant visibility: any authenticated user in same school
          return {
            allowed: true,
            reason: 'Same school tenant visibility read permitted',
            ruleId: 'TENANT_READ_TENANT_VISIBILITY_ALLOWED',
          };
        }

        if (visibility === 'private') {
          // Private visibility: uploader or school admin
          const isUploader =
            resource.uploadedBy !== undefined &&
            resource.uploadedBy === ctx.actor.id;
          const isAdmin = isSchoolAdminActor(ctx);

          if (isUploader || isAdmin) {
            return {
              allowed: true,
              reason: isUploader
                ? 'Original uploader permitted to read private file'
                : 'School admin permitted to read private file',
              ruleId: isUploader
                ? 'PRIVATE_VISIBILITY_OWNER_ALLOWED'
                : 'PRIVATE_VISIBILITY_ADMIN_ALLOWED',
            };
          }

          return {
            allowed: false,
            reason:
              'Private files are only accessible to the original uploader or administrators',
            ruleId: 'PRIVATE_VISIBILITY_DENIED',
          };
        }

        return {
          allowed: true,
          reason: 'Read permitted',
          ruleId: 'TENANT_READ_ALLOWED',
        };
      }

      // 5.5 Admin Action
      if (action === 'admin') {
        if (isSchoolAdminActor(ctx)) {
          return {
            allowed: true,
            reason: 'School admin authorized for administrative action',
            ruleId: 'TENANT_ADMIN_ALLOWED',
          };
        }
        return {
          allowed: false,
          reason: 'School administrator privileges required',
          ruleId: 'TENANT_ADMIN_DENIED',
        };
      }

      return {
        allowed: false,
        reason: `Unsupported action '${String(action)}' in esma-tenant namespace`,
        ruleId: 'DENY_BY_DEFAULT',
      };
    },
  },

  // Rule 6: Generic API Key Client Rules
  {
    id: 'GENERIC_CLIENT_RULES',
    description: 'Scope and visibility checks for generic API clients',
    matches: ({ ctx }) =>
      ctx.actor.type === 'service' || ctx.namespace !== 'esma-tenant',
    evaluate: ({ ctx, action, resource }) => {
      const scopes = ctx.actor.scopes ?? [];
      const hasWildcard =
        scopes.includes('*') || scopes.includes('files:admin');

      // Required scope mapping
      const requiredScopeMap: Record<AuthzAction, string> = {
        upload: 'files:write',
        read: 'files:read',
        list: 'files:read',
        delete: 'files:delete',
        admin: 'files:admin',
      };

      const requiredScope = requiredScopeMap[action];
      const hasScope = hasWildcard || scopes.includes(requiredScope);

      if (!hasScope) {
        return {
          allowed: false,
          reason: `API client missing required scope '${requiredScope}' for action '${action}'`,
          ruleId: 'GENERIC_SCOPE_MISSING',
        };
      }

      // Private visibility handling
      if (action === 'read' && resource.visibility === 'private') {
        const isUploader =
          resource.uploadedBy !== undefined &&
          resource.uploadedBy === ctx.actor.id;
        if (!isUploader && !hasWildcard) {
          return {
            allowed: false,
            reason:
              'Private files can only be accessed by uploader or clients with files:admin scope',
            ruleId: 'PRIVATE_VISIBILITY_DENIED',
          };
        }
      }

      return {
        allowed: true,
        reason: `API client authorized for action '${action}' with scope '${requiredScope}'`,
        ruleId: 'GENERIC_ACTION_ALLOWED',
      };
    },
  },

  // Rule 7: Fallback Deny Rule
  {
    id: 'DENY_BY_DEFAULT',
    description:
      'Default deny when no prior rule explicitly allows the request',
    matches: () => true,
    evaluate: ({ action }) => ({
      allowed: false,
      reason: `Action '${action}' is not permitted by any authorization rule`,
      ruleId: 'DENY_BY_DEFAULT',
    }),
  },
]);
