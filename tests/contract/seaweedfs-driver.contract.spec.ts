import { Readable } from 'node:stream';
import { describe } from 'vitest';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { SeaweedFSStorageDriver } from '../../src/storage/drivers/seaweedfs.driver.js';
import { runDriverContract } from './driver.contract.js';

interface StoredObject {
  buffer: Buffer;
  contentType?: string;
  metadata?: Record<string, string>;
}

/**
 * Creates an S3Client backed by an in-memory object store for deterministic contract testing in CI.
 */
function createMockS3Client(): {
  client: S3Client;
  failNext: (op: string, err: Error) => void;
} {
  const store = new Map<string, StoredObject>();
  let nextFailure: { op: string; err: Error } | null = null;

  const realClient = new S3Client({
    endpoint: 'http://localhost:8333',
    region: 'us-east-1',
    credentials: { accessKeyId: 'test-key', secretAccessKey: 'test-secret' },
    forcePathStyle: true,
  });

  realClient.send = async (command: unknown) => {
    if (command instanceof PutObjectCommand) {
      if (nextFailure && nextFailure.op === 'upload') {
        const err = nextFailure.err;
        nextFailure = null;
        throw err;
      }

      const key = command.input.Key ?? '';
      const body = command.input.Body;
      let buffer: Buffer;

      if (Buffer.isBuffer(body)) {
        buffer = body;
      } else if (body instanceof Readable) {
        const chunks: Buffer[] = [];
        for await (const chunk of body) {
          chunks.push(chunk as Buffer);
        }
        buffer = Buffer.concat(chunks);
      } else if (typeof body === 'string') {
        buffer = Buffer.from(body);
      } else {
        buffer = Buffer.alloc(0);
      }

      store.set(key, {
        buffer,
        contentType: command.input.ContentType,
        metadata: command.input.Metadata,
      });

      return {
        ETag: '"mock-etag"',
        VersionId: '1',
      };
    }

    if (command instanceof HeadObjectCommand) {
      const key = command.input.Key ?? '';
      const obj = store.get(key);
      if (!obj) {
        const err = new Error('The specified key does not exist.');
        err.name = 'NoSuchKey';
        (err as { $metadata?: { httpStatusCode?: number } }).$metadata = {
          httpStatusCode: 404,
        };
        throw err;
      }

      return {
        ContentLength: obj.buffer.length,
        ETag: '"mock-etag"',
        ContentType: obj.contentType ?? 'application/octet-stream',
        Metadata: obj.metadata,
      };
    }

    if (command instanceof GetObjectCommand) {
      const key = command.input.Key ?? '';
      const obj = store.get(key);
      if (!obj) {
        const err = new Error('The specified key does not exist.');
        err.name = 'NoSuchKey';
        (err as { $metadata?: { httpStatusCode?: number } }).$metadata = {
          httpStatusCode: 404,
        };
        throw err;
      }

      const range = command.input.Range;
      if (range && range.startsWith('bytes=')) {
        const rangeSpec = range.slice(6);
        const [startStr, endStr] = rangeSpec.split('-');
        const start = parseInt(startStr, 10);
        const end = endStr ? parseInt(endStr, 10) : obj.buffer.length - 1;
        const slice = obj.buffer.subarray(start, end + 1);

        return {
          Body: Readable.from(slice),
          ContentLength: slice.length,
          ContentType: obj.contentType ?? 'application/octet-stream',
        };
      }

      return {
        Body: Readable.from(obj.buffer),
        ContentLength: obj.buffer.length,
        ContentType: obj.contentType ?? 'application/octet-stream',
      };
    }

    if (command instanceof DeleteObjectCommand) {
      const key = command.input.Key ?? '';
      store.delete(key);
      return {};
    }

    if (command instanceof HeadBucketCommand) {
      return {};
    }

    if (command instanceof ListObjectsV2Command) {
      const prefix = command.input.Prefix ?? '';
      const contents = Array.from(store.entries())
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, v]) => ({
          Key: k,
          Size: v.buffer.length,
          LastModified: new Date(),
          ETag: '"mock-etag"',
        }));

      return {
        Contents: contents,
      };
    }

    throw new Error(`Unhandled command in mock S3 client: ${String(command)}`);
  };

  return {
    client: realClient,
    failNext: (op: string, err: Error) => {
      nextFailure = { op, err };
    },
  };
}

describe('SeaweedFSStorageDriver Contract Verification', () => {
  const { client, failNext } = createMockS3Client();

  const driver = new SeaweedFSStorageDriver(
    {
      endpoint: 'http://localhost:8333',
      bucket: 'contract-bucket',
      accessKeyId: 'test-key',
      secretAccessKey: 'test-secret',
      allowInternalPresignedUrls: true,
    },
    client,
  );

  (driver as unknown as { failNext: typeof failNext }).failNext = failNext;

  runDriverContract('SeaweedFSStorageDriver', () => driver);
});
