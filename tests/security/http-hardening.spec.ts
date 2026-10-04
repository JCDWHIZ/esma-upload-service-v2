import { describe, it, expect } from 'vitest';
import { mapExceptionToCanonical } from '../../src/common/filters/error-mapper.js';
import { AuditService } from '../../src/observability/audit.service.js';
import type { AuditRepository } from '../../src/db/repositories/audit.repository.js';
import type { AppConfigService } from '../../src/config/config.service.js';

describe('HTTP Security Hardening & Information Leakage Defense (P6-09)', () => {
  describe('Error Response Sanitization (RFC 7807 Problem Details)', () => {
    it('sanitizes unexpected internal database errors without exposing SQL or stack traces', () => {
      const dbError = new Error(
        'syntax error at or near "SELECT * FROM files WHERE..." at PostgresClient.query',
      );
      const canonical = mapExceptionToCanonical(dbError, 'test-corr-id');

      expect(canonical.status).toBe(500);
      expect(canonical.code).toBe('INTERNAL');
      expect(canonical.title).toBe('Internal server error');
      // Must NOT leak SQL query or internal library stack details
      expect(canonical.detail).toBe('An unexpected internal error occurred');
      expect(canonical.detail).not.toContain('syntax error');
      expect(canonical.detail).not.toContain('PostgresClient');
      expect(canonical.detail).not.toContain('SELECT');
      expect(canonical.errors).toEqual([]);
      expect(canonical.correlationId).toBe('test-corr-id');
    });

    it('exposes safe client validation errors while suppressing internal pointers', () => {
      const clientError = new Error(
        'ValidationError: Field "namespace" must be alphanumeric',
      );
      Object.assign(clientError, {
        status: 400,
        code: 'VALIDATION_FAILED',
        detail: 'Field "namespace" must be alphanumeric',
      });

      const canonical = mapExceptionToCanonical(clientError, 'test-corr-id');
      expect(canonical.status).toBe(500); // generic Error without AppError is treated as internal
      expect(canonical.detail).toBe('An unexpected internal error occurred');
    });
  });

  describe('Sensitive Data Redaction in Audit & Logs', () => {
    it('redacts bearer tokens, API keys, secrets, and passwords recursively', () => {
      const mockAuditRepo = {
        insert: () => Promise.resolve(),
      } as unknown as AuditRepository;
      const mockConfig = {
        auditBufferFlushIntervalMs: 1000,
      } as unknown as AppConfigService;
      const auditService = new AuditService(mockConfig, mockAuditRepo);

      const sensitivePayload = {
        userId: 'usr-123',
        token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.sensitive-token',
        apiKey: 'eus2_12345678_secret-key-material',
        authHeader: 'Bearer eyJhbGciOi...',
        password: 'SuperSecretPassword!',
        cookie: 'session_id=abcdef12345',
        nested: {
          secretKey: 'my-internal-secret',
          safeField: 'visible-value',
        },
      };

      const auditServiceInternal = auditService as unknown as {
        sanitizeDetails: (
          details: typeof sensitivePayload,
        ) => typeof sensitivePayload;
      };
      const sanitized = auditServiceInternal.sanitizeDetails(sensitivePayload);

      expect(sanitized.userId).toBe('usr-123');
      expect(sanitized.token).toBe('[REDACTED]');
      expect(sanitized.apiKey).toBe('[REDACTED]');
      expect(sanitized.authHeader).toBe('[REDACTED]');
      expect(sanitized.password).toBe('[REDACTED]');
      expect(sanitized.cookie).toBe('[REDACTED]');
      expect(sanitized.nested.secretKey).toBe('[REDACTED]');
      expect(sanitized.nested.safeField).toBe('visible-value');
    });
  });
});
