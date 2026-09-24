import {
  AppError,
  UnauthenticatedError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
  ConflictError,
  RateLimitedError,
  StorageUnavailableError,
  RetryableError,
  PermanentError,
  TenantMismatchError,
} from '../src/core/errors/index.js';
import {
  mapExceptionToCanonical,
  codeToSlug,
  codeToTitle,
} from '../src/common/filters/error-mapper.js';
import { ProblemJsonErrorFilter } from '../src/common/filters/problem-json-error.filter.js';
import { LegacyErrorFilter } from '../src/common/filters/legacy-error.filter.js';
import { ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';

describe('AppError Hierarchy', () => {
  it('should instantiate base AppError with defaults', () => {
    const error = new AppError('Something failed');
    expect(error.message).toBe('Something failed');
    expect(error.code).toBe('INTERNAL');
    expect(error.status).toBe(500);
    expect(error.expose).toBe(false);
    expect(error.errors).toEqual([]);
  });

  it('should set appropriate status and code for subclasses', () => {
    const unauth = new UnauthenticatedError();
    expect(unauth.status).toBe(401);
    expect(unauth.code).toBe('UNAUTHENTICATED');
    expect(unauth.expose).toBe(true);

    const forbidden = new ForbiddenError();
    expect(forbidden.status).toBe(403);
    expect(forbidden.code).toBe('FORBIDDEN');
    expect(forbidden.expose).toBe(true);

    const tenantMismatch = new TenantMismatchError();
    expect(tenantMismatch.status).toBe(403);
    expect(tenantMismatch.code).toBe('TENANT_MISMATCH');

    const notFound = new NotFoundError();
    expect(notFound.status).toBe(404);
    expect(notFound.code).toBe('FILE_NOT_FOUND');

    const validation = new ValidationError('Bad payload', {
      errors: [{ field: 'name', message: 'required' }],
    });
    expect(validation.status).toBe(422);
    expect(validation.code).toBe('VALIDATION_FAILED');
    expect(validation.errors).toHaveLength(1);

    const tooLarge = new PayloadTooLargeError();
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.code).toBe('FILE_TOO_LARGE');

    const unsupported = new UnsupportedMediaTypeError();
    expect(unsupported.status).toBe(415);
    expect(unsupported.code).toBe('UNSUPPORTED_MEDIA_TYPE');

    const conflict = new ConflictError();
    expect(conflict.status).toBe(409);
    expect(conflict.code).toBe('IDEMPOTENCY_CONFLICT');

    const rateLimited = new RateLimitedError();
    expect(rateLimited.status).toBe(429);
    expect(rateLimited.code).toBe('RATE_LIMITED');

    const storageUnavail = new StorageUnavailableError();
    expect(storageUnavail.status).toBe(503);
    expect(storageUnavail.code).toBe('STORAGE_UNAVAILABLE');
  });

  it('worker errors should have status 500 and expose false', () => {
    const retryable = new RetryableError('broker timeout');
    expect(retryable.status).toBe(500);
    expect(retryable.code).toBe('RETRYABLE_ERROR');
    expect(retryable.expose).toBe(false);

    const permanent = new PermanentError('corrupted payload');
    expect(permanent.status).toBe(500);
    expect(permanent.code).toBe('PERMANENT_ERROR');
    expect(permanent.expose).toBe(false);
  });
});

describe('Error Mapping Utilities', () => {
  it('codeToSlug should convert SCREAMING_SNAKE_CASE to kebab-case', () => {
    expect(codeToSlug('FILE_TOO_LARGE')).toBe('file-too-large');
    expect(codeToSlug('STORAGE_UNAVAILABLE')).toBe('storage-unavailable');
    expect(codeToSlug('VALIDATION_FAILED')).toBe('validation-failed');
  });

  it('codeToTitle should format readable title', () => {
    expect(codeToTitle('FILE_TOO_LARGE')).toBe('File too large');
    expect(codeToTitle('UNAUTHENTICATED')).toBe('Unauthenticated');
  });

  it('mapExceptionToCanonical handles AppError', () => {
    const err = new PayloadTooLargeError('File exceeds 20MB limit', {
      detail: 'File exceeds the 20971520 byte limit for namespace esma-tenant.',
    });
    const canonical = mapExceptionToCanonical(err, 'corr-test-111');

    expect(canonical.status).toBe(413);
    expect(canonical.code).toBe('FILE_TOO_LARGE');
    expect(canonical.title).toBe('File too large');
    expect(canonical.detail).toBe(
      'File exceeds the 20971520 byte limit for namespace esma-tenant.',
    );
    expect(canonical.typeUrl).toBe(
      'https://errors.esma.example/gus/file-too-large',
    );
    expect(canonical.correlationId).toBe('corr-test-111');
  });

  it('mapExceptionToCanonical handles Nest HttpException', () => {
    const nestErr = new HttpException(
      'Forbidden resource',
      HttpStatus.FORBIDDEN,
    );
    const canonical = mapExceptionToCanonical(nestErr, 'corr-test-222');

    expect(canonical.status).toBe(403);
    expect(canonical.code).toBe('FORBIDDEN');
    expect(canonical.correlationId).toBe('corr-test-222');
  });

  it('mapExceptionToCanonical sanitizes unexpected errors', () => {
    const rawErr = new Error('Database password was incorrect');
    const canonical = mapExceptionToCanonical(rawErr, 'corr-test-333');

    expect(canonical.status).toBe(500);
    expect(canonical.code).toBe('INTERNAL');
    expect(canonical.expose).toBe(false);
    expect(canonical.detail).not.toContain('Database password');
  });
});

describe('Filters Execution', () => {
  let mockResponse: {
    status: jest.Mock;
    json: jest.Mock;
    setHeader: jest.Mock;
  };
  let mockRequest: {
    headers: Record<string, string>;
  };
  let mockHost: ArgumentsHost;

  beforeEach(() => {
    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      setHeader: jest.fn().mockReturnThis(),
    };
    mockRequest = {
      headers: {
        'x-correlation-id': 'mock-correlation-id-12345',
      },
    };
    mockHost = {
      switchToHttp: () => ({
        getResponse: () => mockResponse,
        getRequest: () => mockRequest,
      }),
    } as unknown as ArgumentsHost;
  });

  it('ProblemJsonErrorFilter renders RFC 9457 problem+json structure and sets header', () => {
    const filter = new ProblemJsonErrorFilter();
    const error = new PayloadTooLargeError('Too big');

    filter.catch(error, mockHost);

    expect(mockResponse.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'application/problem+json',
    );
    expect(mockResponse.setHeader).toHaveBeenCalledWith(
      'x-correlation-id',
      'mock-correlation-id-12345',
    );
    expect(mockResponse.status).toHaveBeenCalledWith(413);
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'https://errors.esma.example/gus/file-too-large',
        title: 'File too large',
        status: 413,
        code: 'FILE_TOO_LARGE',
        correlationId: 'mock-correlation-id-12345',
      }),
    );
  });

  it('LegacyErrorFilter renders legacy shape', () => {
    const filter = new LegacyErrorFilter();
    const error = new NotFoundError('File not found');

    filter.catch(error, mockHost);

    expect(mockResponse.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'application/json',
    );
    expect(mockResponse.status).toHaveBeenCalledWith(404);
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: 'File not found',
        code: 'FILE_NOT_FOUND',
        correlationId: 'mock-correlation-id-12345',
      }),
    );
  });
});
