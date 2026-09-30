import { Injectable, Logger, Optional } from '@nestjs/common';
import { Readable } from 'node:stream';
import { AppConfigService } from '../config/config.service.js';
import { RequestContext } from '../core/request-context.js';
import { FileRecord } from '../core/types.js';
import { ProviderName, ProviderRef } from '../storage/types.js';
import { StorageRegistry } from '../storage/registry.js';
import { FileRepository } from '../db/repositories/file.repository.js';
import { ReplicaRepository } from '../db/repositories/replica.repository.js';
import { AuthorizationService } from '../authz/authorization.service.js';
import { isEsmaAdminActor } from '../authz/authorize.js';
import { ReplicaSelector } from './replica-selector.js';
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
  StorageUnavailableError,
} from '../core/errors/app-error.js';

export interface ReadMetrics {
  readsByProvider: Record<string, number>;
  fallbacks: number;
}

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
  private readonly selector: ReplicaSelector;

  public readonly metrics: ReadMetrics = {
    readsByProvider: {},
    fallbacks: 0,
  };

  constructor(
    private readonly fileRepo: FileRepository,
    private readonly replicaRepo: ReplicaRepository,
    private readonly storageRegistry: StorageRegistry,
    private readonly authzService: AuthorizationService,
    private readonly signedUrlService: SignedUrlService,
    private readonly configService: AppConfigService,
    @Optional() replicaSelector?: ReplicaSelector,
  ) {
    this.selector =
      replicaSelector ?? new ReplicaSelector(this.storageRegistry);
  }

  getMetrics(): ReadMetrics {
    return {
      readsByProvider: { ...this.metrics.readsByProvider },
      fallbacks: this.metrics.fallbacks,
    };
  }

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

    // 6. Determine Content-Disposition & Headers
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

    // 7. Byte Range parsing
    const totalBytes = Number(file.sizeBytes);
    const rangeHeader = options?.range?.trim();
    let parsedRange: { start: number; end: number; chunkSize: number } | null =
      null;

    if (rangeHeader && rangeHeader.startsWith('bytes=')) {
      const rangeSpec = rangeHeader.slice('bytes='.length).trim();

      // Multi-range: answer full 200 per ARCH §7.2
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
          parsedRange = { start, end, chunkSize };
        }
      }
    }

    // 8. Replica Candidate Selection via ReplicaSelector (ARCH §7.2, BACKEND_TASKS P4-08)
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
    }

    const replicas = await this.replicaRepo.listByFile(fileId);
    const candidates = this.selector.selectCandidates(file, replicas, {
      preferredProvider: options?.provider,
      redirectAllowed: options?.redirect !== 'never',
    });

    if (candidates.length === 0) {
      throw new StorageUnavailableError(
        `No available storage replica found for file '${fileId}'`,
      );
    }

    // 9. Mid-Request Fallback Loop (ARCH §7.2)
    // If opening the chosen replica fails before headers are sent, try the next candidate
    let lastError: unknown = null;
    const redirectMode = options?.redirect ?? 'auto';

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const driver = this.storageRegistry.get(candidate.provider);
      const providerRef: ProviderRef = {
        provider: candidate.provider,
        key: candidate.providerKey || file.storageKey,
        meta: candidate.providerMeta,
      };

      try {
        // A. Direct URL Redirection check
        if (redirectMode !== 'never') {
          let directUrl: string | null = null;

          if (
            candidate.provider === 'cloudinary' &&
            file.visibility === 'public'
          ) {
            directUrl = await driver.getDirectUrl(providerRef, {
              disposition: options?.disposition ?? verifiedSignedDisp,
            });
          } else if (
            candidate.provider === 'seaweedfs' &&
            this.configService.seaweedfsPublicEndpoint
          ) {
            directUrl = await driver.getDirectUrl(providerRef, {
              disposition: options?.disposition ?? verifiedSignedDisp,
              expiresInSeconds: 900,
            });
          }

          if (
            directUrl &&
            (redirectMode === 'always' || redirectMode === 'auto')
          ) {
            this.recordReadSuccess(candidate.provider);
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

        // B. HEAD request fast path
        if (options?.isHead) {
          this.recordReadSuccess(candidate.provider);
          if (parsedRange) {
            return {
              kind: 'stream',
              statusCode: 206,
              headers: {
                ...baseHeaders,
                'Content-Range': `bytes ${parsedRange.start}-${parsedRange.end}/${totalBytes}`,
                'Content-Length': String(parsedRange.chunkSize),
              },
              stream: Readable.from([]),
              file,
              size: parsedRange.chunkSize,
            };
          }
          return {
            kind: 'stream',
            statusCode: 200,
            headers: {
              ...baseHeaders,
              'Content-Length': String(totalBytes),
            },
            stream: Readable.from([]),
            file,
            size: totalBytes,
          };
        }

        // C. Byte Range streaming
        if (parsedRange) {
          const { stream } = await driver.downloadStream(providerRef, {
            range: { start: parsedRange.start, end: parsedRange.end },
            signal: options?.signal,
          });

          this.recordReadSuccess(candidate.provider);
          return {
            kind: 'stream',
            statusCode: 206,
            headers: {
              ...baseHeaders,
              'Content-Range': `bytes ${parsedRange.start}-${parsedRange.end}/${totalBytes}`,
              'Content-Length': String(parsedRange.chunkSize),
            },
            stream,
            file,
            size: parsedRange.chunkSize,
          };
        }

        // D. Full 200 delivery streaming
        const { stream } = await driver.downloadStream(providerRef, {
          signal: options?.signal,
        });

        this.recordReadSuccess(candidate.provider);
        return {
          kind: 'stream',
          statusCode: 200,
          headers: {
            ...baseHeaders,
            'Content-Length': String(totalBytes),
          },
          stream,
          file,
          size: totalBytes,
        };
      } catch (err: unknown) {
        lastError = err;
        const nextCandidate = candidates[i + 1];
        if (nextCandidate) {
          this.metrics.fallbacks++;
          this.logger.warn(
            `Primary/candidate replica "${candidate.provider}" failed to open for file ${fileId} (${String(
              err instanceof Error ? err.message : err,
            )}). Falling back to candidate "${nextCandidate.provider}"...`,
          );
          continue;
        }
        break;
      }
    }

    throw new StorageUnavailableError(
      `All storage replicas failed to serve file '${fileId}': ${String(
        lastError instanceof Error ? lastError.message : lastError,
      )}`,
    );
  }

  private recordReadSuccess(provider: ProviderName): void {
    this.metrics.readsByProvider[provider] =
      (this.metrics.readsByProvider[provider] ?? 0) + 1;
  }
}
