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
  UseGuards,
  UseFilters,
  UseInterceptors,
  UploadedFiles,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiSecurity,
  ApiConsumes,
  ApiBody,
  ApiParam,
  ApiQuery,
  ApiHeader,
  ApiExtraModels,
} from '@nestjs/swagger';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { FilesService } from './files.service.js';
import { UploadService, type UploadOptions } from './upload.service.js';
import { FileReadService, type FileReadAuth } from './file-read.service.js';
import { SignedUrlService } from './signed-url.service.js';
import { DeleteService } from './delete.service.js';
import { HardDeleteService } from './hard-delete.service.js';
import { FileQueryService } from './file-query.service.js';
import { PresignedUploadService } from './presigned-upload.service.js';
import { IdempotencyService } from './idempotency.service.js';
import {
  InitiatePresignedUploadDto,
  InitiatePresignedUploadResponse,
  CompletePresignedUploadDto,
} from './dto/presigned-upload.dto.js';
import {
  FileUploadBodyDto,
  FileUploadSuccessResponseDto,
  FileUploadMultiStatusResponseDto,
  FileListQueryDto,
  FileListResponseDto,
  FileReadQueryDto,
  CreateSignedUrlDto,
  SignedUrlResponseDto,
  BulkDeleteRequestDto,
  BulkDeleteResponseDto,
  HardDeleteResponseDto,
  FileManifestResponseDto,
  ProblemDetailsDto,
  ManifestDataDto,
  TriggerReplicationDto,
  triggerReplicationSchema,
  fileIdParamSchema,
  fileListQuerySchema,
  fileReadQuerySchema,
  createSignedUrlSchema,
  bulkDeleteSchema,
  fileUploadMetadataSchema,
} from './dto/files.dto.js';
import { FileRepository } from '../db/repositories/file.repository.js';
import { ReplicaRepository } from '../db/repositories/replica.repository.js';
import { OutboxRepository } from '../db/repositories/outbox.repository.js';
import { OutboxWriter } from '../events/outbox-writer.js';
import { DatabaseService } from '../db/database.service.js';
import { AuthorizationService } from '../authz/authorization.service.js';
import { AuthGuard } from '../auth/guards/auth.guard.js';
import { ContextGuard } from '../auth/guards/context.guard.js';
import { AuthorizationGuard } from '../authz/guards/authorization.guard.js';
import { ProblemJsonErrorFilter } from '../common/filters/problem-json-error.filter.js';
import { Accept } from '../auth/decorators/accept.decorator.js';
import { Namespace } from '../auth/decorators/namespace.decorator.js';
import { RequireAction } from '../authz/decorators/require-action.decorator.js';
import { Public } from '../auth/decorators/public.decorator.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { StagingCleanupInterceptor } from '../ingest/staging-cleanup.js';
import { IngestValidationPipe } from '../ingest/ingest-validation.pipe.js';
import { multerOptionsFactory } from '../ingest/multer-options.js';
import type { IngestedFile } from '../ingest/types.js';
import { PolicyRegistry } from '../config/policy-registry.js';
import type { AuthenticatedHttpRequest } from '../auth/context.js';
import type { RequestContext } from '../core/request-context.js';
import {
  ForbiddenError,
  NotFoundError,
  StorageUnavailableError,
  ValidationError,
} from '../core/errors/app-error.js';
import type { UploadManifestResponse } from '../core/manifest.js';
import { EVENT_TYPES } from '../events/catalog.js';
import { createEnvelope } from '../events/envelope.js';
import type { Provider } from '../core/types.js';

function getRequestContext(
  req?: AuthenticatedHttpRequest,
  defaultCorrelationId = 'req',
): RequestContext {
  if (req?.ctx) {
    return req.ctx;
  }
  return {
    namespace: 'generic',
    tenantId: 'default',
    actor: {
      id: 'anonymous',
      type: 'user',
      roles: [],
      scopes: ['files:read', 'files:write', 'files:delete'],
    },
    correlationId: defaultCorrelationId,
    ipAddress: req?.ip ?? '127.0.0.1',
    attributes: {},
  };
}

@ApiTags('files')
@ApiBearerAuth()
@ApiSecurity('api-key')
@ApiExtraModels(
  ProblemDetailsDto,
  ManifestDataDto,
  FileManifestResponseDto,
  FileListQueryDto,
  FileReadQueryDto,
  TriggerReplicationDto,
  HardDeleteResponseDto,
)
@Controller('api/v1/files')
@UseGuards(AuthGuard, ContextGuard, AuthorizationGuard)
@UseFilters(ProblemJsonErrorFilter)
@Accept('bearer-jwt', 'api-key', 'school-jwt', 'admin-jwt')
@Namespace('generic')
export class FilesController {
  constructor(
    private readonly filesService: FilesService,
    private readonly uploadService: UploadService,
    private readonly fileReadService: FileReadService,
    private readonly signedUrlService: SignedUrlService,
    private readonly deleteService: DeleteService,
    private readonly hardDeleteService: HardDeleteService,
    private readonly fileQueryService: FileQueryService,
    private readonly presignedUploadService: PresignedUploadService,
    private readonly fileRepo: FileRepository,
    private readonly replicaRepo: ReplicaRepository,
    private readonly outboxRepo: OutboxRepository,
    private readonly outboxWriter: OutboxWriter,
    private readonly dbService: DatabaseService,
    private readonly authzService: AuthorizationService,
    private readonly policyRegistry: PolicyRegistry,
    private readonly idempotencyService: IdempotencyService,
  ) {}

  // ── 1. Multipart Upload ─────────────────────────────────────────────────────

  @Post('upload')
  @HttpCode(HttpStatus.CREATED)
  @RequireAction('upload')
  @UseInterceptors(
    StagingCleanupInterceptor,
    AnyFilesInterceptor(multerOptionsFactory()),
  )
  @ApiOperation({
    summary: 'Upload file(s)',
    description:
      'Accepts single or multi-file multipart uploads. Returns 201 when all succeed, or 207 Multi-Status with per-file outcomes for partial failures.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'Client-provided unique idempotency key',
  })
  @ApiBody({ type: FileUploadBodyDto })
  @ApiResponse({
    status: 201,
    description: 'File(s) uploaded successfully',
    type: FileUploadSuccessResponseDto,
  })
  @ApiResponse({
    status: 207,
    description: 'Multi-Status: partial upload success/failure outcome',
    type: FileUploadMultiStatusResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Bad Request / Validation error',
    type: ProblemDetailsDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated',
    type: ProblemDetailsDto,
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden action or scope',
    type: ProblemDetailsDto,
  })
  @ApiResponse({
    status: 413,
    description: 'Payload too large',
    type: ProblemDetailsDto,
  })
  @ApiResponse({
    status: 415,
    description: 'Unsupported media type',
    type: ProblemDetailsDto,
  })
  @ApiResponse({
    status: 422,
    description: 'Validation failed',
    type: ProblemDetailsDto,
  })
  @ApiResponse({
    status: 507,
    description: 'Insufficient quota',
    type: ProblemDetailsDto,
  })
  async upload(
    @UploadedFiles(IngestValidationPipe)
    files: IngestedFile | IngestedFile[] | Record<string, IngestedFile[]>,
    @Body(new ZodValidationPipe(fileUploadMetadataSchema))
    body: {
      folder?: string;
      visibility?: 'public' | 'tenant' | 'private';
      tags?: string[];
      attributes?: Record<string, string>;
      subTenantId?: string;
      atomic?: boolean;
    },
    @Req() req?: AuthenticatedHttpRequest,
    @Res() res?: Response,
  ) {
    const idempotencyKey = req?.headers['idempotency-key'] as string | undefined;
    const ctx = getRequestContext(req, 'req-upload');
    const policy = this.policyRegistry.get(ctx.namespace);

    // Normalize ingested files into an array
    let fileList: IngestedFile[] = [];
    if (Array.isArray(files)) {
      fileList = files;
    } else if (files && typeof files === 'object') {
      if ('openReadStream' in files) {
        fileList = [files as IngestedFile];
      } else {
        fileList = Object.values(files).flat();
      }
    }

    if (fileList.length === 0) {
      throw new ValidationError('No files were provided for upload');
    }

    if (idempotencyKey) {
      const combinedHash = fileList.map((f) => f.sha256).join(':');
      const fingerprint = this.idempotencyService.computeFingerprint(
        combinedHash,
        body.folder ?? '',
        body.visibility ?? 'tenant',
        body.tags ?? [],
      );
      const evalResult = await this.idempotencyService.acquireOrCheck(
        ctx.tenantId,
        idempotencyKey,
        fingerprint,
      );

      if (evalResult.status === 'REPLAYED') {
        if (res) {
          res.setHeader('Idempotent-Replayed', 'true');
          return res
            .status(evalResult.responseStatus)
            .json(evalResult.responseBody);
        }
        return evalResult.responseBody;
      }
    }

    const options: UploadOptions = {
      folder: body.folder,
      visibility: body.visibility,
      tags: body.tags,
      attributes: body.attributes,
      atomic: body.atomic ?? false,
      idempotencyKey,
    };

    let outcomes;
    try {
      outcomes = await this.uploadService.upload(
        ctx,
        policy,
        fileList,
        options,
      );
    } catch (err: unknown) {
      if (idempotencyKey) {
        await this.idempotencyService.releaseKey(ctx.tenantId, idempotencyKey);
      }
      throw err;
    }

    const hasFailure = outcomes.some((o) => !o.success);
    if (hasFailure && idempotencyKey) {
      await this.idempotencyService.releaseKey(ctx.tenantId, idempotencyKey);
    }

    if (!hasFailure) {
      const manifests = outcomes.map(
        (o) => (o as { manifest: UploadManifestResponse }).manifest,
      );

      const responsePayload =
        manifests.length === 1
          ? manifests[0]
          : {
              success: true,
              message:
                'Files uploaded. Replication to secondary storage is queued.',
              data: manifests,
              files: manifests,
            };

      if (idempotencyKey) {
        const firstId =
          manifests.length === 1 ? manifests[0].data.fileId : undefined;
        await this.idempotencyService.recordCompleted(
          ctx.tenantId,
          idempotencyKey,
          HttpStatus.CREATED,
          responsePayload as Record<string, unknown>,
          firstId,
        );
      }

      if (res) {
        return res.status(HttpStatus.CREATED).json(responsePayload);
      }
      return responsePayload;
    }

    // Partial multi-status (207) outcome
    const multiStatusPayload = {
      success: false,
      message: 'Batch upload completed with one or more failures.',
      outcomes: outcomes.map((o) =>
        o.success
          ? {
              success: true,
              fileId: o.fileId,
              manifest: o.manifest,
            }
          : {
              success: false,
              filename: o.filename,
              error: {
                code: o.error.code,
                message: o.error.message,
              },
            },
      ),
    };

    if (res) {
      return res.status(207).json(multiStatusPayload);
    }
    return multiStatusPayload;
  }

  // ── 2. Presigned Direct-to-Storage Upload ────────────────────────────────────

  @Post('presigned-upload')
  @HttpCode(HttpStatus.CREATED)
  @RequireAction('upload')
  @ApiOperation({
    summary: 'Initiate direct-to-storage presigned upload',
    description:
      'Reserves quota and generates a presigned PUT URL for direct storage upload',
  })
  @ApiResponse({
    status: 201,
    description: 'Presigned upload URL created',
    type: InitiatePresignedUploadResponse,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation error',
    type: ProblemDetailsDto,
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden branch or upload access',
    type: ProblemDetailsDto,
  })
  @ApiResponse({
    status: 413,
    description: 'Payload too large',
    type: ProblemDetailsDto,
  })
  @ApiResponse({
    status: 415,
    description: 'Unsupported media type',
    type: ProblemDetailsDto,
  })
  @ApiResponse({
    status: 507,
    description: 'Insufficient storage quota',
    type: ProblemDetailsDto,
  })
  async initiatePresignedUpload(
    @Body() body: InitiatePresignedUploadDto,
    @Req() req?: AuthenticatedHttpRequest,
  ) {
    const ctx = getRequestContext(req, 'req-presigned-init');
    const result = await this.presignedUploadService.initiate(ctx, body);
    return {
      success: true,
      data: result,
      ...result,
    };
  }

  @Post(':fileId/complete-upload')
  @HttpCode(HttpStatus.OK)
  @RequireAction('upload')
  @ApiOperation({
    summary: 'Confirm and finalize direct upload',
    description:
      'Verifies object existence in storage, commits quota, and creates manifest',
  })
  @ApiParam({ name: 'fileId', description: 'UUIDv7 identifier of the file' })
  @ApiResponse({
    status: 200,
    description: 'File manifest after confirmation',
    type: FileManifestResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'File not found or cross-tenant',
    type: ProblemDetailsDto,
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden access to file',
    type: ProblemDetailsDto,
  })
  @ApiResponse({
    status: 503,
    description: 'Storage object not found in SeaweedFS',
    type: ProblemDetailsDto,
  })
  async completePresignedUpload(
    @Param(new ZodValidationPipe(fileIdParamSchema)) param: { fileId: string },
    @Body() body?: CompletePresignedUploadDto,
    @Req() req?: AuthenticatedHttpRequest,
  ) {
    const ctx = getRequestContext(req, 'req-presigned-complete');
    return this.presignedUploadService.complete(ctx, param.fileId, body);
  }

  // ── 3. List Files ───────────────────────────────────────────────────────────

  @Get()
  @RequireAction('list')
  @ApiOperation({
    summary: 'List files for tenant',
    description: 'Keyset pagination with authorization scoping and filters',
  })
  @ApiQuery({
    name: 'folder',
    required: false,
    description: 'Folder prefix filter',
  })
  @ApiQuery({
    name: 'subTenantId',
    required: false,
    description: 'Sub-tenant (branch) filter',
  })
  @ApiQuery({
    name: 'mimetype',
    required: false,
    description: 'MIME type filter',
  })
  @ApiQuery({ name: 'tag', required: false, description: 'Tag filter' })
  @ApiQuery({
    name: 'createdFrom',
    required: false,
    description: 'ISO start datetime',
  })
  @ApiQuery({
    name: 'createdTo',
    required: false,
    description: 'ISO end datetime',
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    description: 'Opaque pagination cursor',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Page size (1-100, default 20)',
  })
  @ApiResponse({
    status: 200,
    description: 'Paginated file listing',
    type: FileListResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated',
    type: ProblemDetailsDto,
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden',
    type: ProblemDetailsDto,
  })
  listFiles(
    @Query(new ZodValidationPipe(fileListQuerySchema))
    query: {
      folder?: string;
      subTenantId?: string;
      mimetype?: string;
      tag?: string;
      status?: 'ACTIVE' | 'DELETED' | 'DELETING' | 'PENDING_UPLOAD' | 'QUARANTINED';
      createdFrom?: string;
      createdTo?: string;
      cursor?: string;
      limit?: number;
    },
    @Req() req?: AuthenticatedHttpRequest,
  ) {
    const ctx = getRequestContext(req, 'req-list');
    return this.fileQueryService
      .list(
        ctx,
        {
          folder: query.folder,
          subTenantId: query.subTenantId,
          mimetype: query.mimetype,
          tag: query.tag,
          status: query.status,
        },
        query.cursor,
        query.limit ?? 20,
      )
      .then((res) => ({
        files: res.items,
        total: res.total,
        count: res.items.length,
        nextCursor: res.nextCursor,
        hasMore: res.hasMore,
      }));
  }

  // ── 4. Get File Content (Download / Stream) ─────────────────────────────────

  @Public()
  @Get(':fileId')
  @Head(':fileId')
  @ApiOperation({
    summary: 'Download or stream file content',
    description:
      'Supports byte ranges (206), conditionals (304), signed URLs, and storage redirects (302)',
  })
  @ApiParam({ name: 'fileId', description: 'UUIDv7 identifier of the file' })
  @ApiHeader({
    name: 'Range',
    required: false,
    description: 'Byte range header (e.g. bytes=0-1023)',
  })
  @ApiHeader({
    name: 'If-None-Match',
    required: false,
    description: 'ETag validation header',
  })
  @ApiQuery({
    name: 'sig',
    required: false,
    description: 'HMAC signature for signed URL access',
  })
  @ApiQuery({
    name: 'exp',
    required: false,
    description: 'Expiry timestamp for signed URL',
  })
  @ApiQuery({ name: 'disp', required: false, enum: ['inline', 'attachment'] })
  @ApiQuery({
    name: 'redirect',
    required: false,
    enum: ['auto', 'always', 'never'],
  })
  @ApiQuery({
    name: 'provider',
    required: false,
    enum: ['local', 'cloudinary', 'seaweedfs'],
  })
  @ApiQuery({
    name: 'variant',
    required: false,
    description: 'Image derivative variant name (e.g. thumb, medium)',
  })
  @ApiResponse({ status: 200, description: 'Full file content stream' })
  @ApiResponse({ status: 206, description: 'Partial content byte range slice' })
  @ApiResponse({ status: 302, description: 'Direct storage / CDN redirect' })
  @ApiResponse({
    status: 304,
    description: 'Not modified conditional ETag match',
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated (for private files)',
    type: ProblemDetailsDto,
  })
  @ApiResponse({
    status: 404,
    description: 'File not found or cross-tenant',
    type: ProblemDetailsDto,
  })
  @ApiResponse({ status: 416, description: 'Range not satisfiable' })
  async getFileContent(
    @Param(new ZodValidationPipe(fileIdParamSchema)) param: { fileId: string },
    @Query(new ZodValidationPipe(fileReadQuerySchema))
    query: {
      exp?: string;
      disp?: 'inline' | 'attachment';
      sig?: string;
      redirect?: 'auto' | 'always' | 'never';
      provider?: 'local' | 'cloudinary' | 'seaweedfs';
      variant?: string;
    },
    @Headers('range') range?: string,
    @Headers('if-none-match') ifNoneMatch?: string,
    @Req() req?: AuthenticatedHttpRequest,
    @Res() res?: Response,
  ) {
    const isHead = req?.method === 'HEAD';
    const auth: FileReadAuth = {
      ctx: req?.ctx ?? null,
      signature: query.sig
        ? { exp: query.exp, disp: query.disp, sig: query.sig }
        : undefined,
    };

    const result = await this.fileReadService.open(auth, param.fileId, {
      range,
      redirect: query.redirect,
      disposition: query.disp,
      provider: query.provider,
      ifNoneMatch,
      isHead,
      variant: query.variant,
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
      stream.on('error', (err) => {
        if (res.headersSent) {
          res.destroy(err instanceof Error ? err : new Error(String(err)));
        }
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

  // ── 5. Get Metadata Manifest ────────────────────────────────────────────────

  @Get(':fileId/metadata')
  @RequireAction('read')
  @ApiOperation({ summary: 'Get file metadata manifest without content bytes' })
  @ApiParam({ name: 'fileId', description: 'UUIDv7 identifier of the file' })
  @ApiResponse({
    status: 200,
    description: 'File metadata manifest',
    type: FileManifestResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'File not found or cross-tenant',
    type: ProblemDetailsDto,
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden access to file',
    type: ProblemDetailsDto,
  })
  getMetadata(
    @Param(new ZodValidationPipe(fileIdParamSchema)) param: { fileId: string },
    @Req() req?: AuthenticatedHttpRequest,
  ) {
    const ctx = getRequestContext(req, 'req-meta');
    return this.fileQueryService.getMetadata(ctx, param.fileId);
  }

  // ── 6. Generate Signed URL ──────────────────────────────────────────────────

  @Post(':fileId/signed-url')
  @HttpCode(HttpStatus.OK)
  @RequireAction('read')
  @ApiOperation({
    summary: 'Generate time-limited signed URL for direct content access',
  })
  @ApiParam({ name: 'fileId', description: 'UUIDv7 identifier of the file' })
  @ApiBody({ type: CreateSignedUrlDto })
  @ApiResponse({
    status: 200,
    description: 'Signed URL generated',
    type: SignedUrlResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'File not found or cross-tenant',
    type: ProblemDetailsDto,
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden access to file',
    type: ProblemDetailsDto,
  })
  async generateSignedUrl(
    @Param(new ZodValidationPipe(fileIdParamSchema)) param: { fileId: string },
    @Body(new ZodValidationPipe(createSignedUrlSchema))
    body?: {
      expiresInSeconds?: number;
      ttlSeconds?: number;
      disposition?: 'inline' | 'attachment';
    },
    @Req() req?: AuthenticatedHttpRequest,
  ) {
    const file = await this.fileRepo.findById(param.fileId);
    if (!file || file.status === 'DELETED' || file.status === 'DELETING') {
      throw new NotFoundError(`File '${param.fileId}' not found`);
    }

    const ctx = getRequestContext(req, 'req-signed-url');

    if (!this.authzService.canAccessTenant(ctx, file.tenantId)) {
      throw new NotFoundError(`File '${param.fileId}' not found`);
    }
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

    const effectiveTtl = body?.expiresInSeconds ?? body?.ttlSeconds ?? 900;
    const signed = this.signedUrlService.sign(param.fileId, {
      expiresInSeconds: effectiveTtl,
      disposition: body?.disposition,
    });

    return {
      fileId: signed.fileId,
      url: signed.url,
      expiresAt: signed.expiresAt.toISOString(),
      disposition: signed.disp,
    };
  }

  // ── 7. Delete File ──────────────────────────────────────────────────────────

  @Delete(':fileId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireAction('delete')
  @ApiOperation({ summary: 'Purge file and replicas' })
  @ApiParam({ name: 'fileId', description: 'UUIDv7 identifier of the file' })
  @ApiResponse({ status: 204, description: 'File deleted successfully' })
  @ApiResponse({
    status: 404,
    description: 'File not found or cross-tenant',
    type: ProblemDetailsDto,
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden access to file',
    type: ProblemDetailsDto,
  })
  async deleteFile(
    @Param(new ZodValidationPipe(fileIdParamSchema)) param: { fileId: string },
    @Req() req?: AuthenticatedHttpRequest,
  ) {
    const ctx = getRequestContext(req, 'req-delete');
    await this.deleteService.delete(ctx, param.fileId);
  }

  @Delete(':fileId/permanent')
  @HttpCode(HttpStatus.OK)
  @RequireAction('delete')
  @ApiOperation({
    summary: 'Permanently purge a file and all replicas (hard delete)',
    description:
      'Immediately purges physical storage objects across all drivers, deletes DB records, enqueues file.erased audit event, and frees quota.',
  })
  @ApiParam({ name: 'fileId', description: 'UUIDv7 identifier of the file' })
  @ApiResponse({
    status: 200,
    description: 'File and replicas permanently erased',
    type: HardDeleteResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'File not found or cross-tenant',
    type: ProblemDetailsDto,
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden access to file',
    type: ProblemDetailsDto,
  })
  async hardDeleteFile(
    @Param(new ZodValidationPipe(fileIdParamSchema)) param: { fileId: string },
    @Req() req?: AuthenticatedHttpRequest,
  ): Promise<HardDeleteResponseDto> {
    const ctx = getRequestContext(req, 'req-hard-delete');
    const file = await this.fileRepo.findById(param.fileId);
    if (!file) {
      throw new NotFoundError(`File '${param.fileId}' not found`);
    }

    if (!this.authzService.canAccessTenant(ctx, file.tenantId)) {
      throw new NotFoundError(`File '${param.fileId}' not found`);
    }

    const decision = this.authzService.authorize(ctx, 'delete', {
      namespace: file.namespace,
      tenantId: file.tenantId,
      subTenantId: file.subTenantId,
      uploadedBy: file.uploadedBy,
      visibility: file.visibility,
    });
    if (!decision.allowed) {
      throw new ForbiddenError(decision.reason);
    }

    const result = await this.hardDeleteService.hardDeleteFile({
      fileId: param.fileId,
      operator: ctx.actor.id,
      reason: 'Permanent delete requested via API',
    });

    return {
      success: true,
      message: 'File and all replicas permanently deleted',
      fileId: result.fileId,
      replicasDeleted: result.replicasDeleted,
      dbRecordsDeleted: result.dbRecordsDeleted,
    };
  }

  // ── 8. Bulk Delete ──────────────────────────────────────────────────────────

  @Post('bulk-delete')
  @HttpCode(HttpStatus.OK)
  @RequireAction('delete')
  @ApiOperation({ summary: 'Bulk delete up to 100 files' })
  @ApiBody({ type: BulkDeleteRequestDto })
  @ApiResponse({
    status: 200,
    description: 'Bulk delete outcome',
    type: BulkDeleteResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid fileIds input',
    type: ProblemDetailsDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated',
    type: ProblemDetailsDto,
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden',
    type: ProblemDetailsDto,
  })
  async bulkDelete(
    @Body(new ZodValidationPipe(bulkDeleteSchema)) body: { fileIds: string[] },
    @Req() req?: AuthenticatedHttpRequest,
  ) {
    const ctx = getRequestContext(req, 'req-bulk-delete');
    const result = await this.deleteService.bulkDelete(ctx, body.fileIds);
    return {
      requested: result.total,
      total: result.total,
      deletedCount: result.deletedCount,
      failedCount: result.failedCount,
      results: result.results,
    };
  }

  // ── 9. Operational Admin Endpoints [P4-10] ─────────────────────────────────

  @Post(':fileId/replicate')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequireAction('admin')
  @ApiOperation({
    summary: 'Manually trigger replication for a file (admin)',
    description:
      'Enqueues file.replicate outbox events for specified target providers or missing secondary replicas.',
  })
  @ApiParam({ name: 'fileId', description: 'UUIDv7 identifier of the file' })
  @ApiBody({ type: TriggerReplicationDto, required: false })
  @ApiResponse({
    status: 202,
    description: 'Replication jobs enqueued successfully',
  })
  @ApiResponse({
    status: 404,
    description: 'File not found or cross-tenant',
    type: ProblemDetailsDto,
  })
  async triggerReplication(
    @Param(new ZodValidationPipe(fileIdParamSchema)) param: { fileId: string },
    @Body(new ZodValidationPipe(triggerReplicationSchema))
    body?: TriggerReplicationDto,
    @Req() req?: AuthenticatedHttpRequest,
  ) {
    const file = await this.fileRepo.findById(param.fileId);
    if (!file || file.status === 'DELETED') {
      throw new NotFoundError(`File '${param.fileId}' not found`);
    }

    const ctx = getRequestContext(req, 'req-manual-replicate');
    if (!this.authzService.canAccessTenant(ctx, file.tenantId)) {
      throw new NotFoundError(`File '${param.fileId}' not found`);
    }

    let targets: Provider[] = [];
    if (body?.targetProvider) {
      targets.push(body.targetProvider as Provider);
    } else if (
      Array.isArray(body?.targetProviders) &&
      body.targetProviders.length > 0
    ) {
      targets = body.targetProviders as Provider[];
    } else {
      const replicas = await this.replicaRepo.listByFile(param.fileId);
      const missing = replicas.filter((r) => r.status !== 'AVAILABLE');
      if (missing.length > 0) {
        targets = missing.map((r) => r.provider);
      } else {
        targets = (['local', 'seaweedfs', 'cloudinary'] as Provider[]).filter(
          (p) => p !== file.primaryProvider,
        );
      }
    }

    const database = this.dbService.getDb();
    if (!database) {
      throw new StorageUnavailableError('Database service unavailable');
    }

    const enqueuedTargets: Provider[] = [];

    await database.transaction().execute(async (trx) => {
      for (const provider of targets) {
        const replicas = await this.replicaRepo.listByFile(param.fileId, trx);
        const existing = replicas.find((r) => r.provider === provider);

        if (!existing) {
          await this.replicaRepo.insertMany(
            [
              {
                fileId: param.fileId,
                provider,
                role: 'secondary',
                status: 'QUEUED',
                providerKey: file.storageKey,
              },
            ],
            trx,
          );
        } else if (
          existing.status !== 'AVAILABLE' &&
          existing.status !== 'IN_PROGRESS'
        ) {
          await this.replicaRepo.requeue(param.fileId, provider, trx);
        }

        const envelope = createEnvelope({
          eventType: EVENT_TYPES.FILE_REPLICATE,
          partitionKey: param.fileId,
          payload: { fileId: param.fileId, targetProvider: provider },
          context: ctx,
          namespace: file.namespace,
          tenantId: file.tenantId,
        });

        await this.outboxWriter.enqueue(trx, envelope);
        enqueuedTargets.push(provider);
      }
    });

    return {
      fileId: param.fileId,
      status: 'QUEUED',
      enqueuedTargets,
    };
  }

  @Get('/api/v1/admin/replication')
  @RequireAction('admin')
  @ApiOperation({
    summary:
      'Get replication engine operational metrics and status summary (admin)',
  })
  @ApiResponse({
    status: 200,
    description: 'Replication operational metrics summary',
  })
  async getReplicationAdminSummary() {
    const statusCounts = await this.replicaRepo.countByStatus();
    const oldestQueuedAgeSeconds =
      await this.replicaRepo.getOldestQueuedAgeSeconds();
    const outboxPending = await this.outboxRepo.countUnpublished();

    return {
      statusCounts,
      oldestQueuedAgeSeconds,
      outboxPending,
      dlqDepth: 0,
    };
  }
}
