import { describe, it, expect } from 'vitest';
import { ZodValidationPipe } from '../../src/common/pipes/zod-validation.pipe.js';
import { ValidationError } from '../../src/core/errors/app-error.js';
import {
  fileIdParamSchema,
  fileListQuerySchema,
  fileReadQuerySchema,
  createSignedUrlSchema,
  bulkDeleteSchema,
  fileUploadMetadataSchema,
} from '../../src/files/dto/files.dto.js';

describe('ZodValidationPipe and DTO Schemas', () => {
  describe('1. ZodValidationPipe generic behavior', () => {
    it('passes valid input and returns parsed data', () => {
      const pipe = new ZodValidationPipe(fileIdParamSchema);
      const output = pipe.transform({ fileId: 'valid-file-uuid' });
      expect(output).toEqual({ fileId: 'valid-file-uuid' });
    });

    it('throws ValidationError with 422 status and structured errors on failure', () => {
      const pipe = new ZodValidationPipe(fileIdParamSchema);
      expect(() => pipe.transform({ fileId: '' })).toThrow(ValidationError);

      try {
        pipe.transform({ fileId: '' });
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(ValidationError);
        const valErr = err as ValidationError;
        expect(valErr.status).toBe(422);
        expect(valErr.code).toBe('VALIDATION_FAILED');
        expect(valErr.errors).toBeDefined();
        expect(Array.isArray(valErr.errors)).toBe(true);
      }
    });
  });

  describe('2. fileListQuerySchema', () => {
    const pipe = new ZodValidationPipe(fileListQuerySchema);

    it('transforms default limit to 20 when omitted', () => {
      const res = pipe.transform({}) as { limit: number };
      expect(res.limit).toBe(20);
    });

    it('clamps limit to maximum 100', () => {
      const res = pipe.transform({ limit: '250' }) as { limit: number };
      expect(res.limit).toBe(100);
    });

    it('parses valid folder and tag filters', () => {
      const res = pipe.transform({
        folder: 'academic/2026',
        tag: 'report',
        limit: '15',
      }) as { folder: string; tag: string; limit: number };

      expect(res.folder).toBe('academic/2026');
      expect(res.tag).toBe('report');
      expect(res.limit).toBe(15);
    });
  });

  describe('3. fileReadQuerySchema', () => {
    const pipe = new ZodValidationPipe(fileReadQuerySchema);

    it('validates allowed redirect and disposition values', () => {
      const res = pipe.transform({
        redirect: 'always',
        disp: 'inline',
        sig: 'abc123sig',
        exp: '1790000000',
      }) as { redirect: string; disp: string };

      expect(res.redirect).toBe('always');
      expect(res.disp).toBe('inline');
    });

    it('rejects invalid redirect enum value', () => {
      expect(() => pipe.transform({ redirect: 'invalid-mode' })).toThrow(
        ValidationError,
      );
    });
  });

  describe('4. createSignedUrlSchema', () => {
    const pipe = new ZodValidationPipe(createSignedUrlSchema);

    it('accepts valid expiresInSeconds and disposition', () => {
      const res = pipe.transform({
        expiresInSeconds: 3600,
        disposition: 'attachment',
      }) as { expiresInSeconds: number; disposition: string };

      expect(res.expiresInSeconds).toBe(3600);
      expect(res.disposition).toBe('attachment');
    });

    it('rejects expiresInSeconds exceeding 7 days', () => {
      expect(() => pipe.transform({ expiresInSeconds: 1000000 })).toThrow(
        ValidationError,
      );
    });
  });

  describe('5. bulkDeleteSchema', () => {
    const pipe = new ZodValidationPipe(bulkDeleteSchema);

    it('accepts array of valid fileIds', () => {
      const res = pipe.transform({
        fileIds: ['id-1', 'id-2'],
      }) as { fileIds: string[] };

      expect(res.fileIds).toEqual(['id-1', 'id-2']);
    });

    it('rejects empty fileIds array', () => {
      expect(() => pipe.transform({ fileIds: [] })).toThrow(ValidationError);
    });

    it('rejects array with empty strings', () => {
      expect(() => pipe.transform({ fileIds: [''] })).toThrow(ValidationError);
    });

    it('rejects more than 100 fileIds', () => {
      const ids = Array.from({ length: 101 }, (_, i) => `id-${i}`);
      expect(() => pipe.transform({ fileIds: ids })).toThrow(ValidationError);
    });
  });

  describe('6. fileUploadMetadataSchema', () => {
    const pipe = new ZodValidationPipe(fileUploadMetadataSchema);

    it('transforms JSON string tags into array', () => {
      const res = pipe.transform({
        tags: '["docs", "finance"]',
      }) as { tags?: string[] };

      expect(res.tags).toEqual(['docs', 'finance']);
    });

    it('transforms comma-separated string tags into array', () => {
      const res = pipe.transform({
        tags: 'math, science, physics',
      }) as { tags?: string[] };

      expect(res.tags).toEqual(['math', 'science', 'physics']);
    });

    it('transforms JSON string attributes into key-value map', () => {
      const res = pipe.transform({
        attributes: '{"dept": "hr", "year": 2026}',
      }) as { attributes?: Record<string, string> };

      expect(res.attributes).toEqual({ dept: 'hr', year: '2026' });
    });

    it('transforms string boolean atomic flag', () => {
      const res = pipe.transform({
        atomic: 'true',
      }) as { atomic?: boolean };

      expect(res.atomic).toBe(true);
    });
  });
});
