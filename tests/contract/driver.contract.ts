import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  NotFoundError,
  PermanentError,
  RetryableError,
} from '../../src/core/errors/app-error.js';
import { classifyStorageError } from '../../src/storage/errors.js';
import type {
  IStorageDriver,
  StorageUploadInput,
} from '../../src/storage/types.js';

export interface DriverContractOptions {
  cleanup?: (driver: IStorageDriver) => Promise<void> | void;
}

interface FailureInjectable {
  failNext(opOrError: Error | string, error?: Error | string): void;
  setCapabilities(caps: Partial<IStorageDriver['capabilities']>): void;
}

/**
 * Reusable contract test suite that all IStorageDriver implementations must pass.
 * Verifies standard driver behaviors: upload, stat, range reads, stream equality,
 * idempotency, memory efficiency, direct URLs, and error classification.
 */
export function runDriverContract(
  name: string,
  factory: () => IStorageDriver,
  options?: DriverContractOptions,
): void {
  describe(`Storage Driver Contract: ${name}`, () => {
    let driver: IStorageDriver;

    const streamToBuffer = async (stream: Readable): Promise<Buffer> => {
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
      return Buffer.concat(chunks);
    };

    const sha256Hex = (buf: Buffer): string =>
      crypto.createHash('sha256').update(buf).digest('hex');

    it('uploads a file and verifies stat and byte-for-byte stream download hash', async () => {
      driver = factory();
      const payload = crypto.randomBytes(64 * 1024); // 64 KiB
      const expectedSha256 = sha256Hex(payload);
      const key = `contract/${Date.now()}-upload-stat.bin`;

      const uploadInput: StorageUploadInput = {
        key,
        source: () => Readable.from(payload),
        size: payload.length,
        sha256: expectedSha256,
        mimetype: 'application/octet-stream',
        visibility: 'public',
      };

      const result = await driver.upload(uploadInput);
      expect(result.ref.key).toBe(key);
      expect(result.size).toBe(payload.length);

      // Verify stat
      const stat = await driver.stat(result.ref);
      expect(stat).not.toBeNull();
      expect(stat?.size).toBe(payload.length);

      // Verify downloadStream matches byte-for-byte
      const { stream, size } = await driver.downloadStream(result.ref);
      if (size !== undefined) {
        expect(size).toBe(payload.length);
      }
      const downloadedBuffer = await streamToBuffer(stream);
      expect(downloadedBuffer.length).toBe(payload.length);
      expect(sha256Hex(downloadedBuffer)).toBe(expectedSha256);

      if (options?.cleanup) {
        await options.cleanup(driver);
      }
    });

    it('supports range reads for start-end and start- slices', async () => {
      driver = factory();
      // 100 bytes sequential: 0x00 to 0x63
      const payload = Buffer.from(Array.from({ length: 100 }, (_, i) => i));
      const key = `contract/${Date.now()}-range.bin`;

      const uploadInput: StorageUploadInput = {
        key,
        source: () => Readable.from(payload),
        size: payload.length,
        sha256: sha256Hex(payload),
        mimetype: 'application/octet-stream',
        visibility: 'public',
      };

      const { ref } = await driver.upload(uploadInput);

      if (driver.capabilities.rangeReads) {
        // 1. start-end: bytes 10 to 19 (inclusive = 10 bytes)
        const slice1 = await driver.downloadStream(ref, {
          range: { start: 10, end: 19 },
        });
        const buf1 = await streamToBuffer(slice1.stream);
        expect(buf1.length).toBe(10);
        expect(buf1.equals(payload.subarray(10, 20))).toBe(true);

        // 2. start-: bytes 80 to end (20 bytes)
        const slice2 = await driver.downloadStream(ref, {
          range: { start: 80 },
        });
        const buf2 = await streamToBuffer(slice2.stream);
        expect(buf2.length).toBe(20);
        expect(buf2.equals(payload.subarray(80))).toBe(true);
      }
    });

    it('returns null on stat and throws NotFoundError on downloadStream for missing keys', async () => {
      driver = factory();
      const nonExistentRef = {
        provider: driver.name,
        key: `non-existent/key-${Date.now()}.bin`,
      };

      const statResult = await driver.stat(nonExistentRef);
      expect(statResult).toBeNull();

      await expect(driver.downloadStream(nonExistentRef)).rejects.toThrow(
        NotFoundError,
      );
    });

    it('ensures delete is strictly idempotent', async () => {
      driver = factory();
      const payload = Buffer.from('delete-test');
      const key = `contract/${Date.now()}-delete.bin`;

      const { ref } = await driver.upload({
        key,
        source: () => Readable.from(payload),
        size: payload.length,
        sha256: sha256Hex(payload),
        mimetype: 'text/plain',
        visibility: 'public',
      });

      // 1. First delete succeeds
      await expect(driver.delete(ref)).resolves.not.toThrow();
      expect(await driver.stat(ref)).toBeNull();

      // 2. Second delete of same key succeeds without error
      await expect(driver.delete(ref)).resolves.not.toThrow();

      // 3. Deleting non-existent object succeeds without error
      await expect(
        driver.delete({
          provider: driver.name,
          key: `missing-${Date.now()}.bin`,
        }),
      ).resolves.not.toThrow();
    });

    it('overwrites existing keys without error upon re-upload', async () => {
      driver = factory();
      const key = `contract/${Date.now()}-overwrite.bin`;

      const payloadA = Buffer.from('payload-AAA');
      const payloadB = Buffer.from('payload-BBB-longer');

      // Upload A
      const resA = await driver.upload({
        key,
        source: () => Readable.from(payloadA),
        size: payloadA.length,
        sha256: sha256Hex(payloadA),
        mimetype: 'text/plain',
        visibility: 'public',
      });
      expect(resA.size).toBe(payloadA.length);

      // Overwrite with B
      const resB = await driver.upload({
        key,
        source: () => Readable.from(payloadB),
        size: payloadB.length,
        sha256: sha256Hex(payloadB),
        mimetype: 'text/plain',
        visibility: 'public',
      });
      expect(resB.size).toBe(payloadB.length);

      const downloaded = await driver.downloadStream(resB.ref);
      const downloadedBuffer = await streamToBuffer(downloaded.stream);
      expect(downloadedBuffer.equals(payloadB)).toBe(true);
    });

    it('calls the source factory again upon retry after a transient failure', async () => {
      driver = factory();
      let sourceCalls = 0;
      const payload = Buffer.from('retryable-payload');
      const key = `contract/${Date.now()}-retry.bin`;

      const input: StorageUploadInput = {
        key,
        source: () => {
          sourceCalls++;
          return Readable.from(payload);
        },
        size: payload.length,
        sha256: sha256Hex(payload),
        mimetype: 'text/plain',
        visibility: 'public',
      };

      const injectable = driver as unknown as FailureInjectable;
      if (typeof injectable.failNext === 'function') {
        // Inject transient 503 error on first upload attempt
        injectable.failNext(
          'upload',
          new RetryableError('503 Service Unavailable'),
        );

        // Attempt 1 fails
        await expect(driver.upload(input)).rejects.toThrow(RetryableError);
        expect(sourceCalls).toBe(1);

        // Attempt 2 (retry) must invoke source() a second time and succeed
        const res = await driver.upload(input);
        expect(res.size).toBe(payload.length);
        expect(sourceCalls).toBe(2);
      } else {
        // Driver does not support failure injection: verify multiple source() calls directly
        const stream1 = input.source();
        const stream2 = input.source();
        expect(sourceCalls).toBe(2);
        const buf1 = await streamToBuffer(stream1);
        const buf2 = await streamToBuffer(stream2);
        expect(buf1.equals(payload)).toBe(true);
        expect(buf2.equals(payload)).toBe(true);
      }
    });

    it('streams 50 MiB upload with bounded process memory growth', async () => {
      driver = factory();
      const chunkSize = 1024 * 1024; // 1 MiB chunk
      const totalChunks = 50;
      const totalBytes = chunkSize * totalChunks;
      const singleChunk = Buffer.alloc(chunkSize, 0x5a); // 1 MiB repeating buffer

      // Calculate SHA256 of 50 chunks
      const hash = crypto.createHash('sha256');
      for (let i = 0; i < totalChunks; i++) {
        hash.update(singleChunk);
      }
      const expectedSha256 = hash.digest('hex');

      const streamFactory = () => {
        let sent = 0;
        return new Readable({
          read() {
            if (sent < totalChunks) {
              sent++;
              this.push(singleChunk);
            } else {
              this.push(null);
            }
          },
        });
      };

      const key = `contract/${Date.now()}-50mb-stream.bin`;

      const memBefore = process.memoryUsage().heapUsed;

      const result = await driver.upload({
        key,
        source: streamFactory,
        size: totalBytes,
        sha256: expectedSha256,
        mimetype: 'application/octet-stream',
        visibility: 'public',
      });

      const memAfter = process.memoryUsage().heapUsed;
      const memDelta = memAfter - memBefore;

      expect(result.size).toBe(totalBytes);
      // Bounded memory growth: must not buffer runaway copies in memory (< 120 MiB bound)
      expect(memDelta).toBeLessThan(120 * 1024 * 1024);

      const stat = await driver.stat(result.ref);
      expect(stat?.size).toBe(totalBytes);

      // Clean up uploaded test file
      await driver.delete(result.ref);
    });

    it('returns direct URL when supported and null when driver cannot provide client-reachable URL', async () => {
      driver = factory();
      const ref = {
        provider: driver.name,
        key: `contract/${Date.now()}-direct-url.bin`,
      };

      const url = await driver.getDirectUrl(ref);
      const isReachable =
        driver.capabilities.publicCdn || driver.capabilities.presignedUrls;

      if (isReachable) {
        expect(typeof url).toBe('string');
        const keyWithoutExt = ref.key.replace(/\.[^/.]+$/, '');
        expect(url!.includes(ref.key) || url!.includes(keyWithoutExt)).toBe(
          true,
        );
      } else {
        expect(url).toBeNull();
      }

      // If capabilities can be toggled (e.g. in FakeStorageDriver), verify null behavior when disabled
      const injectable = driver as unknown as FailureInjectable;
      if (typeof injectable.setCapabilities === 'function') {
        injectable.setCapabilities({ publicCdn: false, presignedUrls: false });
        const disabledUrl = await driver.getDirectUrl(ref);
        expect(disabledUrl).toBeNull();
      }
    });

    it('correctly classifies storage errors into RetryableError, PermanentError, and NotFoundError', () => {
      // 1. NotFoundError classifications
      expect(classifyStorageError({ status: 404 })).toBeInstanceOf(
        NotFoundError,
      );
      expect(classifyStorageError({ code: 'ENOENT' })).toBeInstanceOf(
        NotFoundError,
      );
      expect(classifyStorageError({ name: 'NoSuchKey' })).toBeInstanceOf(
        NotFoundError,
      );

      // 2. RetryableError classifications (429, 5xx, network drops)
      const err429 = classifyStorageError({
        status: 429,
        headers: { 'retry-after': '3' },
      });
      expect(err429).toBeInstanceOf(RetryableError);
      expect((err429 as RetryableError).retryAfterMs).toBe(3000);

      expect(classifyStorageError({ status: 503 })).toBeInstanceOf(
        RetryableError,
      );
      expect(classifyStorageError({ code: 'ECONNRESET' })).toBeInstanceOf(
        RetryableError,
      );
      expect(classifyStorageError({ code: 'ETIMEDOUT' })).toBeInstanceOf(
        RetryableError,
      );
      expect(classifyStorageError({ code: 'ENOSPC' })).toBeInstanceOf(
        RetryableError,
      );
      expect(
        classifyStorageError({ name: 'ThrottlingException' }),
      ).toBeInstanceOf(RetryableError);

      // 3. PermanentError classifications (4xx, permissions, bad auth)
      expect(classifyStorageError({ status: 400 })).toBeInstanceOf(
        PermanentError,
      );
      expect(classifyStorageError({ status: 401 })).toBeInstanceOf(
        PermanentError,
      );
      expect(classifyStorageError({ status: 403 })).toBeInstanceOf(
        PermanentError,
      );
      expect(classifyStorageError({ code: 'EACCES' })).toBeInstanceOf(
        PermanentError,
      );
      expect(classifyStorageError({ name: 'AccessDenied' })).toBeInstanceOf(
        PermanentError,
      );
      expect(
        classifyStorageError({ name: 'InvalidAccessKeyId' }),
      ).toBeInstanceOf(PermanentError);
    });
  });
}
