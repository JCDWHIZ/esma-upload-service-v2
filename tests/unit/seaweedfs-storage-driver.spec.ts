import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  NotFoundError,
  PermanentError,
  RetryableError,
} from '../../src/core/errors/app-error.js';
import { SeaweedFSStorageDriver } from '../../src/storage/drivers/seaweedfs.driver.js';

describe('SeaweedFSStorageDriver Unit & Security Tests', () => {
  const baseConfig = {
    endpoint: 'http://localhost:8333',
    bucket: 'test-bucket',
    accessKeyId: 'test-key',
    secretAccessKey: 'test-secret',
    allowInternalPresignedUrls: true,
  };

  describe('Configuration & Capabilities', () => {
    it('reports isConfigured true when all required credentials are set', () => {
      const driver = new SeaweedFSStorageDriver(baseConfig);
      expect(driver.isConfigured()).toBe(true);
      expect(driver.capabilities.rangeReads).toBe(true);
      expect(driver.capabilities.privateDelivery).toBe(true);
      expect(driver.capabilities.publicCdn).toBe(false);
    });

    it('reports isConfigured false when any required field is empty', () => {
      const driver = new SeaweedFSStorageDriver({
        ...baseConfig,
        accessKeyId: '',
      });
      expect(driver.isConfigured()).toBe(false);
    });

    it('disables presignedUrls capability when publicEndpoint is not configured (F-24 defense)', () => {
      const driver = new SeaweedFSStorageDriver({
        endpoint: 'http://seaweedfs.internal:8333',
        bucket: 'test-bucket',
        accessKeyId: 'k',
        secretAccessKey: 's',
        allowInternalPresignedUrls: false,
      });
      expect(driver.capabilities.presignedUrls).toBe(false);
    });
  });

  describe('Upload Routing: Single Put vs Multipart', () => {
    it('uses PutObjectCommand with checksum and metadata for files <= 100 MiB', async () => {
      let sentCommand: unknown;
      const mockClient = new S3Client({
        endpoint: 'http://localhost:8333',
        region: 'us-east-1',
        credentials: { accessKeyId: 'k', secretAccessKey: 's' },
        forcePathStyle: true,
      });
      mockClient.send = (
        cmd: unknown,
      ): Promise<{ ETag: string; VersionId: string }> => {
        sentCommand = cmd;
        return Promise.resolve({ ETag: '"test-etag"', VersionId: 'v1' });
      };

      const driver = new SeaweedFSStorageDriver(baseConfig, mockClient);
      const payload = Buffer.from('hello-seaweed');

      const result = await driver.upload({
        key: 'tenants/sch-01/file.txt',
        source: () => Readable.from(payload),
        size: payload.length,
        sha256:
          '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
        mimetype: 'text/plain',
        visibility: 'private',
        attributes: { 'test-attr': 'val-1' },
      });

      expect(sentCommand).toBeInstanceOf(PutObjectCommand);
      const put = sentCommand as PutObjectCommand;
      expect(put.input.Bucket).toBe('test-bucket');
      expect(put.input.Key).toBe('tenants/sch-01/file.txt');
      expect(put.input.ContentLength).toBe(payload.length);
      expect(put.input.Metadata?.['test-attr']).toBe('val-1');
      expect(result.etag).toBe('test-etag');
      expect(result.size).toBe(payload.length);
    });
  });

  describe('Direct Presigned URL Generation (F-24)', () => {
    it('returns null when presignedUrls capability is false', async () => {
      const driver = new SeaweedFSStorageDriver({
        ...baseConfig,
        allowInternalPresignedUrls: false,
      });
      const url = await driver.getDirectUrl({
        provider: 'seaweedfs',
        key: 'tenants/sch-01/doc.pdf',
      });
      expect(url).toBeNull();
    });

    it('rewrites public endpoint host when publicEndpoint is configured', async () => {
      const driver = new SeaweedFSStorageDriver({
        ...baseConfig,
        publicEndpoint: 'https://cdn.example.com',
      });
      const url = await driver.getDirectUrl({
        provider: 'seaweedfs',
        key: 'tenants/sch-01/doc.pdf',
      });
      expect(typeof url).toBe('string');
      expect(url).toContain(
        'https://cdn.example.com/test-bucket/tenants/sch-01/doc.pdf',
      );
    });
  });

  describe('Download Stream & Range Requests', () => {
    it('passes Range header to GetObjectCommand and streams data', async () => {
      const payload = Buffer.from('abcdefghijklmnopqrstuvwxyz');
      let capturedRange: string | undefined;

      const mockClient = {
        send: (
          cmd: unknown,
        ): Promise<{
          Body: Readable;
          ContentLength: number;
          ContentType: string;
        }> => {
          if (cmd instanceof GetObjectCommand) {
            capturedRange = cmd.input.Range;
            const slice = payload.subarray(5, 10);
            return Promise.resolve({
              Body: Readable.from(slice),
              ContentLength: slice.length,
              ContentType: 'text/plain',
            });
          }
          return Promise.reject(new Error('Unexpected command'));
        },
      } as unknown as S3Client;

      const driver = new SeaweedFSStorageDriver(baseConfig, mockClient);
      const res = await driver.downloadStream(
        { provider: 'seaweedfs', key: 'alphabet.txt' },
        { range: { start: 5, end: 9 } },
      );

      expect(capturedRange).toBe('bytes=5-9');
      expect(res.size).toBe(5);

      const chunks: Buffer[] = [];
      for await (const chunk of res.stream) {
        chunks.push(chunk as Buffer);
      }
      expect(Buffer.concat(chunks).toString()).toBe('fghij');
    });

    it('throws NotFoundError when GetObject returns NoSuchKey error', async () => {
      const mockClient = {
        send: (): Promise<never> => {
          const err = new Error('The specified key does not exist.');
          err.name = 'NoSuchKey';
          return Promise.reject(err);
        },
      } as unknown as S3Client;

      const driver = new SeaweedFSStorageDriver(baseConfig, mockClient);
      await expect(
        driver.downloadStream({ provider: 'seaweedfs', key: 'missing.txt' }),
      ).rejects.toThrow(NotFoundError);
    });
  });

  describe('Stat & Metadata Retrieval', () => {
    it('returns null on NoSuchKey or 404 status', async () => {
      const mockClient = {
        send: (): Promise<never> => {
          const err = new Error('Not Found');
          (err as { $metadata?: { httpStatusCode?: number } }).$metadata = {
            httpStatusCode: 404,
          };
          err.name = 'NotFound';
          return Promise.reject(err);
        },
      } as unknown as S3Client;

      const driver = new SeaweedFSStorageDriver(baseConfig, mockClient);
      const stat = await driver.stat({
        provider: 'seaweedfs',
        key: 'missing.bin',
      });
      expect(stat).toBeNull();
    });

    it('returns size and etag on successful HeadObject', async () => {
      const mockClient = {
        send: (
          cmd: unknown,
        ): Promise<{
          ContentLength: number;
          ETag: string;
          ContentType: string;
        }> => {
          if (cmd instanceof HeadObjectCommand) {
            return Promise.resolve({
              ContentLength: 4200,
              ETag: '"head-etag-123"',
              ContentType: 'image/jpeg',
            });
          }
          return Promise.reject(new Error('Unexpected command'));
        },
      } as unknown as S3Client;

      const driver = new SeaweedFSStorageDriver(baseConfig, mockClient);
      const stat = await driver.stat({
        provider: 'seaweedfs',
        key: 'picture.jpg',
      });

      expect(stat).not.toBeNull();
      expect(stat?.size).toBe(4200);
      expect(stat?.etag).toBe('head-etag-123');
      expect(stat?.contentType).toBe('image/jpeg');
    });
  });

  describe('Idempotent Delete', () => {
    it('treats DeleteObjectCommand success as idempotent delete', async () => {
      let deletedKey: string | undefined;
      const mockClient = {
        send: (cmd: unknown): Promise<Record<string, never>> => {
          if (cmd instanceof DeleteObjectCommand) {
            deletedKey = cmd.input.Key;
            return Promise.resolve({});
          }
          return Promise.reject(new Error('Unexpected command'));
        },
      } as unknown as S3Client;

      const driver = new SeaweedFSStorageDriver(baseConfig, mockClient);
      await expect(
        driver.delete({ provider: 'seaweedfs', key: 'del-target.bin' }),
      ).resolves.not.toThrow();
      expect(deletedKey).toBe('del-target.bin');
    });
  });

  describe('List Objects with Continuation Tokens', () => {
    it('maps S3 Contents to ProviderObjectInfo and preserves NextContinuationToken', async () => {
      const now = new Date();
      const mockClient = {
        send: (
          cmd: unknown,
        ): Promise<{
          Contents: Array<{
            Key: string;
            Size: number;
            LastModified: Date;
            ETag: string;
          }>;
          NextContinuationToken: string;
        }> => {
          if (cmd instanceof ListObjectsV2Command) {
            return Promise.resolve({
              Contents: [
                {
                  Key: 'tenants/sch-01/file1.png',
                  Size: 1024,
                  LastModified: now,
                  ETag: '"etag-1"',
                },
              ],
              NextContinuationToken: 'token-abc',
            });
          }
          return Promise.reject(new Error('Unexpected command'));
        },
      } as unknown as S3Client;

      const driver = new SeaweedFSStorageDriver(baseConfig, mockClient);
      const res = await driver.list('tenants/sch-01/', { limit: 10 });

      expect(res.items.length).toBe(1);
      expect(res.items[0]?.key).toBe('tenants/sch-01/file1.png');
      expect(res.items[0]?.size).toBe(1024);
      expect(res.items[0]?.etag).toBe('etag-1');
      expect(res.nextCursor).toBe('token-abc');
    });
  });

  describe('Health Check & Auto Bucket Creation', () => {
    it('returns ok: true when HeadBucket succeeds', async () => {
      const mockClient = {
        send: (cmd: unknown): Promise<Record<string, never>> => {
          if (cmd instanceof HeadBucketCommand) {
            return Promise.resolve({});
          }
          return Promise.reject(new Error('Unexpected command'));
        },
      } as unknown as S3Client;

      const driver = new SeaweedFSStorageDriver(baseConfig, mockClient);
      const health = await driver.healthCheck();
      expect(health.ok).toBe(true);
      expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('returns ok: false when HeadBucket fails', async () => {
      const mockClient = {
        send: (cmd: unknown): Promise<never> => {
          if (cmd instanceof HeadBucketCommand) {
            return Promise.reject(new Error('Connection refused'));
          }
          return Promise.reject(new Error('Unexpected command'));
        },
      } as unknown as S3Client;

      const driver = new SeaweedFSStorageDriver(baseConfig, mockClient);
      const health = await driver.healthCheck();
      expect(health.ok).toBe(false);
      expect(health.detail).toContain('Connection refused');
    });

    it('creates bucket during ensureBucket if autoCreateBucket is true and bucket is missing', async () => {
      let createdBucket: string | undefined;
      const mockClient = {
        send: (cmd: unknown): Promise<Record<string, never>> => {
          if (cmd instanceof HeadBucketCommand) {
            const err = new Error('Not Found');
            err.name = 'NotFound';
            return Promise.reject(err);
          }
          if (cmd instanceof CreateBucketCommand) {
            createdBucket = cmd.input.Bucket;
            return Promise.resolve({});
          }
          return Promise.reject(new Error('Unexpected command'));
        },
      } as unknown as S3Client;

      const driver = new SeaweedFSStorageDriver(
        { ...baseConfig, autoCreateBucket: true },
        mockClient,
      );
      await expect(driver.ensureBucket()).resolves.not.toThrow();
      expect(createdBucket).toBe('test-bucket');
    });
  });

  describe('Error Classification', () => {
    it('classifies 429 and 5xx errors into RetryableError', async () => {
      const mockClient = {
        send: (): Promise<never> => {
          const err = new Error('SlowDown');
          err.name = 'SlowDown';
          (err as { $metadata?: { httpStatusCode?: number } }).$metadata = {
            httpStatusCode: 429,
          };
          return Promise.reject(err);
        },
      } as unknown as S3Client;

      const driver = new SeaweedFSStorageDriver(baseConfig, mockClient);
      await expect(
        driver.upload({
          key: 'retry.txt',
          source: () => Readable.from('data'),
          size: 4,
          sha256: 'dummy',
          mimetype: 'text/plain',
          visibility: 'private',
        }),
      ).rejects.toThrow(RetryableError);
    });

    it('classifies AccessDenied into PermanentError', async () => {
      const mockClient = {
        send: (): Promise<never> => {
          const err = new Error('Access Denied');
          err.name = 'AccessDenied';
          (err as { $metadata?: { httpStatusCode?: number } }).$metadata = {
            httpStatusCode: 403,
          };
          return Promise.reject(err);
        },
      } as unknown as S3Client;

      const driver = new SeaweedFSStorageDriver(baseConfig, mockClient);
      await expect(
        driver.delete({ provider: 'seaweedfs', key: 'forbidden.txt' }),
      ).rejects.toThrow(PermanentError);
    });
  });
});
