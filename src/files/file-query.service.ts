import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../config/config.service.js';
import { RequestContext } from '../core/request-context.js';
import {
  FileRecord,
  FileStatus,
  FileVisibility,
  PaginatedResult,
  Provider,
} from '../core/types.js';
import { ForbiddenError, NotFoundError } from '../core/errors/app-error.js';
import { AuthorizationService } from '../authz/authorization.service.js';
import { FileRepository } from '../db/repositories/file.repository.js';
import { ReplicaRepository } from '../db/repositories/replica.repository.js';
import { toManifest, type UploadManifestResponse } from '../core/manifest.js';

export interface FileListQueryFilter {
  folder?: string;
  subTenantId?: string | null;
  mimetype?: string;
  tag?: string;
  tags?: string[];
  visibility?: FileVisibility;
  status?: FileStatus;
  createdFrom?: Date;
  createdTo?: Date;
}

export interface FileSummary {
  fileId: string;
  namespace: string;
  tenantId: string;
  subTenantId: string | null;
  folder: string;
  originalFilename: string;
  mimetype: string;
  size: number;
  sha256: string | null;
  visibility: FileVisibility;
  status: FileStatus;
  primaryProvider: Provider;
  tags: string[];
  canonicalUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface PaginatedFileListResponse extends PaginatedResult<FileSummary> {
  total: number;
}

@Injectable()
export class FileQueryService {
  constructor(
    private readonly fileRepo: FileRepository,
    private readonly replicaRepo: ReplicaRepository,
    private readonly authzService: AuthorizationService,
    private readonly configService: AppConfigService,
  ) {}

  /**
   * List files for a tenant with keyset pagination and authorization scoping.
   * Conforms to ARCH §9.1 and BACKEND_TASKS P2-08.
   */
  async list(
    ctx: RequestContext,
    filter?: FileListQueryFilter,
    cursor?: string | null,
    limit = 20,
  ): Promise<PaginatedFileListResponse> {
    // If actor is branch-scoped, strictly enforce their subTenantId
    const effectiveSubTenantId =
      ctx.subTenantId !== undefined ? ctx.subTenantId : filter?.subTenantId;

    let combinedTags: string[] | undefined;
    if (filter?.tags && filter.tags.length > 0) {
      combinedTags = filter.tags;
    } else if (filter?.tag) {
      combinedTags = [filter.tag];
    }

    const repoResult = await this.fileRepo.list(
      {
        namespace: ctx.namespace,
        tenantId: ctx.tenantId,
        subTenantId: effectiveSubTenantId,
        folder: filter?.folder,
        status: filter?.status,
        visibility: filter?.visibility,
        mimetype: filter?.mimetype,
        tags: combinedTags,
        createdFrom: filter?.createdFrom,
        createdTo: filter?.createdTo,
      },
      cursor,
      limit,
    );

    const baseUrl = this.configService.get().APP_BASE_URL.replace(/\/+$/, '');
    const items: FileSummary[] = repoResult.items.map((file) =>
      this.toFileSummary(file, baseUrl),
    );

    return {
      items,
      total: items.length,
      nextCursor: repoResult.nextCursor,
      hasMore: repoResult.hasMore,
    };
  }

  /**
   * Retrieve file metadata manifest by fileId.
   * Conforms to ARCH §9.2 and BACKEND_TASKS P2-08.
   */
  async getMetadata(
    ctx: RequestContext,
    fileId: string,
  ): Promise<UploadManifestResponse> {
    const file = await this.fileRepo.findById(fileId);
    if (!file || file.status === 'DELETED' || file.status === 'DELETING') {
      throw new NotFoundError(`File '${fileId}' not found`);
    }

    // Tenant isolation: callers outside the tenant boundary receive 404
    if (!this.authzService.canAccessTenant(ctx, file.tenantId)) {
      throw new NotFoundError(`File '${fileId}' not found`);
    }

    // Authorize caller for 'read' action
    const decision = this.authzService.authorize(ctx, 'read', {
      namespace: file.namespace,
      tenantId: file.tenantId,
      subTenantId: file.subTenantId,
      uploadedBy: file.uploadedBy,
      visibility: file.visibility,
    });
    if (!decision.allowed) {
      throw new ForbiddenError(decision.reason);
    }

    const replicas = await this.replicaRepo.listByFile(fileId);
    const baseUrl = this.configService.get().APP_BASE_URL;

    return toManifest(file, replicas, baseUrl, {
      message: 'File metadata retrieved successfully.',
    });
  }

  private toFileSummary(file: FileRecord, baseUrl: string): FileSummary {
    return {
      fileId: file.id,
      namespace: file.namespace,
      tenantId: file.tenantId,
      subTenantId: file.subTenantId,
      folder: file.folder,
      originalFilename: file.originalFilename,
      mimetype: file.mimetype,
      size: Number(file.sizeBytes),
      sha256: file.sha256,
      visibility: file.visibility,
      status: file.status,
      primaryProvider: file.primaryProvider,
      tags: file.tags,
      canonicalUrl: `${baseUrl}/api/v1/files/${file.id}`,
      createdAt: file.createdAt.toISOString(),
      updatedAt: file.updatedAt.toISOString(),
    };
  }
}
