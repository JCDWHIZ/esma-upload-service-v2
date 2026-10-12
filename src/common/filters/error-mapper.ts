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
  headers?: Record<string, string>;
  extensions?: Record<string, unknown>;
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

const CANONICAL_ERROR_CODES: Record<string, { code: string; status?: number }> = {
  unauthenticated: { code: 'unauthenticated', status: 401 },
  token_revoked: { code: 'token_revoked', status: 401 },
  token_stale: { code: 'token_stale', status: 401 },
  forbidden: { code: 'forbidden', status: 403 },
  organization_required: { code: 'organization_required', status: 400 },
  organization_mismatch: { code: 'organization_mismatch', status: 403 },
  namespace_unknown: { code: 'namespace_unknown', status: 400 },
  namespace_not_allowed: { code: 'namespace_not_allowed', status: 403 },
  not_found: { code: 'not_found', status: 404 },
  scan_pending: { code: 'scan_pending', status: 409 },
  file_infected: { code: 'file_infected', status: 422 },
  scan_unavailable: { code: 'scan_unavailable', status: 503 },
  idempotency_conflict: { code: 'idempotency_conflict', status: 409 },
  payload_too_large: { code: 'payload_too_large', status: 413 },
  unsupported_media_type: { code: 'unsupported_media_type', status: 415 },
  validation_failed: { code: 'validation_failed', status: 422 },
  quota_exceeded: { code: 'quota_exceeded', status: 507 },
  tenant_suspended: { code: 'tenant_suspended', status: 403 },
  tenant_purging: { code: 'tenant_purging', status: 403 },
  rate_limited: { code: 'rate_limited', status: 429 },
  legal_hold: { code: 'legal_hold', status: 409 },
  already_claimed: { code: 'already_claimed', status: 409 },
  too_many_pending_uploads: { code: 'too_many_pending_uploads', status: 429 },
  unexpected: { code: 'unexpected', status: 500 },
  // Legacy alias mapping:
  unauthenticated_err: { code: 'unauthenticated', status: 401 },
  tenant_mismatch: { code: 'organization_mismatch', status: 403 },
  file_not_found: { code: 'not_found', status: 404 },
  file_too_large: { code: 'payload_too_large', status: 413 },
  mime_mismatch: { code: 'unsupported_media_type', status: 415 },
  file_quarantined: { code: 'file_infected', status: 422 },
  storage_unavailable: { code: 'scan_unavailable', status: 503 },
  clamav_error: { code: 'scan_unavailable', status: 503 },
  bad_request: { code: 'validation_failed', status: 400 },
  internal: { code: 'unexpected', status: 500 },
};

const STATUS_TO_CANONICAL_CODE: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'validation_failed',
  [HttpStatus.UNAUTHORIZED]: 'unauthenticated',
  [HttpStatus.FORBIDDEN]: 'forbidden',
  [HttpStatus.NOT_FOUND]: 'not_found',
  [HttpStatus.CONFLICT]: 'idempotency_conflict',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'payload_too_large',
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: 'unsupported_media_type',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'validation_failed',
  [HttpStatus.TOO_MANY_REQUESTS]: 'rate_limited',
  507: 'quota_exceeded',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'scan_unavailable',
  [HttpStatus.INTERNAL_SERVER_ERROR]: 'unexpected',
};

function sanitizeDetail(detail: string, status: number, expose: boolean): string {
  if (status >= 500 && !expose) {
    return 'An unexpected internal error occurred';
  }
  // Sanitize stack traces or SQL details
  if (detail.includes('\n') || detail.includes('    at ') || /\b(select|insert|update|delete)\b.*from/i.test(detail)) {
    return status >= 500 ? 'An unexpected internal error occurred' : 'Request validation failed';
  }
  return detail;
}

export function mapExceptionToCanonical(
  exception: unknown,
  fallbackCorrelationId = 'unknown',
): CanonicalError {
  const correlationId = getCorrelationId() || fallbackCorrelationId;

  if (exception instanceof AppError) {
    const rawKey = exception.code.toLowerCase();
    const mapped = CANONICAL_ERROR_CODES[rawKey];
    const canonicalCode = mapped ? mapped.code : rawKey;
    const status = mapped?.status ?? exception.status;
    const detail = sanitizeDetail(exception.detail || exception.message, status, exception.expose);

    const extensions: Record<string, unknown> = {};
    if ('quotaBytes' in exception && (exception as Record<string, unknown>).quotaBytes !== undefined) {
      extensions.quotaBytes = (exception as Record<string, unknown>).quotaBytes;
    }
    if ('usedBytes' in exception && (exception as Record<string, unknown>).usedBytes !== undefined) {
      extensions.usedBytes = (exception as Record<string, unknown>).usedBytes;
    }
    if ('requestedBytes' in exception && (exception as Record<string, unknown>).requestedBytes !== undefined) {
      extensions.requestedBytes = (exception as Record<string, unknown>).requestedBytes;
    }

    return {
      status,
      code: canonicalCode,
      title: codeToTitle(canonicalCode),
      detail,
      errors: exception.errors,
      correlationId: exception.correlationId || correlationId,
      typeUrl: `urn:esma:files:error:${canonicalCode}`,
      expose: exception.expose,
      headers: exception.headers,
      extensions: Object.keys(extensions).length > 0 ? extensions : undefined,
    };
  }

  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const res = exception.getResponse();
    let message = exception.message;
    let rawCode = STATUS_TO_CANONICAL_CODE[status] ?? 'unexpected';
    let errors: unknown[] = [];

    if (typeof res === 'string') {
      message = res;
    } else if (typeof res === 'object' && res !== null) {
      const resObj = res as Record<string, unknown>;
      if (typeof resObj.error === 'string') {
        rawCode = resObj.error.toLowerCase().replace(/[\s-]+/g, '_');
      }
      if (Array.isArray(resObj.message)) {
        errors = resObj.message;
        message = resObj.message.join(', ');
      } else if (typeof resObj.message === 'string') {
        message = resObj.message;
      }
    }

    const mapped = CANONICAL_ERROR_CODES[rawCode];
    const canonicalCode = mapped ? mapped.code : (STATUS_TO_CANONICAL_CODE[status] ?? 'unexpected');
    const detail = sanitizeDetail(message, status, status < 500);

    return {
      status,
      code: canonicalCode,
      title: codeToTitle(canonicalCode),
      detail,
      errors,
      correlationId,
      typeUrl: `urn:esma:files:error:${canonicalCode}`,
      expose: status < 500,
    };
  }

  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    code: 'unexpected',
    title: 'Unexpected',
    detail: 'An unexpected internal error occurred',
    errors: [],
    correlationId,
    typeUrl: 'urn:esma:files:error:unexpected',
    expose: false,
  };
}
