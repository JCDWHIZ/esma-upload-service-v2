import { Injectable } from '@nestjs/common';
import { FileQueryService } from './file-query.service.js';
import type { RequestContext } from '../core/request-context.js';

@Injectable()
export class FilesService {
  constructor(private readonly fileQueryService: FileQueryService) {}

  private createContext(
    tenantId: string,
    correlationId: string,
  ): RequestContext {
    return {
      namespace: 'esma-tenant',
      tenantId,
      actor: {
        id: 'service',
        type: 'service',
        roles: ['admin'],
        scopes: ['files:read', 'files:write', 'files:admin'],
      },
      correlationId,
      ipAddress: '127.0.0.1',
      attributes: {},
    };
  }

  async listFiles(
    tenantId: string,
  ): Promise<{ items: unknown[]; total: number; cursor: string | null }> {
    const res = await this.fileQueryService.list(
      this.createContext(tenantId, 'files-service-list'),
    );
    return {
      items: res.items,
      total: res.total,
      cursor: res.nextCursor,
    };
  }

  async getFileMetadata(fileId: string) {
    return this.fileQueryService.getMetadata(
      this.createContext('default', 'files-service-meta'),
      fileId,
    );
  }
}
