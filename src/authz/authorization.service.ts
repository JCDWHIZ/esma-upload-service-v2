import { Injectable } from '@nestjs/common';
import { RequestContext } from '../core/request-context.js';

export type FileVisibility = 'public' | 'tenant' | 'private';

export interface FileAccessDescriptor {
  visibility: FileVisibility;
  tenantId: string;
  ownerId?: string;
}

@Injectable()
export class AuthorizationService {
  /**
   * Check if the caller can access data for a specific organization/tenant
   */
  canAccessTenant(context: RequestContext, targetTenantId: string): boolean {
    if (context.actor.isPlatformAdmin) {
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

    // 2. Platform admins have global access across organizations
    if (context.actor.isPlatformAdmin) {
      return true;
    }

    // 3. Organization files are accessible to members of that organization
    if (file.visibility === 'tenant') {
      return context.tenantId === file.tenantId;
    }

    // 4. Private files are only accessible to the original uploader (or via signed URL)
    if (file.visibility === 'private') {
      return context.actor.id === file.ownerId;
    }

    return false;
  }
}
