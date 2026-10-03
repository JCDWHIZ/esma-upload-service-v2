import { Readable } from 'node:stream';
import path from 'node:path';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Upload } from '@aws-sdk/lib-storage';
import { NotFoundError } from '../../core/errors/app-error.js';
import { classifyStorageError } from '../errors.js';
import type {
  DirectUrlOptions,
  DriverCapabilities,
  DriverHealth,
  DriverUploadResult,
  IStorageDriver,
  ProviderName,
  ProviderObjectInfo,
  ProviderRef,
  ReadOptions,
  StorageObjectStat,
  StorageUploadInput,
} from '../types.js';

export interface SeaweedFSConfig {
  endpoint: string;
  publicEndpoint?: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  autoCreateBucket?: boolean;
  forcePathStyle?: boolean;
  allowInternalPresignedUrls?: boolean;
}

const MULTIPART_THRESHOLD_BYTES = 100 * 1024 * 1024; // 100 MiB

export class SeaweedFSStorageDriver implements IStorageDriver {
  readonly name: ProviderName = 'seaweedfs';
  readonly capabilities: DriverCapabilities;

  readonly endpoint: string;
  readonly publicEndpoint?: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
  readonly autoCreateBucket: boolean;
  readonly forcePathStyle: boolean;

  readonly s3Client: S3Client;

  constructor(config: SeaweedFSConfig, customS3Client?: S3Client) {
    this.endpoint = config.endpoint;
    this.publicEndpoint = config.publicEndpoint;
    this.bucket = config.bucket;
    this.accessKeyId = config.accessKeyId;
    this.secretAccessKey = config.secretAccessKey;
    this.region = config.region ?? 'us-east-1';
    this.autoCreateBucket = config.autoCreateBucket ?? false;
    this.forcePathStyle = config.forcePathStyle ?? true;

    const hasPublicUrl = Boolean(
      (this.publicEndpoint && this.publicEndpoint.trim().length > 0) ||
      config.allowInternalPresignedUrls,
    );

    this.capabilities = {
      rangeReads: true,
      presignedUrls: hasPublicUrl,
      publicCdn: false,
      imageTransforms: false,
      privateDelivery: true,
      maxObjectBytes: undefined,
    };

    if (customS3Client) {
      this.s3Client = customS3Client;
    } else {
      const clientConfig: S3ClientConfig = {
        endpoint: this.endpoint,
        region: this.region,
        forcePathStyle: this.forcePathStyle,
        credentials: {
          accessKeyId: this.accessKeyId,
          secretAccessKey: this.secretAccessKey,
        },
        maxAttempts: 1, // Retries are handled by consumer / caller framework
      };
      this.s3Client = new S3Client(clientConfig);
    }
  }

  isConfigured(): boolean {
    return Boolean(
      this.endpoint &&
      this.endpoint.trim().length > 0 &&
      this.bucket &&
      this.bucket.trim().length > 0 &&
      this.accessKeyId &&
      this.accessKeyId.trim().length > 0 &&
      this.secretAccessKey &&
      this.secretAccessKey.trim().length > 0,
    );
  }

  setCapabilities(overrides: Partial<DriverCapabilities>): void {
    Object.assign(this.capabilities, overrides);
  }

  async upload(input: StorageUploadInput): Promise<DriverUploadResult> {
    try {
      const metadata: Record<string, string> = {
        sha256: input.sha256,
      };
      if (input.attributes) {
        for (const [k, v] of Object.entries(input.attributes)) {
          metadata[k] = v;
        }
      }

      let etag: string | undefined;
      let versionId: string | undefined;

      if (input.size > MULTIPART_THRESHOLD_BYTES) {
        const upload = new Upload({
          client: this.s3Client,
          params: {
            Bucket: this.bucket,
            Key: input.key,
            Body: input.source(),
            ContentType: input.mimetype,
            Metadata: metadata,
          },
          queueSize: 4,
          partSize: 10 * 1024 * 1024, // 10 MiB parts
          leavePartsOnError: false,
        });

        const output = await upload.done();
        etag = output.ETag?.replace(/"/g, '');
        versionId = output.VersionId;
      } else {
        const checksumSha256 = input.sha256
          ? Buffer.from(input.sha256, 'hex').toString('base64')
          : undefined;

        const output = await this.s3Client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: input.key,
            Body: input.source(),
            ContentLength: input.size,
            ContentType: input.mimetype,
            Metadata: metadata,
            ChecksumSHA256: checksumSha256,
          }),
        );

        etag = output.ETag?.replace(/"/g, '');
        versionId = output.VersionId;
      }

      const ref: ProviderRef = {
        provider: this.name,
        key: input.key,
        meta: {
          bucket: this.bucket,
          etag,
          versionId,
        },
      };

      const directUrl = this.capabilities.presignedUrls
        ? await this.getDirectUrl(ref)
        : undefined;

      return {
        ref,
        size: input.size,
        etag,
        url: directUrl ?? undefined,
      };
    } catch (err: unknown) {
      throw classifyStorageError(err, `Failed to upload object: ${input.key}`);
    }
  }

  async downloadStream(
    ref: ProviderRef,
    opts?: ReadOptions,
  ): Promise<{ stream: Readable; size?: number; contentType?: string }> {
    try {
      const commandInput: {
        Bucket: string;
        Key: string;
        Range?: string;
      } = {
        Bucket: this.bucket,
        Key: ref.key,
      };

      if (opts?.range) {
        const start = opts.range.start ?? 0;
        const end = opts.range.end !== undefined ? opts.range.end : '';
        commandInput.Range = `bytes=${start}-${end}`;
      }

      const res = await this.s3Client.send(new GetObjectCommand(commandInput), {
        abortSignal: opts?.signal,
      });

      let stream: Readable;
      if (res.Body instanceof Readable) {
        stream = res.Body;
      } else if (
        res.Body &&
        typeof (res.Body as { pipe?: unknown }).pipe === 'function'
      ) {
        stream = res.Body as unknown as Readable;
      } else if (
        res.Body &&
        typeof (
          res.Body as { transformToByteArray?: () => Promise<Uint8Array> }
        ).transformToByteArray === 'function'
      ) {
        const bytes = await (
          res.Body as { transformToByteArray: () => Promise<Uint8Array> }
        ).transformToByteArray();
        stream = Readable.from(Buffer.from(bytes));
      } else if (
        res.Body &&
        typeof (res.Body as { transformToWebStream?: () => unknown })
          .transformToWebStream === 'function'
      ) {
        stream = Readable.fromWeb(
          (
            res.Body as { transformToWebStream: () => unknown }
          ).transformToWebStream() as Parameters<typeof Readable.fromWeb>[0],
        );
      } else {
        throw new NotFoundError(`Empty body returned for S3 key: ${ref.key}`);
      }

      return {
        stream,
        size: res.ContentLength,
        contentType: res.ContentType,
      };
    } catch (err: unknown) {
      throw classifyStorageError(
        err,
        `Failed to download stream for key: ${ref.key}`,
      );
    }
  }

  async stat(ref: ProviderRef): Promise<StorageObjectStat | null> {
    try {
      const res = await this.s3Client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: ref.key,
        }),
      );

      return {
        size: res.ContentLength ?? 0,
        etag: res.ETag?.replace(/"/g, ''),
        contentType: res.ContentType,
      };
    } catch (err: unknown) {
      const classified = classifyStorageError(err);
      if (classified instanceof NotFoundError) {
        return null;
      }
      throw classified;
    }
  }

  async delete(ref: ProviderRef): Promise<void> {
    try {
      await this.s3Client.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: ref.key,
        }),
      );
    } catch (err: unknown) {
      const classified = classifyStorageError(err);
      if (classified instanceof NotFoundError) {
        return;
      }
      throw classified;
    }
  }

  async getDirectUrl(
    ref: ProviderRef,
    opts?: DirectUrlOptions,
  ): Promise<string | null> {
    if (!this.capabilities.presignedUrls) {
      return null;
    }

    try {
      const filename = path.posix.basename(ref.key);
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: ref.key,
        ResponseContentDisposition:
          opts?.disposition === 'attachment'
            ? `attachment; filename="${filename}"`
            : undefined,
      });

      const expiresIn = opts?.expiresInSeconds ?? 900;
      const presigned = await getSignedUrl(this.s3Client, command, {
        expiresIn,
      });

      if (this.publicEndpoint && this.publicEndpoint.trim().length > 0) {
        const parsed = new URL(presigned);
        const publicBase = new URL(this.publicEndpoint);
        parsed.protocol = publicBase.protocol;
        parsed.host = publicBase.host;
        parsed.port = publicBase.port;
        return parsed.toString();
      }

      return presigned;
    } catch (err: unknown) {
      throw classifyStorageError(
        err,
        `Failed to generate presigned URL for key: ${ref.key}`,
      );
    }
  }

  async getPresignedUploadUrl(
    key: string,
    mimetype: string,
    expiresInSeconds = 900,
  ): Promise<{ uploadUrl: string; requiredHeaders: Record<string, string> }> {
    try {
      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: mimetype,
      });

      const presigned = await getSignedUrl(this.s3Client, command, {
        expiresIn: expiresInSeconds,
      });

      let uploadUrl = presigned;
      if (this.publicEndpoint && this.publicEndpoint.trim().length > 0) {
        const parsed = new URL(presigned);
        const publicBase = new URL(this.publicEndpoint);
        parsed.protocol = publicBase.protocol;
        parsed.host = publicBase.host;
        parsed.port = publicBase.port;
        uploadUrl = parsed.toString();
      }

      return {
        uploadUrl,
        requiredHeaders: {
          'Content-Type': mimetype,
        },
      };
    } catch (err: unknown) {
      throw classifyStorageError(
        err,
        `Failed to generate presigned upload URL for key: ${key}`,
      );
    }
  }

  async list(
    prefix: string,
    opts?: { cursor?: string; limit?: number },
  ): Promise<{ items: ProviderObjectInfo[]; nextCursor?: string }> {
    try {
      const res = await this.s3Client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: opts?.cursor,
          MaxKeys: opts?.limit ?? 1000,
        }),
      );

      const items: ProviderObjectInfo[] = (res.Contents ?? [])
        .filter((obj) => obj.Key !== undefined)
        .map((obj) => ({
          key: obj.Key!,
          size: obj.Size ?? 0,
          lastModified: obj.LastModified,
          etag: obj.ETag?.replace(/"/g, ''),
        }));

      return {
        items,
        nextCursor: res.NextContinuationToken,
      };
    } catch (err: unknown) {
      throw classifyStorageError(
        err,
        `Failed to list objects with prefix: ${prefix}`,
      );
    }
  }

  async healthCheck(signal?: AbortSignal): Promise<DriverHealth> {
    const start = Date.now();
    try {
      if (signal?.aborted) {
        throw new Error('Health check aborted');
      }

      await this.s3Client.send(
        new HeadBucketCommand({
          Bucket: this.bucket,
        }),
        { abortSignal: signal },
      );

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

  async ensureBucket(): Promise<void> {
    try {
      await this.s3Client.send(
        new HeadBucketCommand({
          Bucket: this.bucket,
        }),
      );
    } catch (err: unknown) {
      const classified = classifyStorageError(err);
      if (classified instanceof NotFoundError && this.autoCreateBucket) {
        await this.s3Client.send(
          new CreateBucketCommand({
            Bucket: this.bucket,
          }),
        );
        return;
      }
      throw classified;
    }
  }
}
