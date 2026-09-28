import type { Readable } from 'node:stream';

export type ProviderName = 'local' | 'seaweedfs' | 'cloudinary';

export type Visibility = 'private' | 'tenant' | 'public';

export interface ProviderRef {
  provider: ProviderName;
  key: string; // e.g. S3 object key, Cloudinary public_id, local relative path
  meta?: Record<string, unknown>; // e.g. cloudinary: { resource_type, type }
}

export interface StorageUploadInput {
  key: string; // from KeyService
  source: () => Readable; // factory: can be called again on retry
  size: number;
  sha256: string;
  mimetype: string;
  visibility: Visibility;
  tags?: string[];
  attributes?: Record<string, string>;
}

export interface DriverUploadResult {
  ref: ProviderRef;
  size: number;
  etag?: string;
  url?: string; // provider URL, internal use unless public CDN
}

export interface ReadOptions {
  range?: {
    start: number;
    end?: number;
  };
  signal?: AbortSignal;
}

export interface StorageObjectStat {
  size: number;
  etag?: string;
  contentType?: string;
}

export interface DirectUrlOptions {
  expiresInSeconds?: number;
  disposition?: 'inline' | 'attachment';
  transform?: {
    width?: number;
    height?: number;
    format?: 'auto' | 'webp' | 'jpg' | 'png';
    quality?: 'auto' | number;
  };
}

export interface DriverCapabilities {
  rangeReads: boolean;
  presignedUrls: boolean;
  publicCdn: boolean;
  imageTransforms: boolean;
  privateDelivery: boolean;
  maxObjectBytes?: number;
}

export interface DriverHealth {
  ok: boolean;
  latencyMs: number;
  detail?: string;
}

export interface ProviderObjectInfo {
  key: string;
  size: number;
  lastModified?: Date;
  etag?: string;
}

export interface IStorageDriver {
  readonly name: ProviderName;
  readonly capabilities: DriverCapabilities;
  isConfigured(): boolean;
  healthCheck(signal?: AbortSignal): Promise<DriverHealth>;
  upload(input: StorageUploadInput): Promise<DriverUploadResult>;
  downloadStream(
    ref: ProviderRef,
    opts?: ReadOptions,
  ): Promise<{ stream: Readable; size?: number; contentType?: string }>;
  stat(ref: ProviderRef): Promise<StorageObjectStat | null>;
  getDirectUrl(
    ref: ProviderRef,
    opts?: DirectUrlOptions,
  ): Promise<string | null>;
  delete(ref: ProviderRef): Promise<void>;
  list?(
    prefix: string,
    opts?: { cursor?: string; limit?: number },
  ): Promise<{ items: ProviderObjectInfo[]; nextCursor?: string }>;
}
