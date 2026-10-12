export interface AppErrorOptions {
  message: string;
  code?: string;
  status?: number;
  expose?: boolean;
  cause?: unknown;
  detail?: string;
  errors?: unknown[];
  correlationId?: string;
  headers?: Record<string, string>;
}

export class AppError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly expose: boolean;
  public readonly detail?: string;
  public readonly errors: unknown[];
  public override readonly cause?: unknown;
  public correlationId?: string;
  public readonly headers?: Record<string, string>;

  constructor(optionsOrMessage: AppErrorOptions | string) {
    const opts: AppErrorOptions =
      typeof optionsOrMessage === 'string'
        ? { message: optionsOrMessage }
        : optionsOrMessage;

    super(opts.message);
    this.name = this.constructor.name;
    this.code = opts.code ?? 'INTERNAL';
    this.status = opts.status ?? 500;
    this.expose = opts.expose ?? this.status < 500;
    this.detail = opts.detail;
    this.errors = opts.errors ?? [];
    this.cause = opts.cause;
    this.correlationId = opts.correlationId;
    this.headers = opts.headers;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  get statusCode(): number {
    return this.status;
  }
}

export class UnauthenticatedError extends AppError {
  constructor(
    message = 'Authentication is required to access this resource',
    options?: Partial<AppErrorOptions>,
  ) {
    super({
      message,
      code: 'UNAUTHENTICATED',
      status: 401,
      expose: true,
      ...options,
    });
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad request', options?: Partial<AppErrorOptions>) {
    super({
      message,
      code: 'validation_failed',
      status: 400,
      expose: true,
      ...options,
    });
  }
}

export class ForbiddenError extends AppError {
  constructor(
    message = 'You do not have permission to perform this action',
    options?: Partial<AppErrorOptions>,
  ) {
    super({
      message,
      code: 'FORBIDDEN',
      status: 403,
      expose: true,
      ...options,
    });
  }
}

export class OrganizationRequiredError extends AppError {
  constructor(
    message = 'Header X-Organization-Id is required for service principals',
    options?: Partial<AppErrorOptions>,
  ) {
    super({
      message,
      code: 'organization_required',
      status: 400,
      expose: true,
      ...options,
    });
  }
}

export class OrganizationMismatchError extends ForbiddenError {
  constructor(
    message = 'Header X-Organization-Id does not match token organizationId',
    options?: Partial<AppErrorOptions>,
  ) {
    super(message, {
      code: 'organization_mismatch',
      status: 403,
      ...options,
    });
  }
}

export class TenantMismatchError extends OrganizationMismatchError {
  constructor(
    message = 'Caller tenant does not match requested resource tenant',
    options?: Partial<AppErrorOptions>,
  ) {
    super(message, {
      code: 'organization_mismatch',
      ...options,
    });
  }
}

export class NamespaceUnknownError extends AppError {
  constructor(
    message = 'Requested namespace is not recognized in the catalogue',
    options?: Partial<AppErrorOptions>,
  ) {
    super({
      message,
      code: 'namespace_unknown',
      status: 400,
      expose: true,
      ...options,
    });
  }
}

export class NamespaceNotAllowedError extends ForbiddenError {
  constructor(
    message = 'Principal is not authorized to access this namespace',
    options?: Partial<AppErrorOptions>,
  ) {
    super(message, {
      code: 'namespace_not_allowed',
      status: 403,
      ...options,
    });
  }
}

export class TokenRevokedError extends UnauthenticatedError {
  constructor(
    message = 'Token session has been revoked',
    options?: Partial<AppErrorOptions>,
  ) {
    super(message, {
      code: 'token_revoked',
      status: 401,
      ...options,
    });
  }
}

export class TokenStaleError extends UnauthenticatedError {
  constructor(
    message = 'Token permission version is stale',
    options?: Partial<AppErrorOptions>,
  ) {
    super(message, {
      code: 'token_stale',
      status: 401,
      ...options,
    });
  }
}

export class TenantPurgingError extends ForbiddenError {
  constructor(
    message = 'Organization is currently undergoing a purge operation',
    options?: Partial<AppErrorOptions>,
  ) {
    super(message, {
      code: 'tenant_purging',
      status: 403,
      ...options,
    });
  }
}

export class LegalHoldError extends AppError {
  constructor(
    message = 'File or tenant is under legal hold and cannot be deleted or purged',
    options?: Partial<AppErrorOptions>,
  ) {
    super({
      message,
      code: 'legal_hold',
      status: 409,
      expose: true,
      ...options,
    });
  }
}

export class AlreadyClaimedError extends AppError {
  constructor(
    message = 'File is already claimed by another owner',
    options?: Partial<AppErrorOptions>,
  ) {
    super({
      message,
      code: 'already_claimed',
      status: 409,
      expose: true,
      ...options,
    });
  }
}

export class TooManyPendingUploadsError extends AppError {
  constructor(
    message = 'Too many unclaimed pending uploads for this user',
    options?: Partial<AppErrorOptions>,
  ) {
    super({
      message,
      code: 'too_many_pending_uploads',
      status: 429,
      expose: true,
      headers: { 'Retry-After': '60', ...(options?.headers ?? {}) },
      ...options,
    });
  }
}

export class QuotaExceededError extends AppError {
  public readonly quotaBytes?: number;
  public readonly usedBytes?: number;
  public readonly requestedBytes?: number;

  constructor(
    message = 'Tenant storage quota has been exceeded',
    options?: {
      quotaBytes?: number;
      usedBytes?: number;
      requestedBytes?: number;
    } & Partial<AppErrorOptions>,
  ) {
    super({
      message,
      code: 'quota_exceeded',
      status: 507,
      expose: true,
      ...options,
    });
    this.quotaBytes = options?.quotaBytes;
    this.usedBytes = options?.usedBytes;
    this.requestedBytes = options?.requestedBytes;
  }
}

export class TenantSuspendedError extends AppError {
  constructor(
    message = 'Organization is suspended from uploading files',
    options?: Partial<AppErrorOptions>,
  ) {
    super({
      message,
      code: 'tenant_suspended',
      status: 403,
      expose: true,
      ...options,
    });
  }
}

export class FileQuarantinedError extends ForbiddenError {
  constructor(
    message = 'File has been quarantined due to security policy or scan failure',
    options?: Partial<AppErrorOptions>,
  ) {
    super(message, {
      code: 'FILE_QUARANTINED',
      ...options,
    });
  }
}

export class FileInfectedError extends FileQuarantinedError {
  constructor(
    message = 'File has been identified as infected and quarantined',
    options?: Partial<AppErrorOptions>,
  ) {
    super(message, {
      code: 'file_infected',
      status: 422,
      ...options,
    });
  }
}

export class ScanUnavailableError extends FileQuarantinedError {
  constructor(
    message = 'Virus scanner is unavailable and fail-closed policy is active',
    options?: Partial<AppErrorOptions>,
  ) {
    super(message, {
      code: 'scan_unavailable',
      status: 503,
      ...options,
    });
  }
}

export class NotFoundError extends AppError {
  constructor(
    message = 'The requested resource was not found',
    options?: Partial<AppErrorOptions>,
  ) {
    super({
      message,
      code: 'FILE_NOT_FOUND',
      status: 404,
      expose: true,
      ...options,
    });
  }
}

export class ValidationError extends AppError {
  constructor(
    message = 'The request payload failed validation',
    options?: Partial<AppErrorOptions>,
  ) {
    super({
      message,
      code: 'VALIDATION_FAILED',
      status: 422,
      expose: true,
      ...options,
    });
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(
    message = 'The uploaded payload exceeds the allowable size limit',
    options?: Partial<AppErrorOptions>,
  ) {
    super({
      message,
      code: 'FILE_TOO_LARGE',
      status: 413,
      expose: true,
      ...options,
    });
  }
}

export class UnsupportedMediaTypeError extends AppError {
  constructor(
    message = 'The media type of the requested payload is not supported',
    options?: Partial<AppErrorOptions>,
  ) {
    super({
      message,
      code: 'UNSUPPORTED_MEDIA_TYPE',
      status: 415,
      expose: true,
      ...options,
    });
  }
}

export class MimeMismatchError extends UnsupportedMediaTypeError {
  constructor(
    message = 'Detected file contents do not match declared MIME type',
    options?: Partial<AppErrorOptions>,
  ) {
    super(message, {
      code: 'MIME_MISMATCH',
      ...options,
    });
  }
}

export class ConflictError extends AppError {
  constructor(
    message = 'The request conflicts with current state of the resource',
    options?: Partial<AppErrorOptions>,
  ) {
    super({
      message,
      code: 'IDEMPOTENCY_CONFLICT',
      status: 409,
      expose: true,
      ...options,
    });
  }
}

export class IdempotencyConflictError extends ConflictError {
  constructor(
    message = 'An upload with this idempotency key was already completed with a different payload',
    options?: Partial<AppErrorOptions>,
  ) {
    super(message, {
      code: 'IDEMPOTENCY_CONFLICT',
      ...options,
    });
  }
}

export class IdempotencyInProgressError extends ConflictError {
  constructor(
    message = 'A request with this idempotency key is currently in progress',
    options?: Partial<AppErrorOptions>,
  ) {
    super(message, {
      code: 'IDEMPOTENCY_IN_PROGRESS',
      headers: { 'Retry-After': '5', ...(options?.headers ?? {}) },
      ...options,
    });
  }
}

export class FileNotReadyError extends ConflictError {
  constructor(
    message = 'File is still being ingested or replicated and is not ready',
    options?: Partial<AppErrorOptions>,
  ) {
    super(message, {
      code: 'FILE_NOT_READY',
      ...options,
    });
  }
}

export class ScanPendingError extends FileNotReadyError {
  constructor(
    message = 'File virus scan is currently pending',
    options?: Partial<AppErrorOptions>,
  ) {
    super(message, {
      code: 'scan_pending',
      status: 409,
      headers: { 'Retry-After': '2', ...(options?.headers ?? {}) },
      ...options,
    });
  }
}

export class ReplicaNotAvailableError extends ConflictError {
  constructor(
    message = 'The requested storage replica is not available',
    options?: Partial<AppErrorOptions>,
  ) {
    super(message, {
      code: 'REPLICA_NOT_AVAILABLE',
      headers: { 'Retry-After': '30', ...(options?.headers ?? {}) },
      ...options,
    });
  }
}

export class RateLimitedError extends AppError {
  constructor(
    message = 'Too many requests, please slow down',
    options?: Partial<AppErrorOptions>,
  ) {
    super({
      message,
      code: 'RATE_LIMITED',
      status: 429,
      expose: true,
      ...options,
    });
  }
}

export class StorageUnavailableError extends AppError {
  constructor(
    message = 'Underlying storage backend is currently unavailable',
    options?: Partial<AppErrorOptions>,
  ) {
    super({
      message,
      code: 'STORAGE_UNAVAILABLE',
      status: 503,
      expose: true,
      ...options,
    });
  }
}

export class PolicyViolationError extends ForbiddenError {
  constructor(
    message = 'Operation violates storage or upload policy',
    options?: Partial<AppErrorOptions>,
  ) {
    super(message, {
      code: 'POLICY_VIOLATION',
      ...options,
    });
  }
}

export interface RetryableErrorOptions extends Partial<AppErrorOptions> {
  retryAfterMs?: number;
}

export class RetryableError extends AppError {
  public readonly retryAfterMs?: number;

  constructor(
    message = 'Transient failure, can be retried',
    options?: RetryableErrorOptions,
  ) {
    super({
      message,
      code: 'RETRYABLE_ERROR',
      status: 500,
      expose: false,
      ...options,
    });
    this.retryAfterMs = options?.retryAfterMs;
  }
}

export class PermanentError extends AppError {
  constructor(
    message = 'Non-recoverable failure, do not retry',
    options?: Partial<AppErrorOptions>,
  ) {
    super({
      message,
      code: 'PERMANENT_ERROR',
      status: 500,
      expose: false,
      ...options,
    });
  }
}

export class OptimisticLockError extends ConflictError {
  constructor(
    message = 'The resource has been modified concurrently',
    options?: Partial<AppErrorOptions>,
  ) {
    super(message, {
      code: 'OPTIMISTIC_LOCK_CONFLICT',
      ...options,
    });
  }
}
