import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/core/errors/app-error.js';
import { LocalStorageDriver } from '../../src/storage/drivers/local.driver.js';

describe('LocalStorageDriver Unit & Security Tests', () => {
  let rootDir: string;
  let stagingDir: string;
  let driver: LocalStorageDriver;

  beforeEach(async () => {
    rootDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'local-driver-root-'),
    );
    stagingDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'local-driver-staging-'),
    );
    driver = new LocalStorageDriver({ rootPath: rootDir, stagingDir });
  });

  afterEach(async () => {
    await fs.promises
      .rm(rootDir, { recursive: true, force: true })
      .catch(() => {});
    await fs.promises
      .rm(stagingDir, { recursive: true, force: true })
      .catch(() => {});
  });

  describe('Path Overlap & Startup Hardening', () => {
    it('refuses startup if rootPath and stagingDir are identical', () => {
      expect(
        () =>
          new LocalStorageDriver({ rootPath: rootDir, stagingDir: rootDir }),
      ).toThrow(ValidationError);
    });

    it('refuses startup if rootPath is inside stagingDir', () => {
      const nested = path.join(stagingDir, 'nested-storage');
      expect(
        () => new LocalStorageDriver({ rootPath: nested, stagingDir }),
      ).toThrow(ValidationError);
    });

    it('refuses startup if stagingDir is inside rootPath', () => {
      const nested = path.join(rootDir, 'nested-staging');
      expect(
        () => new LocalStorageDriver({ rootPath: rootDir, stagingDir: nested }),
      ).toThrow(ValidationError);
    });
  });

  describe('Path Traversal & Hostile Key Hardening', () => {
    const hostileKeys = [
      '../outside.txt',
      '../../outside.txt',
      '../../../etc/passwd',
      'subfolder/../../../../etc/shadow',
      '..\\..\\windows\\system32\\cmd.exe',
      'file\0.txt',
      '\0hidden.bin',
      '/absolute/path/file.txt',
      'C:\\Windows\\System32\\calc.exe',
    ];

    it.each(hostileKeys)(
      'rejects traversal key "%s" with ValidationError before disk I/O on upload',
      async (hostileKey) => {
        const payload = Buffer.from('hostile-test');
        await expect(
          driver.upload({
            key: hostileKey,
            source: () => Readable.from(payload),
            size: payload.length,
            sha256: crypto.createHash('sha256').update(payload).digest('hex'),
            mimetype: 'text/plain',
            visibility: 'public',
          }),
        ).rejects.toThrow(ValidationError);
      },
    );

    it.each(hostileKeys)(
      'rejects traversal key "%s" on downloadStream, stat, and delete',
      async (hostileKey) => {
        const ref = { provider: driver.name, key: hostileKey };
        await expect(driver.downloadStream(ref)).rejects.toThrow(
          ValidationError,
        );
        await expect(driver.stat(ref)).rejects.toThrow(ValidationError);
        await expect(driver.delete(ref)).rejects.toThrow(ValidationError);
      },
    );
  });

  describe('Atomic Write & Crash Simulation', () => {
    it('leaves no partial target file when stream fails mid-write', async () => {
      const key = 'aborted/mid-write.bin';
      const targetPath = path.join(rootDir, 'aborted', 'mid-write.bin');

      // Failing source stream that emits partial data then errors
      const failingStream = new Readable({
        read() {
          this.push(Buffer.from('partial-chunk-'));
          process.nextTick(() => {
            this.destroy(
              new Error('Simulated network/disk crash during stream'),
            );
          });
        },
      });

      await expect(
        driver.upload({
          key,
          source: () => failingStream,
          size: 1000,
          sha256: 'dummy-sha',
          mimetype: 'application/octet-stream',
          visibility: 'private',
        }),
      ).rejects.toThrow();

      // Invariant: Final target file must NEVER exist
      const targetExists = await fs.promises
        .stat(targetPath)
        .then(() => true)
        .catch(() => false);
      expect(targetExists).toBe(false);

      // Invariant: Temp files cleaned up
      const filesInDir = await fs.promises
        .readdir(path.join(rootDir, 'aborted'))
        .catch(() => []);
      const tempFiles = filesInDir.filter(
        (f) => f.startsWith('.mid-write.bin.') && f.endsWith('.tmp'),
      );
      expect(tempFiles.length).toBe(0);
    });

    it('rejects upload and deletes temp file if written size mismatches declared size', async () => {
      const key = 'mismatch/size.bin';
      const payload = Buffer.from('actual-11-bytes');

      await expect(
        driver.upload({
          key,
          source: () => Readable.from(payload),
          size: 50, // Declared 50 bytes, wrote 15
          sha256: crypto.createHash('sha256').update(payload).digest('hex'),
          mimetype: 'text/plain',
          visibility: 'public',
        }),
      ).rejects.toThrow(ValidationError);

      const targetPath = path.join(rootDir, 'mismatch', 'size.bin');
      const targetExists = await fs.promises
        .stat(targetPath)
        .then(() => true)
        .catch(() => false);
      expect(targetExists).toBe(false);
    });

    it('rejects upload and deletes temp file if SHA-256 checksum mismatches', async () => {
      const key = 'mismatch/hash.bin';
      const payload = Buffer.from('content-data');

      await expect(
        driver.upload({
          key,
          source: () => Readable.from(payload),
          size: payload.length,
          sha256:
            '0000000000000000000000000000000000000000000000000000000000000000',
          mimetype: 'text/plain',
          visibility: 'public',
        }),
      ).rejects.toThrow(ValidationError);

      const targetPath = path.join(rootDir, 'mismatch', 'hash.bin');
      const targetExists = await fs.promises
        .stat(targetPath)
        .then(() => true)
        .catch(() => false);
      expect(targetExists).toBe(false);
    });
  });

  describe('Empty Parent Directory Pruning on Delete', () => {
    it('prunes empty parent directories up to rootPath, preserving root and sibling files', async () => {
      const key1 = 'schools/sch-01/branches/br-01/gallery/photo1.jpg';
      const key2 = 'schools/sch-01/branches/br-01/documents/doc1.pdf';

      const payload = Buffer.from('image-content');
      await driver.upload({
        key: key1,
        source: () => Readable.from(payload),
        size: payload.length,
        sha256: crypto.createHash('sha256').update(payload).digest('hex'),
        mimetype: 'image/jpeg',
        visibility: 'tenant',
      });

      await driver.upload({
        key: key2,
        source: () => Readable.from(payload),
        size: payload.length,
        sha256: crypto.createHash('sha256').update(payload).digest('hex'),
        mimetype: 'application/pdf',
        visibility: 'tenant',
      });

      // 1. Delete key1: 'gallery' should be deleted because it is now empty,
      // but 'br-01' should remain because it still contains 'documents/doc1.pdf'.
      await driver.delete({ provider: driver.name, key: key1 });

      const galleryDir = path.join(
        rootDir,
        'schools',
        'sch-01',
        'branches',
        'br-01',
        'gallery',
      );
      const branchDir = path.join(
        rootDir,
        'schools',
        'sch-01',
        'branches',
        'br-01',
      );

      const galleryExists = await fs.promises
        .stat(galleryDir)
        .then(() => true)
        .catch(() => false);
      const branchExists = await fs.promises
        .stat(branchDir)
        .then(() => true)
        .catch(() => false);

      expect(galleryExists).toBe(false);
      expect(branchExists).toBe(true);

      // 2. Now delete key2: all parent directories ('documents', 'br-01', 'branches', 'sch-01', 'schools')
      // should be cleaned up because they are now completely empty, but rootDir must remain!
      await driver.delete({ provider: driver.name, key: key2 });

      const schoolsDir = path.join(rootDir, 'schools');
      const schoolsExists = await fs.promises
        .stat(schoolsDir)
        .then(() => true)
        .catch(() => false);
      const rootExists = await fs.promises
        .stat(rootDir)
        .then(() => true)
        .catch(() => false);

      expect(schoolsExists).toBe(false);
      expect(rootExists).toBe(true);
    });
  });

  describe('Health Check & Probes', () => {
    it('reports ok: true when rootPath is writable and functional', async () => {
      const health = await driver.healthCheck();
      expect(health.ok).toBe(true);
      expect(health.latencyMs).toBeGreaterThanOrEqual(0);
      expect(health.detail).toBeUndefined();
    });

    it('reports isConfigured: true when rootPath is defined and non-empty', () => {
      expect(driver.isConfigured()).toBe(true);
      const emptyDriver = new LocalStorageDriver({ rootPath: '' });
      expect(emptyDriver.isConfigured()).toBe(false);
    });
  });
});
