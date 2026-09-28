import {
  Controller,
  Get,
  Head,
  Post,
  Delete,
  Param,
  Query,
  Headers,
  Body,
  Req,
  Res,
  HttpCode,
  HttpStatus,
  NotImplementedException,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { FilesService } from './files.service.js';
import { FileReadService, type FileReadAuth } from './file-read.service.js';
import { SignedUrlService } from './signed-url.service.js';
import { DeleteService } from './delete.service.js';
import { FileQueryService } from './file-query.service.js';
import { FileRepository } from '../db/repositories/file.repository.js';
import { AuthorizationService } from '../authz/authorization.service.js';
import { Public } from '../auth/decorators/public.decorator.js';
import type { AuthenticatedHttpRequest } from '../auth/context.js';
import type { RequestContext } from '../core/request-context.js';
import type { ProviderName } from '../storage/types.js';
import { ForbiddenError, NotFoundError } from '../core/errors/app-error.js';

function getRequestContext(
  req?: AuthenticatedHttpRequest,
  defaultCorrelationId = 'req',
): RequestContext {
  if (req?.ctx) {
    return req.ctx;
  }
  return {
    namespace: 'esma-tenant',
    tenantId: 'default',
    actor: {
      id: 'anonymous',
      type: 'user',
      roles: [],
      scopes: [],
    },
    correlationId: defaultCorrelationId,
    ipAddress: req?.ip ?? '127.0.0.1',
    attributes: {},
  };
}

@ApiTags('files')
@Controller('api/v1/files')
export class FilesController {
  constructor(
    private readonly filesService: FilesService,
    private readonly fileReadService: FileReadService,
    private readonly signedUrlService: SignedUrlService,
    private readonly deleteService: DeleteService,
    private readonly fileQueryService: FileQueryService,
    private readonly fileRepo: FileRepository,
    private readonly authzService: AuthorizationService,
  ) {}

  @Post('upload')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Upload file(s)' })
  @ApiResponse({ status: 201, description: 'File uploaded successfully' })
  upload() {
    throw new NotImplementedException(
      'File upload engine will be implemented in Phase 2',
    );
  }

  @Get()
  @ApiOperation({ summary: 'List files for tenant' })
  @ApiResponse({ status: 200, description: 'List of files' })
  listFiles(
    @Query('folder') folder?: string,
    @Query('subTenantId') subTenantId?: string,
    @Query('mimetype') mimetype?: string,
    @Query('tag') tag?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Req() req?: AuthenticatedHttpRequest,
  ) {
    const ctx = getRequestContext(req, 'req-list');
    const parsedLimit = limit ? parseInt(limit, 10) : 20;
    return this.fileQueryService.list(
      ctx,
      { folder, subTenantId, mimetype, tag },
      cursor,
      isNaN(parsedLimit) ? 20 : parsedLimit,
    );
  }

  @Public()
  @Get(':fileId')
  @Head(':fileId')
  @ApiOperation({ summary: 'Get file content' })
  @ApiResponse({ status: 200, description: 'Full file content stream' })
  @ApiResponse({ status: 206, description: 'Partial content byte range slice' })
  @ApiResponse({ status: 302, description: 'Direct storage / CDN redirect' })
  @ApiResponse({
    status: 304,
    description: 'Not modified conditional ETag match',
  })
  @ApiResponse({ status: 404, description: 'File not found' })
  @ApiResponse({ status: 416, description: 'Range not satisfiable' })
  async getFileContent(
    @Param('fileId') fileId: string,
    @Query('exp') exp?: string,
    @Query('disp') disp?: 'inline' | 'attachment',
    @Query('sig') sig?: string,
    @Query('redirect') redirect?: 'auto' | 'always' | 'never',
    @Query('provider') provider?: ProviderName,
    @Headers('range') range?: string,
    @Headers('if-none-match') ifNoneMatch?: string,
    @Req() req?: AuthenticatedHttpRequest,
    @Res() res?: Response,
  ) {
    const isHead = req?.method === 'HEAD';
    const auth: FileReadAuth = {
      ctx: req?.ctx ?? null,
      signature: sig ? { exp, disp, sig } : undefined,
    };

    const result = await this.fileReadService.open(auth, fileId, {
      range,
      redirect,
      disposition: disp,
      provider,
      ifNoneMatch,
      isHead,
    });

    if (!res) {
      return result;
    }

    if (result.kind === 'redirect') {
      res.redirect(result.statusCode, result.url);
      return;
    }

    if (result.kind === 'not_modified') {
      res.writeHead(result.statusCode, result.headers).end();
      return;
    }

    if (result.kind === 'range_not_satisfiable') {
      res.writeHead(result.statusCode, result.headers).end();
      return;
    }

    if (result.kind === 'stream') {
      res.writeHead(result.statusCode, result.headers);
      if (isHead) {
        res.end();
        return;
      }

      const stream = result.stream;
      let streamFinished = false;
      stream.on('end', () => {
        streamFinished = true;
      });
      stream.on('close', () => {
        streamFinished = true;
      });

      const cleanup = () => {
        if (!streamFinished) {
          streamFinished = true;
          const destroyable = stream as unknown as { destroy?: () => void };
          if (typeof destroyable.destroy === 'function') {
            destroyable.destroy();
          }
        }
      };

      res.on('close', cleanup);
      req?.on('close', cleanup);
      stream.pipe(res);
      return;
    }
  }

  @Get(':fileId/metadata')
  @ApiOperation({ summary: 'Get file metadata manifest' })
  @ApiResponse({ status: 200, description: 'File metadata manifest' })
  @ApiResponse({ status: 404, description: 'File not found' })
  @ApiResponse({ status: 403, description: 'Forbidden access to file' })
  getMetadata(
    @Param('fileId') fileId: string,
    @Req() req?: AuthenticatedHttpRequest,
  ) {
    const ctx = getRequestContext(req, 'req-meta');
    return this.fileQueryService.getMetadata(ctx, fileId);
  }

  @Post(':fileId/signed-url')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Generate time-limited signed URL' })
  @ApiResponse({ status: 200, description: 'Signed URL generated' })
  @ApiResponse({ status: 404, description: 'File not found' })
  @ApiResponse({ status: 403, description: 'Forbidden access to file' })
  async generateSignedUrl(
    @Param('fileId') fileId: string,
    @Body()
    body?: { expiresInSeconds?: number; disposition?: 'inline' | 'attachment' },
    @Req() req?: AuthenticatedHttpRequest,
  ) {
    const file = await this.fileRepo.findById(fileId);
    if (!file || file.status === 'DELETED' || file.status === 'DELETING') {
      throw new NotFoundError(`File '${fileId}' not found`);
    }

    if (req?.ctx) {
      if (!this.authzService.canAccessTenant(req.ctx, file.tenantId)) {
        throw new NotFoundError(`File '${fileId}' not found`);
      }
      const decision = this.authzService.authorize(req.ctx, 'read', {
        namespace: file.namespace,
        tenantId: file.tenantId,
        subTenantId: file.subTenantId,
        uploadedBy: file.uploadedBy,
        visibility: file.visibility,
      });
      if (!decision.allowed) {
        throw new ForbiddenError(decision.reason);
      }
    }

    const signed = this.signedUrlService.sign(fileId, {
      expiresInSeconds: body?.expiresInSeconds,
      disposition: body?.disposition,
    });

    return {
      fileId: signed.fileId,
      url: signed.url,
      expiresAt: signed.expiresAt.toISOString(),
      disposition: signed.disp,
    };
  }

  @Delete(':fileId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Purge file and replicas' })
  @ApiResponse({ status: 204, description: 'File deleted successfully' })
  @ApiResponse({ status: 404, description: 'File not found' })
  @ApiResponse({ status: 403, description: 'Forbidden access to file' })
  async deleteFile(
    @Param('fileId') fileId: string,
    @Req() req?: AuthenticatedHttpRequest,
  ) {
    const ctx = getRequestContext(req, 'req-delete');
    await this.deleteService.delete(ctx, fileId);
  }

  @Post('bulk-delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bulk delete files' })
  @ApiResponse({ status: 200, description: 'Bulk delete outcome' })
  @ApiResponse({ status: 400, description: 'Invalid fileIds input' })
  async bulkDelete(
    @Body() body?: { fileIds?: string[] },
    @Req() req?: AuthenticatedHttpRequest,
  ) {
    const ctx = getRequestContext(req, 'req-bulk-delete');
    return this.deleteService.bulkDelete(ctx, body?.fileIds ?? []);
  }
}
