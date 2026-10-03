import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Injectable, Optional } from '@nestjs/common';
import { AppConfigService } from '../../config/config.service.js';
import { NotFoundError, ValidationError } from '../../core/errors/app-error.js';
import { resolveInside } from '../../core/storage-key.service.js';
import { classifyStorageError } from '../errors.js';
import type {
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

export interface LocalStorageDriverOptions {
  rootPath: string;
  stagingDir?: string;
}

function checkPathOverlap(pathA: string, pathB: string): boolean {
  const normA = path.resolve(pathA);
  const normB = path.resolve(pathB);
  if (normA === normB) return true;
  const relAtoB = path.relative(normA, normB);
  if (!relAtoB.startsWith('..') && !path.isAbsolute(relAtoB)) return true;
  const relBtoA = path.relative(normB, normA);
  if (!relBtoA.startsWith('..') && !path.isAbsolute(relBtoA)) return true;
  return false;
}

@Injectable()
export class LocalStorageDriver implements IStorageDriver {
  public readonly name: ProviderName = 'local';
  public readonly capabilities: DriverCapabilities = {
    rangeReads: true,
    presignedUrls: false,
    publicCdn: false,
    imageTransforms: false,
    privateDelivery: false,
    maxObjectBytes: undefined,
  };

  public readonly rootPath: string;
  private readonly stagingDir?: string;

  constructor(
    @Optional() configOrOptions?: LocalStorageDriverOptions | AppConfigService,
  ) {
    let rawPath: string;
    if (configOrOptions instanceof AppConfigService) {
      const cfg = configOrOptions.get();
      rawPath = cfg.LOCAL_STORAGE_PATH;
      this.stagingDir = cfg.STAGING_DIR
        ? path.resolve(cfg.STAGING_DIR)
        : undefined;
    } else if (configOrOptions && typeof configOrOptions === 'object') {
      rawPath = configOrOptions.rootPath;
      this.stagingDir = configOrOptions.stagingDir
        ? path.resolve(configOrOptions.stagingDir)
        : undefined;
    } else {
      rawPath = process.env.LOCAL_STORAGE_PATH || 'data/storage';
      this.stagingDir = process.env.STAGING_DIR
        ? path.resolve(process.env.STAGING_DIR)
        : undefined;
    }

    this.rootPath =
      rawPath && rawPath.trim().length > 0 ? path.resolve(rawPath) : '';

    // Startup check: Refuse root inside staging directory or vice-versa
    if (
      this.rootPath &&
      this.stagingDir &&
      checkPathOverlap(this.rootPath, this.stagingDir)
    ) {
      throw new ValidationError(
        `LocalStorageDriver rootPath ('${this.rootPath}') and staging directory ('${this.stagingDir}') must not overlap`,
      );
    }
  }

  isConfigured(): boolean {
    return Boolean(this.rootPath && this.rootPath.trim().length > 0);
  }

  async healthCheck(signal?: AbortSignal): Promise<DriverHealth> {
    const start = Date.now();
    const probeKey = `.health-check-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.tmp`;
    const probePath = path.join(this.rootPath, probeKey);

    try {
      if (signal?.aborted) {
        throw new Error('Health check aborted');
      }

      await fs.promises.mkdir(this.rootPath, { recursive: true, mode: 0o750 });
      const content = Buffer.from('local-health-probe');
      await fs.promises.writeFile(probePath, content, { mode: 0o640 });
      const read = await fs.promises.readFile(probePath);

      if (!read.equals(content)) {
        throw new Error('Health check read mismatch');
      }

      await fs.promises.unlink(probePath);

      return {
        ok: true,
        latencyMs: Date.now() - start,
      };
    } catch (err: unknown) {
      await fs.promises.unlink(probePath).catch(() => {});
      return {
        ok: false,
        latencyMs: Date.now() - start,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async upload(input: StorageUploadInput): Promise<DriverUploadResult> {
    // 1. Path safety check: throws ValidationError immediately on hostile key
    const targetPath = resolveInside(this.rootPath, input.key);
    const targetDir = path.dirname(targetPath);
    const targetFileName = path.basename(targetPath);

    // Ensure directory exists with mode 0750
    await fs.promises.mkdir(targetDir, { recursive: true, mode: 0o750 });

    // 2. Atomic write: stream to temp file in the same directory (.name.<rand>.tmp)
    const randHex = crypto.randomBytes(8).toString('hex');
    const tempPath = path.join(targetDir, `.${targetFileName}.${randHex}.tmp`);

    let bytesWritten = 0;
    const hash = crypto.createHash('sha256');

    try {
      const writeStream = fs.createWriteStream(tempPath, { mode: 0o640 });

      const trackingTransform = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytesWritten += chunk.length;
          hash.update(chunk);
          callback(null, chunk);
        },
      });

      const sourceStream = input.source();
      await pipeline(sourceStream, trackingTransform, writeStream);

      // Verify written size
      if (input.size !== undefined && input.size !== bytesWritten) {
        throw new ValidationError(
          `Uploaded file size mismatch: declared ${input.size}, wrote ${bytesWritten}`,
        );
      }

      // Verify SHA-256 if supplied
      const computedSha256 = hash.digest('hex');
      if (
        input.sha256 &&
        input.sha256.toLowerCase() !== computedSha256.toLowerCase()
      ) {
        throw new ValidationError(
          `Uploaded file checksum mismatch: declared ${input.sha256}, computed ${computedSha256}`,
        );
      }

      // fsync file descriptor to guarantee physical durability on disk
      const fd = await fs.promises.open(tempPath, 'r+');
      try {
        await fd.sync();
      } finally {
        await fd.close();
      }

      // Atomic rename: guarantees no partial final file ever exists
      await fs.promises.rename(tempPath, targetPath);

      return {
        ref: {
          provider: this.name,
          key: input.key,
        },
        size: bytesWritten,
        etag: computedSha256,
      };
    } catch (err: unknown) {
      await fs.promises.unlink(tempPath).catch(() => {});

      if (err instanceof ValidationError) {
        throw err;
      }
      throw classifyStorageError(err, 'Failed to write local storage file');
    }
  }

  async downloadStream(
    ref: ProviderRef,
    opts?: ReadOptions,
  ): Promise<{ stream: Readable; size?: number; contentType?: string }> {
    const filePath = resolveInside(this.rootPath, ref.key);

    let fileStat: fs.Stats;
    try {
      fileStat = await fs.promises.stat(filePath);
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') {
        throw new NotFoundError(`File not found: ${ref.key}`);
      }
      throw classifyStorageError(err);
    }

    if (opts?.range) {
      const start = Math.max(0, opts.range.start ?? 0);
      const end =
        opts.range.end !== undefined
          ? Math.min(fileStat.size - 1, opts.range.end)
          : fileStat.size - 1;

      if (start > end || start >= fileStat.size) {
        return { stream: Readable.from([]), size: 0 };
      }

      const stream = fs.createReadStream(filePath, {
        start,
        end,
        signal: opts.signal,
      });

      return {
        stream,
        size: end - start + 1,
      };
    }

    const stream = fs.createReadStream(filePath, { signal: opts?.signal });
    return {
      stream,
      size: fileStat.size,
    };
  }

  async stat(ref: ProviderRef): Promise<StorageObjectStat | null> {
    const filePath = resolveInside(this.rootPath, ref.key);

    try {
      const fileStat = await fs.promises.stat(filePath);
      return {
        size: fileStat.size,
      };
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') {
        return null;
      }
      throw classifyStorageError(err);
    }
  }

  getDirectUrl(): Promise<string | null> {
    // Local driver never serves direct public URLs
    return Promise.resolve(null);
  }

  async delete(ref: ProviderRef): Promise<void> {
    const filePath = resolveInside(this.rootPath, ref.key);

    try {
      await fs.promises.unlink(filePath);
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code !== 'ENOENT') {
        throw classifyStorageError(err);
      }
    }

    // Remove empty parent directories up to rootPath
    await this.cleanupEmptyDirectories(path.dirname(filePath));
  }

  private async cleanupEmptyDirectories(dirPath: string): Promise<void> {
    const resolvedRoot = path.resolve(this.rootPath);
    let current = path.resolve(dirPath);

    while (
      current !== resolvedRoot &&
      current.startsWith(resolvedRoot + path.sep)
    ) {
      try {
        const entries = await fs.promises.readdir(current);
        if (entries.length === 0) {
          await fs.promises.rmdir(current);
          current = path.dirname(current);
        } else {
          break;
        }
      } catch {
        break;
      }
    }
  }

  async list(
    prefix: string,
    opts?: { cursor?: string; limit?: number },
  ): Promise<{ items: ProviderObjectInfo[]; nextCursor?: string }> {
    const items: ProviderObjectInfo[] = [];

    const exists = await fs.promises
      .stat(this.rootPath)
      .then((s) => s.isDirectory())
      .catch(() => false);

    if (!exists) {
      return { items: [] };
    }

    await this.collectFiles(this.rootPath, '', prefix, items);
    items.sort((a, b) => a.key.localeCompare(b.key));

    const limit = opts?.limit ?? items.length;
    const startIndex = opts?.cursor
      ? items.findIndex((item) => item.key > opts.cursor!)
      : 0;

    const actualStart = startIndex === -1 ? items.length : startIndex;
    const paginated = items.slice(actualStart, actualStart + limit);
    const nextCursor =
      actualStart + limit < items.length
        ? paginated[paginated.length - 1]?.key
        : undefined;

    return { items: paginated, nextCursor };
  }

  private async collectFiles(
    dir: string,
    currentRel: string,
    prefix: string,
    out: ProviderObjectInfo[],
  ): Promise<void> {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      // Skip temp files
      if (entry.name.startsWith('.')) continue;

      const subRel = currentRel ? `${currentRel}/${entry.name}` : entry.name;
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await this.collectFiles(fullPath, subRel, prefix, out);
      } else if (entry.isFile()) {
        if (!prefix || subRel.startsWith(prefix)) {
          const stat = await fs.promises.stat(fullPath);
          out.push({
            key: subRel.replace(/\\/g, '/'),
            size: stat.size,
            lastModified: stat.mtime,
          });
        }
      }
    }
  }
}
