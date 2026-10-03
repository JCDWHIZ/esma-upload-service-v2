import { Injectable, type Provider as NestProvider } from '@nestjs/common';
import { Readable } from 'node:stream';
import { NotFoundError } from '../../src/core/errors/app-error.js';
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
} from '../../src/storage/types.js';

export interface StoragePutResult {
  key: string;
  size: number;
  etag?: string;
  url: string;
}

export const STORAGE_DRIVER_TOKEN = 'STORAGE_DRIVER';
export const CLOUDINARY_DRIVER_TOKEN = 'CLOUDINARY_DRIVER';

export interface StorageDriverCall {
  method: string;
  key?: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export interface StoredFakeFile {
  buffer: Buffer;
  mimetype: string;
  etag: string;
  lastModified: Date;
  visibility?: string;
  tags?: string[];
  attributes?: Record<string, string>;
}

@Injectable()
export class FakeStorageDriver implements IStorageDriver {
  public readonly name: ProviderName;
  public capabilities: DriverCapabilities = {
    rangeReads: true,
    presignedUrls: true,
    publicCdn: false,
    imageTransforms: false,
    privateDelivery: true,
    maxObjectBytes: 100 * 1024 * 1024,
  };

  private readonly files = new Map<string, StoredFakeFile>();
  private readonly calls: StorageDriverCall[] = [];
  private nextError?: Error;
  private nextErrorOp?: string;
  private latencyMs = 0;
  private configured = true;
  private healthy = true;
  private healthDetail?: string;

  public readonly bucketName: string;

  constructor(name: string = 'local') {
    this.bucketName = name;
    this.name = (
      ['local', 'seaweedfs', 'cloudinary'].includes(name) ? name : 'local'
    ) as ProviderName;
  }

  isConfigured(): boolean {
    return this.configured;
  }

  setConfigured(val: boolean): void {
    this.configured = val;
  }

  setHealth(ok: boolean, detail?: string): void {
    this.healthy = ok;
    this.healthDetail = detail;
  }

  setLatency(ms: number): void {
    this.latencyMs = ms;
  }

  setCapabilities(caps: Partial<DriverCapabilities>): void {
    this.capabilities = { ...this.capabilities, ...caps };
  }

  /**
   * Injects an error to be thrown on the very next operation,
   * or optionally targeted to a specific operation name.
   */
  failNext(opOrError: Error | string, error?: Error | string): void {
    if (error !== undefined) {
      this.nextErrorOp = typeof opOrError === 'string' ? opOrError : undefined;
      this.nextError = typeof error === 'string' ? new Error(error) : error;
    } else {
      this.nextErrorOp = undefined;
      this.nextError =
        typeof opOrError === 'string' ? new Error(opOrError) : opOrError;
    }
  }

  private async checkFailure(op: string): Promise<void> {
    if (this.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    }
    if (this.nextError) {
      if (!this.nextErrorOp || this.nextErrorOp === op) {
        const err = this.nextError;
        this.nextError = undefined;
        this.nextErrorOp = undefined;
        throw err;
      }
    }
  }

  async healthCheck(): Promise<DriverHealth> {
    await this.checkFailure('healthCheck');
    this.calls.push({ method: 'healthCheck', timestamp: new Date() });
    return {
      ok: this.healthy,
      latencyMs: this.latencyMs,
      detail: this.healthy
        ? undefined
        : (this.healthDetail ?? 'Simulated unhealthy state'),
    };
  }

  async upload(input: StorageUploadInput): Promise<DriverUploadResult> {
    if (
      this.nextError &&
      (!this.nextErrorOp || this.nextErrorOp === 'upload')
    ) {
      const sourceStream = input.source();
      const maybeDestroyable = sourceStream as unknown as {
        destroy?: (err?: Error) => void;
        on?: (event: string, cb: () => void) => void;
      };
      if (typeof maybeDestroyable.destroy === 'function') {
        if (typeof maybeDestroyable.on === 'function') {
          maybeDestroyable.on('error', () => {});
        }
        maybeDestroyable.destroy();
      }
      const err = this.nextError;
      this.nextError = undefined;
      this.nextErrorOp = undefined;
      throw err;
    }

    if (this.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    }

    const stream = input.source();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      if (Buffer.isBuffer(chunk)) {
        chunks.push(chunk);
      } else if (typeof chunk === 'string') {
        chunks.push(Buffer.from(chunk, 'utf8'));
      } else {
        chunks.push(Buffer.from(chunk as unknown as Uint8Array));
      }
    }
    const buffer = Buffer.concat(chunks);
    const etag = `etag-${input.key}`;

    this.files.set(input.key, {
      buffer,
      mimetype: input.mimetype,
      etag,
      lastModified: new Date(),
      visibility: input.visibility,
      tags: input.tags,
      attributes: input.attributes,
    });

    this.calls.push({
      method: 'upload',
      key: input.key,
      timestamp: new Date(),
      metadata: { size: buffer.length, mimetype: input.mimetype },
    });

    const isDirectAvailable =
      this.capabilities.publicCdn || this.capabilities.presignedUrls;

    return {
      ref: {
        provider: this.name,
        key: input.key,
      },
      size: buffer.length,
      etag,
      url: isDirectAvailable
        ? `https://${this.name}.example.com/${input.key}`
        : undefined,
    };
  }

  async downloadStream(
    ref: ProviderRef,
    opts?: ReadOptions,
  ): Promise<{ stream: Readable; size?: number; contentType?: string }> {
    await this.checkFailure('downloadStream');
    this.calls.push({
      method: 'downloadStream',
      key: ref.key,
      timestamp: new Date(),
    });

    const stored = this.files.get(ref.key);
    if (!stored) {
      throw new NotFoundError(`File not found: ${ref.key}`);
    }

    if (opts?.range) {
      const start = Math.max(0, opts.range.start ?? 0);
      const end =
        opts.range.end !== undefined
          ? Math.min(stored.buffer.length, opts.range.end + 1)
          : stored.buffer.length;
      const slice = stored.buffer.subarray(start, end);
      return {
        stream: Readable.from(slice),
        size: slice.length,
        contentType: stored.mimetype,
      };
    }

    return {
      stream: Readable.from(stored.buffer),
      size: stored.buffer.length,
      contentType: stored.mimetype,
    };
  }

  async stat(ref: ProviderRef): Promise<StorageObjectStat | null> {
    await this.checkFailure('stat');
    this.calls.push({ method: 'stat', key: ref.key, timestamp: new Date() });

    const stored = this.files.get(ref.key);
    if (!stored) {
      return null;
    }

    return {
      size: stored.buffer.length,
      etag: stored.etag,
      contentType: stored.mimetype,
    };
  }

  async getDirectUrl(
    ref: ProviderRef,
    opts?: DirectUrlOptions,
  ): Promise<string | null> {
    await this.checkFailure('getDirectUrl');
    this.calls.push({
      method: 'getDirectUrl',
      key: ref.key,
      timestamp: new Date(),
    });

    if (!this.capabilities.publicCdn && !this.capabilities.presignedUrls) {
      return null;
    }

    let url = `https://${this.name}.example.com/${ref.key}`;
    const params: string[] = [];
    if (opts?.disposition) {
      params.push(
        `response-content-disposition=${encodeURIComponent(opts.disposition)}`,
      );
    }
    if (opts?.transform?.width) {
      params.push(`w=${opts.transform.width}`);
    }
    if (opts?.transform?.height) {
      params.push(`h=${opts.transform.height}`);
    }
    if (opts?.transform?.format) {
      params.push(`f=${opts.transform.format}`);
    }
    if (params.length > 0) {
      url += `?${params.join('&')}`;
    }

    return url;
  }

  delete(ref: ProviderRef): Promise<void>;
  delete(key: string): Promise<boolean>;
  async delete(refOrKey: ProviderRef | string): Promise<void | boolean> {
    await this.checkFailure('delete');
    const key = typeof refOrKey === 'string' ? refOrKey : refOrKey.key;
    this.calls.push({ method: 'delete', key, timestamp: new Date() });

    const exists = this.files.has(key);
    this.files.delete(key);

    if (typeof refOrKey === 'string') {
      return exists;
    }
  }

  async list(
    prefix: string,
    opts?: { cursor?: string; limit?: number },
  ): Promise<{ items: ProviderObjectInfo[]; nextCursor?: string }> {
    await this.checkFailure('list');
    this.calls.push({ method: 'list', key: prefix, timestamp: new Date() });

    const matching: ProviderObjectInfo[] = [];
    for (const [key, val] of this.files.entries()) {
      if (key.startsWith(prefix)) {
        matching.push({
          key,
          size: val.buffer.length,
          lastModified: val.lastModified,
          etag: val.etag,
        });
      }
    }

    matching.sort((a, b) => a.key.localeCompare(b.key));
    const limit = opts?.limit ?? matching.length;
    const startIndex = opts?.cursor
      ? matching.findIndex((item) => item.key > (opts.cursor as string))
      : 0;

    const actualStart = startIndex === -1 ? matching.length : startIndex;
    const items = matching.slice(actualStart, actualStart + limit);
    const nextCursor =
      actualStart + limit < matching.length
        ? items[items.length - 1]?.key
        : undefined;

    return { items, nextCursor };
  }

  // --- Backwards Compatibility Methods for Existing Tests ---

  async put(
    key: string,
    data: Buffer | NodeJS.ReadableStream,
    metadata?: Record<string, unknown>,
  ): Promise<StoragePutResult> {
    if (this.nextError) {
      const maybeDestroyable = data as unknown as {
        destroy?: (err?: Error) => void;
        on?: (event: string, cb: () => void) => void;
      };
      if (typeof maybeDestroyable.destroy === 'function') {
        if (typeof maybeDestroyable.on === 'function') {
          maybeDestroyable.on('error', () => {});
        }
        maybeDestroyable.destroy();
      }
      const err = this.nextError;
      this.nextError = undefined;
      this.nextErrorOp = undefined;
      throw err;
    }

    let buffer: Buffer;
    if (Buffer.isBuffer(data)) {
      buffer = data;
    } else {
      const chunks: Buffer[] = [];
      for await (const chunk of data) {
        if (Buffer.isBuffer(chunk)) {
          chunks.push(chunk);
        } else if (typeof chunk === 'string') {
          chunks.push(Buffer.from(chunk, 'utf8'));
        } else {
          chunks.push(Buffer.from(chunk as unknown as Uint8Array));
        }
      }
      buffer = Buffer.concat(chunks);
    }

    const etag = `etag-${key}`;
    this.files.set(key, {
      buffer,
      mimetype: (metadata?.contentType as string) || 'application/octet-stream',
      etag,
      lastModified: new Date(),
    });

    this.calls.push({
      method: 'put',
      key,
      timestamp: new Date(),
      metadata,
    });

    return {
      key,
      size: buffer.length,
      etag,
      url: `https://${this.bucketName}.example.com/${key}`,
    };
  }

  async get(key: string): Promise<Buffer> {
    await this.checkFailure('get');
    this.calls.push({ method: 'get', key, timestamp: new Date() });
    const file = this.files.get(key);
    if (!file) {
      throw new Error(`File not found: ${key}`);
    }
    return file.buffer;
  }

  openStream(key: string): NodeJS.ReadableStream {
    if (this.nextError) {
      const err = this.nextError;
      this.nextError = undefined;
      this.nextErrorOp = undefined;
      throw err;
    }
    this.calls.push({ method: 'openStream', key, timestamp: new Date() });
    const file = this.files.get(key);
    if (!file) {
      throw new Error(`File not found: ${key}`);
    }
    return Readable.from(file.buffer);
  }

  async exists(key: string): Promise<boolean> {
    await this.checkFailure('exists');
    this.calls.push({ method: 'exists', key, timestamp: new Date() });
    return this.files.has(key);
  }

  async getUrl(key: string): Promise<string> {
    await this.checkFailure('getUrl');
    this.calls.push({ method: 'getUrl', key, timestamp: new Date() });
    return `https://${this.bucketName}.example.com/${key}`;
  }

  hasFile(key: string): boolean {
    return this.files.has(key);
  }

  getFile(key: string): Buffer | undefined {
    return this.files.get(key)?.buffer;
  }

  getFiles(): Map<string, Buffer> {
    const map = new Map<string, Buffer>();
    for (const [k, v] of this.files.entries()) {
      map.set(k, v.buffer);
    }
    return map;
  }

  getCalls(): readonly StorageDriverCall[] {
    return this.calls;
  }

  clear(): void {
    this.files.clear();
    this.calls.length = 0;
    this.nextError = undefined;
    this.nextErrorOp = undefined;
    this.latencyMs = 0;
    this.configured = true;
    this.healthy = true;
    this.healthDetail = undefined;
  }

  reset(): void {
    this.clear();
  }
}

export function createFakeStorageProvider(
  driver = new FakeStorageDriver('storage'),
): NestProvider {
  return {
    provide: STORAGE_DRIVER_TOKEN,
    useValue: driver,
  };
}

export function createFakeCloudinaryProvider(
  driver = new FakeStorageDriver('cloudinary'),
): NestProvider {
  return {
    provide: CLOUDINARY_DRIVER_TOKEN,
    useValue: driver,
  };
}
