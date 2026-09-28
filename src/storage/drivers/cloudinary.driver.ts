import { Readable } from 'node:stream';
import { Injectable, Optional } from '@nestjs/common';
import { v2 as cloudinary, type UploadApiResponse } from 'cloudinary';
import { AppConfigService } from '../../config/config.service.js';
import {
  NotFoundError,
  PermanentError,
  PolicyViolationError,
  RetryableError,
} from '../../core/errors/app-error.js';
import { KeyService } from '../../core/storage-key.service.js';
import { classifyStorageError } from '../errors.js';
import type {
  DirectUrlOptions,
  DriverCapabilities,
  DriverHealth,
  DriverUploadResult,
  IStorageDriver,
  ProviderName,
  ProviderRef,
  ReadOptions,
  StorageObjectStat,
  StorageUploadInput,
} from '../types.js';

export interface CloudinaryDriverOptions {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  rootFolder?: string;
  maxObjectBytes?: number;
}

@Injectable()
export class CloudinaryStorageDriver implements IStorageDriver {
  public readonly name: ProviderName = 'cloudinary';
  public readonly capabilities: DriverCapabilities;

  private readonly cloudName: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly rootFolder: string;
  private readonly maxObjectBytes?: number;
  private readonly cloudinaryInstance: typeof cloudinary;

  constructor(
    @Optional() configOrOptions?: CloudinaryDriverOptions | AppConfigService,
    @Optional() customCloudinary?: typeof cloudinary,
  ) {
    if (configOrOptions instanceof AppConfigService) {
      const cfg = configOrOptions.get();
      this.cloudName = cfg.CLOUDINARY_CLOUD_NAME ?? '';
      this.apiKey = cfg.CLOUDINARY_API_KEY ?? '';
      this.apiSecret = cfg.CLOUDINARY_API_SECRET ?? '';
      this.rootFolder = cfg.CLOUDINARY_ROOT_FOLDER ?? 'uploads';
      this.maxObjectBytes = cfg.CLOUDINARY_MAX_OBJECT_BYTES;
    } else if (configOrOptions && typeof configOrOptions === 'object') {
      this.cloudName = configOrOptions.cloudName ?? '';
      this.apiKey = configOrOptions.apiKey ?? '';
      this.apiSecret = configOrOptions.apiSecret ?? '';
      this.rootFolder = configOrOptions.rootFolder ?? 'uploads';
      this.maxObjectBytes = configOrOptions.maxObjectBytes;
    } else {
      this.cloudName = process.env.CLOUDINARY_CLOUD_NAME ?? '';
      this.apiKey = process.env.CLOUDINARY_API_KEY ?? '';
      this.apiSecret = process.env.CLOUDINARY_API_SECRET ?? '';
      this.rootFolder = process.env.CLOUDINARY_ROOT_FOLDER ?? 'uploads';
      this.maxObjectBytes = process.env.CLOUDINARY_MAX_OBJECT_BYTES
        ? parseInt(process.env.CLOUDINARY_MAX_OBJECT_BYTES, 10)
        : undefined;
    }

    this.capabilities = {
      rangeReads: true,
      presignedUrls: false,
      publicCdn: true,
      imageTransforms: true,
      privateDelivery: false,
      maxObjectBytes: this.maxObjectBytes,
    };

    this.cloudinaryInstance = customCloudinary ?? cloudinary;
    if (this.isConfigured()) {
      this.cloudinaryInstance.config({
        cloud_name: this.cloudName,
        api_key: this.apiKey,
        api_secret: this.apiSecret,
        secure: true,
      });
    }
  }

  isConfigured(): boolean {
    return Boolean(
      this.cloudName &&
      this.cloudName.trim().length > 0 &&
      this.apiKey &&
      this.apiKey.trim().length > 0 &&
      this.apiSecret &&
      this.apiSecret.trim().length > 0,
    );
  }

  computePublicId(
    key: string,
    mimetype?: string,
  ): { publicId: string; resourceType: string } {
    let namespace = 'generic';
    if (key.startsWith('tenants/')) {
      namespace = 'esma-tenant';
    } else if (key.startsWith('system/')) {
      namespace = 'esma-admin';
    }

    const isRaw = mimetype
      ? !mimetype.startsWith('image/') && !mimetype.startsWith('video/')
      : false;
    const resourceType = isRaw
      ? 'raw'
      : mimetype?.startsWith('video/')
        ? 'video'
        : 'image';

    const publicId = KeyService.toLegacyPublicId(
      { namespace, cloudinaryRootFolder: this.rootFolder },
      key,
      resourceType,
    );

    return { publicId, resourceType };
  }

  async healthCheck(signal?: AbortSignal): Promise<DriverHealth> {
    const start = Date.now();
    try {
      if (signal?.aborted) {
        throw new Error('Health check aborted');
      }

      await this.cloudinaryInstance.api.ping();
      return {
        ok: true,
        latencyMs: Date.now() - start,
      };
    } catch (err: unknown) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async upload(input: StorageUploadInput): Promise<DriverUploadResult> {
    // Defense-in-depth: Refuse to upload non-public files to Cloudinary (F-26)
    if (input.visibility !== 'public') {
      throw new PolicyViolationError(
        `CloudinaryStorageDriver only permits files with 'public' visibility; received '${input.visibility}' (F-26)`,
      );
    }

    const { publicId, resourceType } = this.computePublicId(
      input.key,
      input.mimetype,
    );

    // Build tenant context metadata
    const context: Record<string, string> = {
      upload_timestamp: new Date().toISOString(),
    };
    if (input.attributes?.schoolId) {
      context.school_id = input.attributes.schoolId;
    }
    if (input.attributes?.branchId) {
      context.branch_id = input.attributes.branchId;
    }

    return new Promise<DriverUploadResult>((resolve, reject) => {
      const uploadStream = this.cloudinaryInstance.uploader.upload_stream(
        {
          public_id: publicId,
          resource_type: resourceType === 'raw' ? 'raw' : 'auto',
          overwrite: true,
          invalidate: true,
          tags: input.tags,
          context: Object.keys(context).length > 0 ? context : undefined,
        },
        (error?: unknown, result?: UploadApiResponse) => {
          if (error || !result) {
            reject(classifyStorageError(error, 'Cloudinary upload failed'));
            return;
          }

          resolve({
            ref: {
              provider: this.name,
              key: input.key,
              meta: {
                public_id: result.public_id,
                resource_type: result.resource_type,
                type: result.type,
                format: result.format,
                width: result.width,
                height: result.height,
                version: result.version,
                asset_id: result.asset_id,
                secure_url: result.secure_url,
              },
            },
            size: result.bytes,
            etag: result.etag ?? String(result.version),
            url: result.secure_url,
          });
        },
      );

      const sourceStream = input.source();
      sourceStream.on('error', (err) => {
        uploadStream.destroy(err);
        reject(classifyStorageError(err, 'Source stream failed during upload'));
      });
      sourceStream.pipe(uploadStream);
    });
  }

  async stat(ref: ProviderRef): Promise<StorageObjectStat | null> {
    const publicId =
      (ref.meta?.public_id as string) ?? this.computePublicId(ref.key).publicId;
    const resourceType = (ref.meta?.resource_type as string) ?? 'image';

    try {
      const res = (await this.cloudinaryInstance.api.resource(publicId, {
        resource_type: resourceType,
      })) as {
        bytes: number;
        etag?: string;
        version: number | string;
        format?: string;
      };

      return {
        size: res.bytes,
        etag: res.etag ?? String(res.version),
        contentType: res.format ? `image/${res.format}` : undefined,
      };
    } catch (err: unknown) {
      const classified = classifyStorageError(err);
      if (classified instanceof NotFoundError) {
        return null;
      }
      throw classified;
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getDirectUrl(
    ref: ProviderRef,
    opts?: DirectUrlOptions,
  ): Promise<string | null> {
    const publicId =
      (ref.meta?.public_id as string) ?? this.computePublicId(ref.key).publicId;
    const resourceType = (ref.meta?.resource_type as string) ?? 'image';

    const transformation: Record<string, unknown> = {
      fetch_format: opts?.transform?.format ?? 'auto',
      quality: opts?.transform?.quality ?? 'auto',
    };

    if (opts?.transform?.width) {
      transformation.width = opts.transform.width;
      transformation.crop = 'scale';
    }
    if (opts?.transform?.height) {
      transformation.height = opts.transform.height;
      transformation.crop = 'scale';
    }
    if (opts?.disposition === 'attachment') {
      transformation.flags = 'attachment';
    }

    const url = this.cloudinaryInstance.url(publicId, {
      resource_type: resourceType,
      secure: true,
      transformation: [transformation],
    });

    return url;
  }

  async downloadStream(
    ref: ProviderRef,
    opts?: ReadOptions,
  ): Promise<{ stream: Readable; size?: number; contentType?: string }> {
    const directUrl =
      (ref.meta?.secure_url as string) ??
      (await this.getDirectUrl(ref, { disposition: 'inline' }));

    if (!directUrl) {
      throw new NotFoundError(`Delivery URL not found for key: ${ref.key}`);
    }

    const headers: Record<string, string> = {};
    if (opts?.range) {
      const start = opts.range.start ?? 0;
      const end = opts.range.end !== undefined ? opts.range.end : '';
      headers.Range = `bytes=${start}-${end}`;
    }

    let response: Response;
    try {
      response = await fetch(directUrl, {
        headers,
        signal: opts?.signal,
      });
    } catch (err: unknown) {
      throw classifyStorageError(
        err,
        `Failed to download stream from ${directUrl}`,
      );
    }

    if (response.status === 404) {
      throw new NotFoundError(`Object not found at URL: ${directUrl}`);
    }

    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after');
      const retryAfterMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 1000;
      throw new RetryableError('Cloudinary rate limit exceeded', {
        status: 429,
        retryAfterMs,
      });
    }

    if (response.status >= 500) {
      throw new RetryableError(
        `Cloudinary CDN returned status ${response.status}`,
        {
          status: response.status,
        },
      );
    }

    if (!response.ok && response.status !== 206) {
      throw new PermanentError(
        `Cloudinary CDN returned status ${response.status}`,
        {
          status: response.status,
        },
      );
    }

    if (!response.body) {
      return { stream: Readable.from([]), size: 0 };
    }

    const stream = Readable.fromWeb(
      response.body as import('node:stream/web').ReadableStream,
    );
    const contentLength = response.headers.get('content-length');
    const size = contentLength ? parseInt(contentLength, 10) : undefined;
    const contentType = response.headers.get('content-type') ?? undefined;

    return { stream, size, contentType };
  }

  async delete(ref: ProviderRef): Promise<void> {
    const publicId =
      (ref.meta?.public_id as string) ?? this.computePublicId(ref.key).publicId;
    const resourceType = (ref.meta?.resource_type as string) ?? 'image';
    const type = (ref.meta?.type as string) ?? 'upload';

    try {
      const res = (await this.cloudinaryInstance.uploader.destroy(publicId, {
        resource_type: resourceType,
        type,
        invalidate: true,
      })) as { result?: string };

      // Treat 'not found' or 'ok' as successful idempotent deletion
      if (res && (res.result === 'ok' || res.result === 'not found')) {
        return;
      }
    } catch (err: unknown) {
      const classified = classifyStorageError(err);
      if (classified instanceof NotFoundError) {
        return;
      }
      throw classified;
    }
  }
}
