import { PassThrough, Readable } from 'node:stream';
import { describe } from 'vitest';
import type { v2 as cloudinaryType } from 'cloudinary';
import { CloudinaryStorageDriver } from '../../src/storage/drivers/cloudinary.driver.js';
import { runDriverContract } from './driver.contract.js';

interface StoredAsset {
  buffer: Buffer;
  bytes: number;
  public_id: string;
  resource_type: string;
  format: string;
  version: number;
  etag: string;
}

/**
 * Creates an in-memory mock of the Cloudinary v2 SDK for deterministic contract testing in CI.
 */
function createMockCloudinary(): typeof cloudinaryType {
  const assets = new Map<string, StoredAsset>();
  let versionCounter = 1;

  const mockInstance = {
    config: () => ({}),
    uploader: {
      upload_stream: (
        opts: Record<string, unknown>,
        callback: (err: unknown, result?: unknown) => void,
      ) => {
        const chunks: Buffer[] = [];
        const pass = new PassThrough();

        pass.on('data', (chunk: Buffer) => chunks.push(chunk));
        pass.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const publicId = (opts.public_id as string) || `auto-${Date.now()}`;
          const resourceType = (opts.resource_type as string) || 'image';
          const version = versionCounter++;
          const etag = `etag-${publicId}-${version}`;

          assets.set(publicId, {
            buffer,
            bytes: buffer.length,
            public_id: publicId,
            resource_type: resourceType,
            format: 'png',
            version,
            etag,
          });

          callback(null, {
            public_id: publicId,
            resource_type: resourceType,
            type: 'upload',
            format: 'png',
            bytes: buffer.length,
            width: 100,
            height: 100,
            version,
            asset_id: `asset-${publicId}`,
            etag,
            secure_url: `https://res.cloudinary.com/test-cloud/${resourceType}/upload/v${version}/${publicId}`,
          });
        });

        return pass;
      },
      destroy: (publicId: string): Promise<{ result: string }> => {
        if (assets.has(publicId)) {
          assets.delete(publicId);
          return Promise.resolve({ result: 'ok' });
        }
        return Promise.resolve({ result: 'not found' });
      },
    },
    api: {
      resource: (publicId: string): Promise<StoredAsset> => {
        const found = assets.get(publicId);
        if (!found) {
          const err = new Error('Resource not found');
          (err as { status?: number }).status = 404;
          return Promise.reject(err);
        }
        return Promise.resolve(found);
      },
      ping: (): Promise<{ status: string }> =>
        Promise.resolve({ status: 'ok' }),
    },
    url: (publicId: string, opts?: Record<string, unknown>): string => {
      const resourceType = (opts?.resource_type as string) || 'image';
      return `https://res.cloudinary.com/test-cloud/${resourceType}/upload/${publicId}`;
    },
  } as unknown as typeof cloudinaryType;

  // Intercept global fetch for delivery URL downloadStream tests
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const urlStr =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (urlStr.startsWith('https://res.cloudinary.com/test-cloud/')) {
      // Extract public_id from url
      const match = urlStr.match(/\/upload\/(?:v\d+\/)?([^?#]+)/);
      const publicId = match ? decodeURIComponent(match[1]) : '';
      const found = assets.get(publicId);

      if (!found) {
        return new Response('Not found', { status: 404 });
      }

      const rangeHeader = init?.headers
        ? (init.headers as Record<string, string>)['Range']
        : undefined;
      if (rangeHeader && rangeHeader.startsWith('bytes=')) {
        const rangeSpec = rangeHeader.slice(6);
        const [startStr, endStr] = rangeSpec.split('-');
        const start = parseInt(startStr, 10);
        const end = endStr ? parseInt(endStr, 10) : found.buffer.length - 1;
        const slice = found.buffer.subarray(start, end + 1);

        return new Response(
          Readable.toWeb(Readable.from(slice)) as ReadableStream,
          {
            status: 206,
            headers: {
              'content-length': String(slice.length),
              'content-type': 'image/png',
              'content-range': `bytes ${start}-${end}/${found.buffer.length}`,
            },
          },
        );
      }

      return new Response(
        Readable.toWeb(Readable.from(found.buffer)) as ReadableStream,
        {
          status: 200,
          headers: {
            'content-length': String(found.buffer.length),
            'content-type': 'image/png',
          },
        },
      );
    }

    return originalFetch(input, init);
  };

  return mockInstance;
}

describe('CloudinaryStorageDriver Contract Verification', () => {
  const mockCloudinary = createMockCloudinary();
  const driver = new CloudinaryStorageDriver(
    {
      cloudName: 'test-cloud',
      apiKey: 'test-key',
      apiSecret: 'test-secret',
      rootFolder: 'uploads',
    },
    mockCloudinary,
  );

  runDriverContract('CloudinaryStorageDriver', () => driver);
});
