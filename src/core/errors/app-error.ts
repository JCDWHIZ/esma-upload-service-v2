export interface AppErrorOptions {
  message: string;
  code?: string;
  status?: number;
  expose?: boolean;
  cause?: unknown;
  detail?: string;
  errors?: unknown[];
  correlationId?: string;
}

export class AppError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly expose: boolean;
  public readonly detail?: string;
  public readonly errors: unknown[];
  public override readonly cause?: unknown;
  public correlationId?: string;

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

export class TenantMismatchError extends ForbiddenError {
  constructor(
    message = 'Caller tenant does not match requested resource tenant',
    options?: Partial<AppErrorOptions>,
  ) {
    super(message, {
      code: 'TENANT_MISMATCH',
      ...options,
    });
  }
}

export class QuotaExceededError extends ForbiddenError {
  constructor(
    message = 'Tenant storage quota has been exceeded',
    options?: Partial<AppErrorOptions>,
  ) {
    super(message, {
      code: 'QUOTA_EXCEEDED',
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

export class ReplicaNotAvailableError extends ConflictError {
  constructor(
    message = 'The requested storage replica is not available',
    options?: Partial<AppErrorOptions>,
  ) {
    super(message, {
      code: 'REPLICA_NOT_AVAILABLE',
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

export class RetryableError extends AppError {
  constructor(
    message = 'Transient failure, can be retried',
    options?: Partial<AppErrorOptions>,
  ) {
    super({
      message,
      code: 'RETRYABLE_ERROR',
      status: 500,
      expose: false,
      ...options,
    });
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
