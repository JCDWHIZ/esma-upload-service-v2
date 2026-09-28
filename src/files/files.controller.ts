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
import { FileRepository } from '../db/repositories/file.repository.js';
import { AuthorizationService } from '../authz/authorization.service.js';
import { Public } from '../auth/decorators/public.decorator.js';
import type { AuthenticatedHttpRequest } from '../auth/context.js';
import type { ProviderName } from '../storage/types.js';
import { ForbiddenError, NotFoundError } from '../core/errors/app-error.js';

@ApiTags('files')
@Controller('api/v1/files')
export class FilesController {
  constructor(
    private readonly filesService: FilesService,
    private readonly fileReadService: FileReadService,
    private readonly signedUrlService: SignedUrlService,
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
  listFiles() {
    return this.filesService.listFiles('default');
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
  getMetadata(@Param('fileId') fileId: string) {
    return this.filesService.getFileMetadata(fileId);
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
  deleteFile(@Param('fileId') fileId: string) {
    throw new NotImplementedException(
      `Delete service for ${fileId} scheduled for Phase 2`,
    );
  }

  @Post('bulk-delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bulk delete files' })
  bulkDelete() {
    throw new NotImplementedException('Bulk delete scheduled for Phase 2');
  }
}
