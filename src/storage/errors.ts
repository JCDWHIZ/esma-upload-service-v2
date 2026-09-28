import {
  AppError,
  NotFoundError,
  PermanentError,
  RetryableError,
} from '../core/errors/app-error.js';

export interface StorageErrorDetails {
  status?: number;
  statusCode?: number;
  code?: string;
  name?: string;
  message?: string;
  retryAfterMs?: number;
  headers?: Record<string, string | number | undefined>;
}

/**
 * Classifies an unknown storage error into a typed domain AppError:
 * - NotFoundError: 404, ENOENT, NoSuchKey
 * - RetryableError: 429 (with retryAfterMs), 5xx, network drops, timeouts, socket errors
 * - PermanentError: 400, 401, 403, EACCES, AccessDenied, invalid credentials/config
 */
export function classifyStorageError(
  error: unknown,
  defaultMessage = 'Storage operation failed',
): AppError {
  if (error instanceof AppError) {
    return error;
  }

  const err = (error ?? {}) as StorageErrorDetails;
  const status = err.status ?? err.statusCode;
  const code = err.code;
  const name = err.name;
  const message =
    (error instanceof Error ? error.message : undefined) ??
    err.message ??
    defaultMessage;

  // 1. Not Found
  if (
    status === 404 ||
    code === 'ENOENT' ||
    name === 'NoSuchKey' ||
    name === 'NotFound' ||
    message.toLowerCase().includes('not found')
  ) {
    return new NotFoundError(message, { cause: error });
  }

  // 2. Retryable Errors: 429, 5xx, transient I/O & network errors
  const is429 =
    status === 429 || name === 'ThrottlingException' || name === 'SlowDown';
  const is5xx = status !== undefined && status >= 500 && status <= 599;
  const retryableCodes = new Set([
    'ECONNRESET',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'EAI_AGAIN',
    'ENOTFOUND',
    'ENOSPC',
    'EBUSY',
    'EMFILE',
    'EPIPE',
    'ERR_STREAM_PREMATURE_CLOSE',
  ]);

  if (is429 || is5xx || (code && retryableCodes.has(code))) {
    let retryAfterMs: number | undefined = err.retryAfterMs;

    if (!retryAfterMs && err.headers) {
      const headerVal =
        err.headers['retry-after'] ?? err.headers['Retry-After'];
      if (typeof headerVal === 'number') {
        retryAfterMs = headerVal * 1000;
      } else if (typeof headerVal === 'string') {
        const parsed = parseInt(headerVal, 10);
        if (!isNaN(parsed)) {
          retryAfterMs = parsed * 1000;
        }
      }
    }

    return new RetryableError(message, {
      cause: error,
      status: status ?? 500,
      retryAfterMs,
    });
  }

  // 3. Permanent Errors: 4xx, authentication, permission, invalid requests
  const is4xx = status !== undefined && status >= 400 && status <= 499;
  const permanentCodes = new Set(['EACCES', 'EPERM']);
  const permanentNames = new Set([
    'AccessDenied',
    'InvalidAccessKeyId',
    'SignatureDoesNotMatch',
    'InvalidBucketName',
    'InvalidDigest',
  ]);

  if (
    is4xx ||
    (code && permanentCodes.has(code)) ||
    (name && permanentNames.has(name))
  ) {
    return new PermanentError(message, {
      cause: error,
      status: status ?? 400,
    });
  }

  // Fallback: Default to PermanentError if unclassifiable
  return new PermanentError(message, {
    cause: error,
    status: typeof status === 'number' ? status : 500,
  });
}
