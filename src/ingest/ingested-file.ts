import * as fs from 'node:fs';
import { Readable } from 'node:stream';
import { IngestedFile } from './types.js';

export interface IngestedFileOptions {
  fieldName: string;
  originalName: string;
  declaredMime: string;
  detectedMime: string;
  size: number;
  sha256: string;
  path: string;
  onDisposed?: (filePath: string) => void;
}

export class IngestedFileImpl implements IngestedFile {
  readonly fieldName: string;
  readonly originalName: string;
  readonly declaredMime: string;
  readonly detectedMime: string;
  readonly size: number;
  readonly sha256: string;
  readonly path: string;
  private isDisposed = false;
  private readonly onDisposed?: (filePath: string) => void;

  constructor(options: IngestedFileOptions) {
    this.fieldName = options.fieldName;
    this.originalName = options.originalName;
    this.declaredMime = options.declaredMime;
    this.detectedMime = options.detectedMime;
    this.size = options.size;
    this.sha256 = options.sha256;
    this.path = options.path;
    this.onDisposed = options.onDisposed;
  }

  /**
   * Opens a new readable stream for reading the staged file from disk.
   * Can be invoked repeatedly across retries and replication targets.
   */
  openReadStream(): Readable {
    if (this.isDisposed) {
      throw new Error(
        `Cannot open read stream: staged file has already been disposed (${this.path})`,
      );
    }
    return fs.createReadStream(this.path);
  }

  /**
   * Idempotently removes the staged file from disk.
   */
  async dispose(): Promise<void> {
    if (this.isDisposed) {
      return;
    }
    this.isDisposed = true;
    try {
      await fs.promises.unlink(this.path);
    } catch (err: unknown) {
      // Ignore if file was already removed
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    } finally {
      this.onDisposed?.(this.path);
    }
  }
}
