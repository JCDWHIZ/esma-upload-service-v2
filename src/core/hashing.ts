import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform, type TransformCallback } from 'node:stream';

export interface HashingTransform extends Transform {
  getDigest(encoding?: 'hex' | 'base64'): string;
}

/**
 * Computes SHA-256 hex digest of a local file via streaming.
 */
export async function hashFile(
  filePath: string,
  algorithm = 'sha256',
): Promise<string> {
  const hash = createHash(algorithm);
  const stream = createReadStream(filePath);
  await pipeline(stream, hash);
  return hash.digest('hex');
}

/**
 * Creates a passthrough transform stream that hashes data on the fly.
 */
export function createHashingTransform(algorithm = 'sha256'): HashingTransform {
  const hash = createHash(algorithm);
  let digestHex: string | null = null;

  const transform = new Transform({
    transform(
      chunk: Buffer,
      _encoding: BufferEncoding,
      callback: TransformCallback,
    ) {
      hash.update(chunk);
      callback(null, chunk);
    },
    flush(callback: TransformCallback) {
      digestHex = hash.digest('hex');
      callback();
    },
  }) as HashingTransform;

  transform.getDigest = (encoding: 'hex' | 'base64' = 'hex') => {
    if (digestHex !== null) {
      return encoding === 'hex'
        ? digestHex
        : Buffer.from(digestHex, 'hex').toString('base64');
    }
    return hash.copy().digest(encoding);
  };

  return transform;
}

/**
 * Computes SHA-256 hex digest of an in-memory buffer.
 */
export function hashBuffer(
  buffer: Buffer | Uint8Array,
  algorithm = 'sha256',
): string {
  return createHash(algorithm).update(buffer).digest('hex');
}
