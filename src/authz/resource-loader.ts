import { Injectable } from '@nestjs/common';
import { AuthenticatedHttpRequest } from '../auth/context.js';
import { FileRepository } from '../db/repositories/file.repository.js';
import { NotFoundError } from '../core/errors/app-error.js';
import { AuthzResource } from './matrix-rules.js';
import { FileVisibility } from '../core/types.js';

export interface ResourceLoader {
  load(
    req: AuthenticatedHttpRequest,
  ): Promise<AuthzResource | null> | AuthzResource | null;
}

export const RESOURCE_LOADER = Symbol('RESOURCE_LOADER');

/**
 * Loads the existing file resource for file-scoped operations (:fileId).
 * Caches the loaded file on req.fileRecord to avoid redundant database reads.
 */
@Injectable()
export class FileResourceLoader implements ResourceLoader {
  constructor(private readonly fileRepo: FileRepository) {}

  async load(req: AuthenticatedHttpRequest): Promise<AuthzResource | null> {
    const rawFileId = req.params?.fileId;
    const fileId = Array.isArray(rawFileId) ? rawFileId[0] : rawFileId;
    if (!fileId || typeof fileId !== 'string') {
      return null;
    }

    const file = await this.fileRepo.findById(fileId);
    if (!file) {
      throw new NotFoundError(`File '${fileId}' not found`);
    }

    req.fileRecord = file;

    return {
      namespace: file.namespace,
      tenantId: file.tenantId,
      subTenantId: file.subTenantId,
      uploadedBy: file.uploadedBy,
      visibility: file.visibility,
    };
  }
}

/**
 * Builds resource representation for non-file routes (e.g. upload, list).
 * Derives target tenant, sub-tenant branch, and requested visibility from request context.
 */
@Injectable()
export class DefaultResourceLoader implements ResourceLoader {
  load(req: AuthenticatedHttpRequest): AuthzResource {
    const ctx = req.ctx;
    const body =
      req.body && typeof req.body === 'object'
        ? (req.body as Record<string, unknown>)
        : undefined;
    const query =
      req.query && typeof req.query === 'object'
        ? (req.query as Record<string, unknown>)
        : undefined;

    const rawBranch =
      (typeof query?.branchId === 'string' ? query.branchId : undefined) ??
      (typeof body?.branchId === 'string' ? body.branchId : undefined) ??
      (typeof req.headers?.['x-branch-id'] === 'string'
        ? req.headers['x-branch-id']
        : undefined) ??
      ctx?.subTenantId ??
      null;

    const subTenantId =
      typeof rawBranch === 'string' && rawBranch.trim().length > 0
        ? rawBranch.trim()
        : null;

    const rawVisibility = body?.visibility;
    const visibility: FileVisibility =
      rawVisibility === 'public' ||
      rawVisibility === 'private' ||
      rawVisibility === 'tenant'
        ? rawVisibility
        : 'tenant';

    return {
      namespace: ctx?.namespace ?? 'esma-tenant',
      tenantId: ctx?.tenantId ?? 'default',
      subTenantId,
      uploadedBy: ctx?.actor.id,
      visibility,
    };
  }
}
