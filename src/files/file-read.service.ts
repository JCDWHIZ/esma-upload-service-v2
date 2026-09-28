import { Injectable, Logger } from '@nestjs/common';
import { Readable } from 'node:stream';
import { AppConfigService } from '../config/config.service.js';
import { RequestContext } from '../core/request-context.js';
import { FileRecord, FileReplica } from '../core/types.js';
import { ProviderName, ProviderRef } from '../storage/types.js';
import { StorageRegistry } from '../storage/registry.js';
import { FileRepository } from '../db/repositories/file.repository.js';
import { ReplicaRepository } from '../db/repositories/replica.repository.js';
import { AuthorizationService } from '../authz/authorization.service.js';
import { isEsmaAdminActor } from '../authz/authorize.js';
import {
  SignedUrlService,
  VerifySignatureQuery,
} from './signed-url.service.js';
import {
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  FileNotReadyError,
  FileQuarantinedError,
  ReplicaNotAvailableError,
  StorageUnavailableError,
} from '../core/errors/app-error.js';

export interface FileReadAuth {
  ctx?: RequestContext | null;
  signature?: VerifySignatureQuery;
}

export interface FileReadOptions {
  range?: string;
  redirect?: 'auto' | 'always' | 'never';
  disposition?: 'inline' | 'attachment';
  provider?: ProviderName;
  ifNoneMatch?: string;
  signal?: AbortSignal;
  isHead?: boolean;
}

export type FileReadResult =
  | {
      kind: 'stream';
      statusCode: 200 | 206;
      headers: Record<string, string>;
      stream: Readable;
      file: FileRecord;
      size: number;
    }
  | {
      kind: 'range_not_satisfiable';
      statusCode: 416;
      headers: Record<string, string>;
      file: FileRecord;
    }
  | {
      kind: 'not_modified';
      statusCode: 304;
      headers: Record<string, string>;
      file: FileRecord;
    }
  | {
      kind: 'redirect';
      statusCode: 302;
      url: string;
      headers: Record<string, string>;
      file: FileRecord;
    };

function isInlineSafeMime(mimetype: string): boolean {
  return mimetype.startsWith('image/') || mimetype === 'application/pdf';
}

function sanitizeFilename(name: string): string {
  return name.replace(/["\r\n\\]/g, '_');
}

@Injectable()
export class FileReadService {
  private readonly logger = new Logger(FileReadService.name);

  constructor(
    private readonly fileRepo: FileRepository,
    private readonly replicaRepo: ReplicaRepository,
    private readonly storageRegistry: StorageRegistry,
    private readonly authzService: AuthorizationService,
    private readonly signedUrlService: SignedUrlService,
    private readonly configService: AppConfigService,
  ) {}

  /**
   * Resolves, authorizes and prepares a file for delivery (streaming, range or redirect).
   * Conforms to ARCH §4.3, §4.5, §7.2 and BACKEND_TASKS P2-07.
   */
  async open(
    authOrCtx:
      RequestContext | VerifySignatureQuery | FileReadAuth | null | undefined,
    fileId: string,
    options?: FileReadOptions,
  ): Promise<FileReadResult> {
    if (!fileId || typeof fileId !== 'string') {
      throw new NotFoundError('File not found');
    }

    // 1. Extract context and signature from input
    let ctx: RequestContext | null = null;
    let signatureQuery: VerifySignatureQuery | undefined = undefined;

    if (authOrCtx) {
      if (
        'namespace' in authOrCtx &&
        'tenantId' in authOrCtx &&
        'actor' in authOrCtx
      ) {
        ctx = authOrCtx;
      } else if ('sig' in authOrCtx || 'exp' in authOrCtx) {
        signatureQuery = authOrCtx;
      } else if ('ctx' in authOrCtx || 'signature' in authOrCtx) {
        const composite = authOrCtx;
        ctx = composite.ctx ?? null;
        signatureQuery = composite.signature;
      }
    }

    // 2. Load file and replica rows
    const file = await this.fileRepo.findById(fileId);
    if (!file) {
      throw new NotFoundError(`File '${fileId}' not found`);
    }

    // 3. Status and Scan gating
    if (file.status === 'DELETED' || file.status === 'DELETING') {
      throw new NotFoundError(`File '${fileId}' not found`);
    }

    if (file.status === 'QUARANTINED' || file.scanStatus === 'INFECTED') {
      throw new FileQuarantinedError(
        `File '${fileId}' has been quarantined due to security scan failure`,
      );
    }

    if (file.scanStatus === 'PENDING') {
      throw new FileNotReadyError(
        `File '${fileId}' is undergoing virus scanning and is not ready`,
      );
    }

    if (file.status !== 'ACTIVE') {
      throw new NotFoundError(`File '${fileId}' not found`);
    }

    // 4. Authorization per ARCH §4.3
    let verifiedSignedDisp: 'inline' | 'attachment' | undefined = undefined;
    let isAuthorizedBySignature = false;

    if (signatureQuery && signatureQuery.sig) {
      const verifyRes = this.signedUrlService.verify(fileId, signatureQuery);
      if (verifyRes.valid) {
        isAuthorizedBySignature = true;
        verifiedSignedDisp = verifyRes.disposition;
      } else if (file.visibility === 'private' && !ctx) {
        // Tampered or expired signature without alternative auth throws
        throw new UnauthenticatedError(
          `Invalid or expired signed URL: ${verifyRes.reason ?? 'INVALID_SIGNATURE'}`,
        );
      }
    }

    if (!isAuthorizedBySignature) {
      if (file.visibility === 'public') {
        // Public files can be read by anyone (authenticated or unauthenticated)
      } else if (file.visibility === 'tenant') {
        if (!ctx) {
          throw new UnauthenticatedError(
            'Authentication required to access tenant file',
          );
        }

        const isPlatformAdmin = isEsmaAdminActor(ctx);
        // Cross-tenant check: return 404 to avoid leaking file existence (ARCH §4.3 & F-42)
        if (!isPlatformAdmin) {
          if (
            !this.authzService.canAccessTenant(ctx, file.tenantId) ||
            ctx.namespace !== file.namespace
          ) {
            throw new NotFoundError(`File '${fileId}' not found`);
          }
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
      } else if (file.visibility === 'private') {
        if (!ctx) {
          throw new UnauthenticatedError(
            'Authentication or signed URL required for private file',
          );
        }

        const isPlatformAdmin = isEsmaAdminActor(ctx);
        // Cross-tenant check returns 404
        if (!isPlatformAdmin) {
          if (
            !this.authzService.canAccessTenant(ctx, file.tenantId) ||
            ctx.namespace !== file.namespace
          ) {
            throw new NotFoundError(`File '${fileId}' not found`);
          }
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
      }
    }

    // 5. Conditional ETag check (If-None-Match)
    const etag = file.sha256
      ? `"${file.sha256}"`
      : `W/"${file.id}-${file.version}"`;
    const baseHeaders: Record<string, string> = {
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': 'sandbox',
      'Accept-Ranges': 'bytes',
      'Content-Type': file.mimetype,
      ETag: etag,
    };

    // Cache-Control by visibility (ARCH §4.5)
    if (file.visibility === 'public') {
      baseHeaders['Cache-Control'] = 'public, max-age=86400';
    } else {
      baseHeaders['Cache-Control'] = 'private, no-store';
    }

    if (options?.ifNoneMatch) {
      const clientEtags = options.ifNoneMatch
        .split(',')
        .map((e) => e.trim().replace(/^W\//, ''));
      const rawEtag = etag.replace(/^W\//, '');
      if (clientEtags.includes('*') || clientEtags.includes(rawEtag)) {
        return {
          kind: 'not_modified',
          statusCode: 304,
          headers: baseHeaders,
          file,
        };
      }
    }

    // 6. Replica selection (ARCH §7.2)
    const replicas = await this.replicaRepo.listByFile(fileId);
    let chosenReplica: FileReplica | undefined;

    if (options?.provider) {
      // ?provider=x requires files:admin
      const isAdmin =
        ctx &&
        (isEsmaAdminActor(ctx) ||
          ctx.actor.scopes?.includes('files:admin') ||
          ctx.actor.scopes?.includes('*'));

      if (!isAdmin) {
        throw new ForbiddenError(
          'Specifying provider replica requires admin privileges',
        );
      }

      chosenReplica = replicas.find((r) => r.provider === options.provider);
      if (!chosenReplica || chosenReplica.status !== 'AVAILABLE') {
        const error = new ReplicaNotAvailableError(
          `Requested provider replica '${options.provider}' is not available`,
        );
        // Expose Retry-After: 30
        (error as unknown as { headers?: Record<string, string> }).headers = {
          'Retry-After': '30',
        };
        throw error;
      }
    } else {
      const available = replicas.filter((r) => r.status === 'AVAILABLE');
      if (available.length > 0) {
        // Preference: for public files with redirect, prefer cloudinary if available
        if (options?.redirect !== 'never' && file.visibility === 'public') {
          chosenReplica =
            available.find((r) => r.provider === 'cloudinary') ??
            available.find((r) => r.role === 'primary') ??
            available[0];
        } else {
          chosenReplica =
            available.find((r) => r.role === 'primary') ??
            available.find((r) => r.provider === file.primaryProvider) ??
            available[0];
        }
      } else {
        // Fallback for single-driver mode when file record represents primary
        chosenReplica = {
          fileId: file.id,
          provider: file.primaryProvider,
          role: 'primary',
          status: 'AVAILABLE',
          providerKey: file.storageKey,
          providerMeta: {},
          url: null,
          etag: file.sha256,
          attempts: 0,
          lastError: null,
          syncedAt: null,
          createdAt: file.createdAt,
          updatedAt: file.updatedAt,
        };
      }
    }

    if (!chosenReplica) {
      throw new StorageUnavailableError(
        `No available storage replica found for file '${fileId}'`,
      );
    }

    const driver = this.storageRegistry.get(chosenReplica.provider);
    const providerRef: ProviderRef = {
      provider: chosenReplica.provider,
      key: chosenReplica.providerKey || file.storageKey,
      meta: chosenReplica.providerMeta,
    };

    // 7. Redirection vs Streaming check
    const redirectMode = options?.redirect ?? 'auto';
    if (redirectMode !== 'never') {
      let directUrl: string | null = null;

      if (
        chosenReplica.provider === 'cloudinary' &&
        file.visibility === 'public'
      ) {
        directUrl = await driver.getDirectUrl(providerRef, {
          disposition: options?.disposition ?? verifiedSignedDisp,
        });
      } else if (
        chosenReplica.provider === 'seaweedfs' &&
        this.configService.seaweedfsPublicEndpoint
      ) {
        directUrl = await driver.getDirectUrl(providerRef, {
          disposition: options?.disposition ?? verifiedSignedDisp,
          expiresInSeconds: 900,
        });
      }

      if (directUrl && (redirectMode === 'always' || redirectMode === 'auto')) {
        return {
          kind: 'redirect',
          statusCode: 302,
          url: directUrl,
          headers: {
            ...baseHeaders,
            Location: directUrl,
          },
          file,
        };
      }
    }

    // 8. Determine Content-Disposition
    const effectiveDisp =
      options?.disposition ??
      verifiedSignedDisp ??
      (isInlineSafeMime(file.mimetype) ? 'inline' : 'attachment');

    const sanitized = sanitizeFilename(file.originalFilename);
    const encoded = encodeURIComponent(file.originalFilename);
    const dispositionHeader =
      effectiveDisp === 'inline'
        ? `inline; filename="${sanitized}"; filename*=UTF-8''${encoded}`
        : `attachment; filename="${sanitized}"; filename*=UTF-8''${encoded}`;

    baseHeaders['Content-Disposition'] = dispositionHeader;

    // 9. Byte Range handling
    const totalBytes = Number(file.sizeBytes);
    const rangeHeader = options?.range?.trim();

    if (rangeHeader && rangeHeader.startsWith('bytes=')) {
      const rangeSpec = rangeHeader.slice('bytes='.length).trim();

      // If multi-range (e.g. contains comma), answer as full 200 per ARCH §7.2
      if (!rangeSpec.includes(',')) {
        const match = /^(\d*)-(\d*)$/.exec(rangeSpec);
        if (match) {
          const rawStart = match[1];
          const rawEnd = match[2];

          let start: number;
          let end: number;

          if (rawStart === '' && rawEnd !== '') {
            // Suffix range: bytes=-500 (last 500 bytes)
            const suffix = parseInt(rawEnd, 10);
            start = Math.max(0, totalBytes - suffix);
            end = totalBytes - 1;
          } else if (rawStart !== '' && rawEnd === '') {
            // Prefix range: bytes=500-
            start = parseInt(rawStart, 10);
            end = totalBytes - 1;
          } else if (rawStart !== '' && rawEnd !== '') {
            start = parseInt(rawStart, 10);
            end = parseInt(rawEnd, 10);
          } else {
            start = -1;
            end = -1;
          }

          // Validate bounds
          if (
            start < 0 ||
            start >= totalBytes ||
            end < start ||
            isNaN(start) ||
            isNaN(end)
          ) {
            return {
              kind: 'range_not_satisfiable',
              statusCode: 416,
              headers: {
                ...baseHeaders,
                'Content-Range': `bytes */${totalBytes}`,
                'Content-Length': '0',
              },
              file,
            };
          }

          end = Math.min(end, totalBytes - 1);
          const chunkSize = end - start + 1;

          const rangeHeaders = {
            ...baseHeaders,
            'Content-Range': `bytes ${start}-${end}/${totalBytes}`,
            'Content-Length': String(chunkSize),
          };

          if (options?.isHead) {
            return {
              kind: 'stream',
              statusCode: 206,
              headers: rangeHeaders,
              stream: Readable.from([]),
              file,
              size: chunkSize,
            };
          }

          const { stream } = await driver.downloadStream(providerRef, {
            range: { start, end },
            signal: options?.signal,
          });

          return {
            kind: 'stream',
            statusCode: 206,
            headers: rangeHeaders,
            stream,
            file,
            size: chunkSize,
          };
        }
      }
    }

    // Full 200 delivery
    const fullHeaders = {
      ...baseHeaders,
      'Content-Length': String(totalBytes),
    };

    if (options?.isHead) {
      return {
        kind: 'stream',
        statusCode: 200,
        headers: fullHeaders,
        stream: Readable.from([]),
        file,
        size: totalBytes,
      };
    }

    const { stream } = await driver.downloadStream(providerRef, {
      signal: options?.signal,
    });

    return {
      kind: 'stream',
      statusCode: 200,
      headers: fullHeaders,
      stream,
      file,
      size: totalBytes,
    };
  }
}
