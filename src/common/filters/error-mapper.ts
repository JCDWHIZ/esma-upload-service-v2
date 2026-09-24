import { HttpStatus, HttpException } from '@nestjs/common';
import { AppError } from '../../core/errors/app-error.js';
import { getCorrelationId } from '../../observability/correlation-context.js';

export interface CanonicalError {
  status: number;
  code: string;
  title: string;
  detail: string;
  errors: unknown[];
  correlationId: string;
  typeUrl: string;
  expose: boolean;
}

export function codeToSlug(code: string): string {
  return code.toLowerCase().replace(/_/g, '-');
}

export function codeToTitle(code: string): string {
  return code
    .toLowerCase()
    .split('_')
    .map((word, i) =>
      i === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word,
    )
    .join(' ');
}

const STATUS_TO_ERROR_CODE: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'BAD_REQUEST',
  [HttpStatus.UNAUTHORIZED]: 'UNAUTHENTICATED',
  [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'FILE_TOO_LARGE',
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: 'UNSUPPORTED_MEDIA_TYPE',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'VALIDATION_FAILED',
  [HttpStatus.TOO_MANY_REQUESTS]: 'RATE_LIMITED',
  [HttpStatus.NOT_IMPLEMENTED]: 'NOT_IMPLEMENTED',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'STORAGE_UNAVAILABLE',
};

export function httpStatusToErrorCode(status: number): string {
  return STATUS_TO_ERROR_CODE[status] ?? 'INTERNAL';
}

export function mapExceptionToCanonical(
  exception: unknown,
  fallbackCorrelationId = 'unknown',
): CanonicalError {
  const correlationId = getCorrelationId() || fallbackCorrelationId;

  if (exception instanceof AppError) {
    return {
      status: exception.status,
      code: exception.code,
      title: codeToTitle(exception.code),
      detail: exception.detail || exception.message,
      errors: exception.errors,
      correlationId: exception.correlationId || correlationId,
      typeUrl: `https://errors.esma.example/gus/${codeToSlug(exception.code)}`,
      expose: exception.expose,
    };
  }

  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const res = exception.getResponse();
    let message = exception.message;
    let code = httpStatusToErrorCode(status);
    let errors: unknown[] = [];

    if (typeof res === 'string') {
      message = res;
    } else if (typeof res === 'object' && res !== null) {
      const resObj = res as Record<string, unknown>;
      if (typeof resObj.error === 'string') {
        code = resObj.error.toUpperCase().replace(/\s+/g, '_');
      }
      if (Array.isArray(resObj.message)) {
        errors = resObj.message;
        message = resObj.message.join(', ');
      } else if (typeof resObj.message === 'string') {
        message = resObj.message;
      }
    }

    return {
      status,
      code,
      title: codeToTitle(code),
      detail: message,
      errors,
      correlationId,
      typeUrl: `https://errors.esma.example/gus/${codeToSlug(code)}`,
      expose: status < 500,
    };
  }

  if (exception instanceof Error) {
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL',
      title: 'Internal server error',
      detail: 'An unexpected internal error occurred',
      errors: [],
      correlationId,
      typeUrl: 'https://errors.esma.example/gus/internal',
      expose: false,
    };
  }

  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    code: 'INTERNAL',
    title: 'Internal server error',
    detail: 'An unexpected error occurred',
    errors: [],
    correlationId,
    typeUrl: 'https://errors.esma.example/gus/internal',
    expose: false,
  };
}
