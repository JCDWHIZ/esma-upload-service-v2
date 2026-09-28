# Storage Layer Architecture & Driver Contracts

This directory contains the storage driver abstractions, capability contracts, error classification logic, and driver implementations for `esma-upload-service-v2`.

## 1. Storage Driver Interface (`IStorageDriver`)

All storage drivers (`local`, `seaweedfs`, `cloudinary`, and test doubles like `FakeStorageDriver`) implement the canonical interface defined in [types.ts](./types.ts):

```typescript
export interface IStorageDriver {
  readonly name: ProviderName;
  readonly capabilities: DriverCapabilities;
  isConfigured(): boolean;
  healthCheck(signal?: AbortSignal): Promise<DriverHealth>;
  upload(input: StorageUploadInput): Promise<DriverUploadResult>;
  downloadStream(
    ref: ProviderRef,
    opts?: ReadOptions,
  ): Promise<{ stream: Readable; size?: number; contentType?: string }>;
  stat(ref: ProviderRef): Promise<StorageObjectStat | null>;
  getDirectUrl(ref: ProviderRef, opts?: DirectUrlOptions): Promise<string | null>;
  delete(ref: ProviderRef): Promise<void>;
  list?(
    prefix: string,
    opts?: { cursor?: string; limit?: number },
  ): Promise<{ items: ProviderObjectInfo[]; nextCursor?: string }>;
}
```

### Key Contract Guarantees

1. **Re-readable Sources**: `input.source` is a factory `() => Readable`. If a transient error occurs during upload, retry mechanisms call `input.source()` again to obtain a fresh, unconsumed stream.
2. **Streaming & Bounded Memory**: Drivers stream payloads rather than buffering whole files in Node.js process memory. 50+ MiB uploads must operate with bounded memory growth.
3. **Idempotent Deletes**: Calling `delete(ref)` multiple times or deleting a non-existent key succeeds without error.
4. **Range Reads**: Range slices (`start-end` and `start-`) return exact byte slices and size indicators when `capabilities.rangeReads` is true.
5. **Direct URLs**: When a driver cannot produce a client-reachable URL (e.g., local disk without reverse-proxy mapping, or internal-only S3 endpoints), `getDirectUrl` returns `null`.

---

## 2. Error Classification Table

Storage drivers normalize underlying provider errors (POSIX filesystem codes, AWS S3 errors, Cloudinary API responses, and Node.js network errors) into typed domain `AppError` subclasses via [classifyStorageError](./errors.ts):

| Raw Error Indicator | Raw Sources / Codes | Domain Error Class | HTTP Status | Action / Handling |
| :--- | :--- | :--- | :--- | :--- |
| **Object Missing / 404** | HTTP 404, `ENOENT`, `NoSuchKey`, `NotFound` | `NotFoundError` | 404 | Caller receives 404; delete treats missing as no-op. |
| **Rate Limited / 429** | HTTP 429, `ThrottlingException`, `SlowDown` | `RetryableError` | 429 / 500 | Retry with exponential backoff; populates `retryAfterMs` from `Retry-After` header. |
| **Server Transient (5xx)** | HTTP 500, 502, 503, 504, `ServiceUnavailable` | `RetryableError` | 500 / 503 | Automatic retry by consumer framework. |
| **Network / Socket Interruption** | `ECONNRESET`, `ETIMEDOUT`, `ECONNREFUSED`, `EAI_AGAIN`, `ENOTFOUND`, `EPIPE`, `ERR_STREAM_PREMATURE_CLOSE` | `RetryableError` | 500 | Reconnect and retry. |
| **Storage Capacity** | `ENOSPC`, `EBUSY`, `EMFILE` | `RetryableError` | 500 | Temporary OS file handle exhaustion; retryable after backoff. |
| **Client / Invalid Request** | HTTP 400, 422, `InvalidDigest`, `InvalidBucketName` | `PermanentError` | 400 / 422 | Non-recoverable; do not retry; fails fast. |
| **Authentication & Permissions** | HTTP 401, 403, `EACCES`, `EPERM`, `AccessDenied`, `InvalidAccessKeyId`, `SignatureDoesNotMatch` | `PermanentError` | 403 | Credential or permission misconfiguration; alerts ops immediately; non-retryable. |
| **Policy Violation** | Non-public visibility on public-only CDN (e.g. Cloudinary) | `PolicyViolationError` | 403 | Defense-in-depth policy rejection. |

---

## 3. Shared Driver Contract Suite

All storage drivers are validated by the reusable contract suite in `tests/contract/driver.contract.ts`:

```typescript
import { runDriverContract } from './driver.contract.js';

describe('LocalStorageDriver Contract', () => {
  runDriverContract('LocalStorageDriver', () => new LocalStorageDriver(config));
});
```

The test runner executes tests with:

```bash
npm run test:contract
```
