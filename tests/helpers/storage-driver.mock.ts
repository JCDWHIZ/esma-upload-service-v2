import { Injectable, type Provider } from '@nestjs/common';
import { Readable } from 'node:stream';

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
  key: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class FakeStorageDriver {
  public readonly name: string;
  private readonly files = new Map<string, Buffer>();
  private readonly calls: StorageDriverCall[] = [];
  private nextError?: Error;

  constructor(name = 'fake-storage') {
    this.name = name;
  }

  /**
   * Injects an error to be thrown on the very next operation.
   */
  failNext(error: Error | string): void {
    this.nextError = typeof error === 'string' ? new Error(error) : error;
  }

  private checkFailure(): void {
    if (this.nextError) {
      const err = this.nextError;
      this.nextError = undefined;
      throw err;
    }
  }

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

    this.files.set(key, buffer);
    this.calls.push({
      method: 'put',
      key,
      timestamp: new Date(),
      metadata,
    });

    return {
      key,
      size: buffer.length,
      etag: `etag-${key}`,
      url: `https://${this.name}.example.com/${key}`,
    };
  }

  async get(key: string): Promise<Buffer> {
    await Promise.resolve();
    this.checkFailure();
    this.calls.push({ method: 'get', key, timestamp: new Date() });
    const file = this.files.get(key);
    if (!file) {
      throw new Error(`File not found: ${key}`);
    }
    return file;
  }

  openStream(key: string): NodeJS.ReadableStream {
    this.checkFailure();
    this.calls.push({ method: 'openStream', key, timestamp: new Date() });
    const file = this.files.get(key);
    if (!file) {
      throw new Error(`File not found: ${key}`);
    }
    return Readable.from(file);
  }

  async delete(key: string): Promise<boolean> {
    await Promise.resolve();
    this.checkFailure();
    this.calls.push({ method: 'delete', key, timestamp: new Date() });
    return this.files.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    await Promise.resolve();
    this.checkFailure();
    this.calls.push({ method: 'exists', key, timestamp: new Date() });
    return this.files.has(key);
  }

  async getUrl(key: string): Promise<string> {
    await Promise.resolve();
    this.checkFailure();
    this.calls.push({ method: 'getUrl', key, timestamp: new Date() });
    return `https://${this.name}.example.com/${key}`;
  }

  // Inspection helpers
  hasFile(key: string): boolean {
    return this.files.has(key);
  }

  getFile(key: string): Buffer | undefined {
    return this.files.get(key);
  }

  getFiles(): Map<string, Buffer> {
    return new Map(this.files);
  }

  getCalls(): readonly StorageDriverCall[] {
    return this.calls;
  }

  clear(): void {
    this.files.clear();
    this.calls.length = 0;
    this.nextError = undefined;
  }
}

/**
 * Creates a Nest provider definition for FakeStorageDriver to be used with
 * module.overrideProvider(STORAGE_DRIVER_TOKEN).useValue(fakeDriver)
 */
export function createFakeStorageProvider(
  driver = new FakeStorageDriver('storage'),
): Provider {
  return {
    provide: STORAGE_DRIVER_TOKEN,
    useValue: driver,
  };
}

/**
 * Creates a Nest provider definition for fakeCloudinary to be used with
 * module.overrideProvider(CLOUDINARY_DRIVER_TOKEN).useValue(fakeDriver)
 */
export function createFakeCloudinaryProvider(
  driver = new FakeStorageDriver('cloudinary'),
): Provider {
  return {
    provide: CLOUDINARY_DRIVER_TOKEN,
    useValue: driver,
  };
}
