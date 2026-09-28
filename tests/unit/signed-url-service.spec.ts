import { describe, it, expect, beforeEach } from 'vitest';
import { AppConfigService } from '../../src/config/config.service.js';
import { SignedUrlService } from '../../src/files/signed-url.service.js';
import { ValidationError } from '../../src/core/errors/app-error.js';

describe('SignedUrlService Unit Tests [P2-07]', () => {
  let service: SignedUrlService;
  let mockConfigService: AppConfigService;

  beforeEach(() => {
    mockConfigService = {
      signedUrlSecret: 'very-secret-test-key-32-chars-long-minimum-size',
      signedUrlMaxTtlSeconds: 900,
      appBaseUrl: 'https://cdn.example.com',
    } as unknown as AppConfigService;

    service = new SignedUrlService(mockConfigService);
  });

  describe('sign', () => {
    it('generates a valid signed URL with default parameters', () => {
      const result = service.sign('0198f3a2-7c1e-7b40-9d2a-5e6f1a8c0001');

      expect(result.fileId).toBe('0198f3a2-7c1e-7b40-9d2a-5e6f1a8c0001');
      expect(result.disp).toBe('inline');
      expect(result.sig).toBeDefined();
      expect(typeof result.sig).toBe('string');
      expect(result.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
      expect(result.url).toContain(
        'https://cdn.example.com/api/v1/files/0198f3a2-7c1e-7b40-9d2a-5e6f1a8c0001',
      );
      expect(result.url).toContain(`exp=${result.exp}`);
      expect(result.url).toContain('disp=inline');
      expect(result.url).toContain(`sig=${result.sig}`);
    });

    it('respects requested disposition', () => {
      const result = service.sign('0198f3a2-7c1e-7b40-9d2a-5e6f1a8c0001', {
        disposition: 'attachment',
      });
      expect(result.disp).toBe('attachment');
      expect(result.url).toContain('disp=attachment');
    });

    it('clamps requested TTL to maxTtlSeconds', () => {
      const now = Math.floor(Date.now() / 1000);
      const result = service.sign('0198f3a2-7c1e-7b40-9d2a-5e6f1a8c0001', {
        expiresInSeconds: 3600, // exceeds 900
      });

      // Should be clamped to 900s
      expect(result.exp).toBeLessThanOrEqual(now + 900 + 2);
      expect(result.exp).toBeGreaterThanOrEqual(now + 899);
    });

    it('rejects empty or invalid fileId', () => {
      expect(() => service.sign('')).toThrow(ValidationError);
      expect(() => service.sign('   ')).toThrow(ValidationError);
    });
  });

  describe('verify and tamper matrix', () => {
    it('verifies a freshly generated signed URL', () => {
      const signed = service.sign('file-123', { disposition: 'inline' });
      const verifyRes = service.verify('file-123', {
        exp: signed.exp,
        disp: signed.disp,
        sig: signed.sig,
      });

      expect(verifyRes.valid).toBe(true);
      expect(verifyRes.disposition).toBe('inline');
      expect(verifyRes.expiresAt).toEqual(signed.expiresAt);
    });

    it('rejects expired signature', () => {
      const pastTime = Math.floor(Date.now() / 1000) - 100;
      const verifyRes = service.verify('file-123', {
        exp: pastTime,
        disp: 'inline',
        sig: 'some-signature',
      });

      expect(verifyRes.valid).toBe(false);
      expect(verifyRes.reason).toBe('EXPIRED');
    });

    it('rejects signature replayed for another file ID', () => {
      const signed = service.sign('file-original', { disposition: 'inline' });
      const verifyRes = service.verify('file-attack-target', {
        exp: signed.exp,
        disp: signed.disp,
        sig: signed.sig,
      });

      expect(verifyRes.valid).toBe(false);
      expect(verifyRes.reason).toBe('INVALID_SIGNATURE');
    });

    it('rejects tampered disposition parameter', () => {
      const signed = service.sign('file-123', { disposition: 'inline' });
      const verifyRes = service.verify('file-123', {
        exp: signed.exp,
        disp: 'attachment', // changed from inline
        sig: signed.sig,
      });

      expect(verifyRes.valid).toBe(false);
      expect(verifyRes.reason).toBe('INVALID_SIGNATURE');
    });

    it('rejects invalid disposition string', () => {
      const verifyRes = service.verify('file-123', {
        exp: Math.floor(Date.now() / 1000) + 300,
        disp: 'invalid-disposition',
        sig: 'some-sig',
      });

      expect(verifyRes.valid).toBe(false);
      expect(verifyRes.reason).toBe('INVALID_DISPOSITION');
    });

    it('rejects corrupted signature bytes without leaking timing or throwing', () => {
      const signed = service.sign('file-123', { disposition: 'inline' });
      const tamperedSig = signed.sig.slice(0, -2) + 'xx';

      const verifyRes = service.verify('file-123', {
        exp: signed.exp,
        disp: signed.disp,
        sig: tamperedSig,
      });

      expect(verifyRes.valid).toBe(false);
      expect(verifyRes.reason).toBe('INVALID_SIGNATURE');
    });

    it('rejects missing parameters gracefully', () => {
      expect(service.verify('file-123', {}).valid).toBe(false);
      expect(service.verify('file-123', { exp: 9999999999 }).valid).toBe(false);
      expect(
        service.verify('file-123', { exp: 9999999999, disp: 'inline' }).valid,
      ).toBe(false);
      expect(
        service.verify('file-123', {
          exp: 'not-a-number',
          disp: 'inline',
          sig: 'abc',
        }).valid,
      ).toBe(false);
    });
  });
});
