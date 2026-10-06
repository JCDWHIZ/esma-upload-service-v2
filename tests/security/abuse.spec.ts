import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  sniffMagicBytes,
  assertMimeCompatibility,
} from '../../src/ingest/sniff.js';
import { sanitizeFilename } from '../../src/ingest/sanitize.js';
import { SignedUrlService } from '../../src/files/signed-url.service.js';
import { MimeMismatchError } from '../../src/core/errors/app-error.js';
import { parseRangeHeader } from '../../src/files/file-read.service.js';
import { TEST_JWT_SECRET, signToken, tokens } from '../helpers/tokens.js';
import { JwtVerifierService } from '../../src/auth/jwt/jwt-verifier.service.js';
import { ApiKeyAuthenticatorService } from '../../src/auth/apikey/apikey-authenticator.service.js';
import type { AppConfigService } from '../../src/config/config.service.js';
import type { ApiClientRepository } from '../../src/db/repositories/api-client.repository.js';

describe('Security Abuse & Malicious Vector Suite (P6-09)', () => {
  // ── 1. Polyglot & Executable Spoofing ───────────────────────────────────────
  describe('Polyglot & Malicious Binary Detection', () => {
    it('detects Windows PE executable hidden under .pdf filename (MZ header)', () => {
      // 4D 5A = MZ
      const peExecutableBuffer = Buffer.from([
        0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00,
      ]);
      const detected = sniffMagicBytes(
        peExecutableBuffer,
        'application/pdf',
        'invoice.pdf',
      );

      expect(detected).not.toBeNull();
      expect(detected?.mime).toBe('application/x-msdownload');
      expect(detected?.ext).toBe('.exe');

      // Assert mismatch throws MimeMismatchError
      expect(() => {
        assertMimeCompatibility(
          detected!.mime,
          'application/pdf',
          'invoice.pdf',
        );
      }).toThrow(MimeMismatchError);
    });

    it('detects Linux ELF binary disguised as .png image', () => {
      // 7F 45 4C 46 = 0x7f 'ELF'
      const elfBuffer = Buffer.from([
        0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00,
      ]);
      const detected = sniffMagicBytes(elfBuffer, 'image/png', 'photo.png');

      expect(detected).not.toBeNull();
      expect(detected?.mime).toBe('application/x-executable');
      expect(detected?.ext).toBe('.elf');

      expect(() => {
        assertMimeCompatibility(detected!.mime, 'image/png', 'photo.png');
      }).toThrow(MimeMismatchError);
    });

    it('detects shell script starting with #!/bin/sh', () => {
      const scriptBuffer = Buffer.from('#!/bin/sh\nrm -rf /', 'ascii');
      const detected = sniffMagicBytes(
        scriptBuffer,
        'text/plain',
        'script.txt',
      );

      expect(detected).not.toBeNull();
      expect(detected?.mime).toBe('application/x-sh');
      expect(detected?.ext).toBe('.sh');
    });

    it('rejects declared image/png when magic bytes are application/pdf', () => {
      const pdfBuffer = Buffer.from('%PDF-1.4\n1 0 obj', 'ascii');
      const detected = sniffMagicBytes(pdfBuffer, 'image/png', 'fake.png');

      expect(detected?.mime).toBe('application/pdf');
      expect(() => {
        assertMimeCompatibility(detected!.mime, 'image/png', 'fake.png');
      }).toThrow(MimeMismatchError);
    });
  });

  // ── 2. Filename Header Injection & Path Traversal ───────────────────────────
  describe('Filename Sanitization & Injection Defense', () => {
    it('strips CRLF injection characters to prevent HTTP response splitting', () => {
      const maliciousName = 'innocent.pdf\r\nX-Injected: malicious';
      const sanitized = sanitizeFilename(maliciousName);

      expect(sanitized).not.toContain('\r');
      expect(sanitized).not.toContain('\n');
      expect(sanitized).toBe('innocent.pdfX-Injected: malicious');
    });

    it('neutralizes POSIX and Windows directory traversal attacks', () => {
      expect(sanitizeFilename('../../../../etc/passwd')).toBe('passwd');
      expect(sanitizeFilename('..\\..\\windows\\system32\\cmd.exe')).toBe(
        'cmd.exe',
      );
      expect(sanitizeFilename('///secret/passwords.txt')).toBe('passwords.txt');
      expect(sanitizeFilename('....//....//config.json')).toBe('config.json');
    });

    it('strips null bytes used to bypass extension checks', () => {
      const nullByteName = 'exploit.pdf\0.exe';
      const sanitized = sanitizeFilename(nullByteName);

      expect(sanitized).not.toContain('\0');
      expect(sanitized).toBe('exploit.pdf.exe');
    });

    it('caps total filename byte length at 255 bytes to prevent filesystem denial-of-service', () => {
      const superLongName = `${'A'.repeat(300)}.pdf`;
      const sanitized = sanitizeFilename(superLongName);

      const byteLength = Buffer.byteLength(sanitized, 'utf8');
      expect(byteLength).toBeLessThanOrEqual(255);
      expect(sanitized.endsWith('.pdf')).toBe(true);
    });
  });

  // ── 3. HTTP Range Request Abuse Defense ─────────────────────────────────────
  describe('HTTP Range Header Abuse Defense', () => {
    const totalSize = 10000;

    it('clamps suffix range (bytes=-500) to the last 500 bytes', () => {
      const parsed = parseRangeHeader('bytes=-500', totalSize);
      expect(parsed).not.toBeNull();
      expect(parsed?.start).toBe(9500);
      expect(parsed?.end).toBe(9999);
      expect(parsed?.contentLength).toBe(500);
    });

    it('clamps prefix range (bytes=9000-) to the end of file', () => {
      const parsed = parseRangeHeader('bytes=9000-', totalSize);
      expect(parsed).not.toBeNull();
      expect(parsed?.start).toBe(9000);
      expect(parsed?.end).toBe(9999);
      expect(parsed?.contentLength).toBe(1000);
    });

    it('returns null (416 Range Not Satisfiable) for inverted ranges', () => {
      // start > end is syntactically invalid
      const parsed = parseRangeHeader('bytes=500-200', totalSize);
      expect(parsed).toBeNull();
    });

    it('returns null (416 Range Not Satisfiable) for out-of-bounds start range', () => {
      const parsed = parseRangeHeader('bytes=15000-20000', totalSize);
      expect(parsed).toBeNull();
    });

    it('returns null for malformed or non-byte range units', () => {
      expect(parseRangeHeader('items=0-10', totalSize)).toBeNull();
      expect(parseRangeHeader('bytes=invalid-range', totalSize)).toBeNull();
      expect(parseRangeHeader('', totalSize)).toBeNull();
    });
  });

  // ── 4. Signed URL Tampering & Replay Defense ────────────────────────────────
  describe('Signed URL Tampering & Replay Defense', () => {
    let signedUrlService: SignedUrlService;
    const mockConfig = {
      signedUrlSecret: 'enterprise-test-secret-at-least-32-chars-long-12345!',
    } as unknown as AppConfigService;

    beforeEach(() => {
      signedUrlService = new SignedUrlService(mockConfig);
    });

    it('validates a correctly signed URL', () => {
      const signed = signedUrlService.sign('file-123', {
        expiresInSeconds: 60,
        disposition: 'attachment',
      });

      const verified = signedUrlService.verify('file-123', {
        exp: signed.exp,
        disp: signed.disp,
        sig: signed.sig,
      });

      expect(verified.valid).toBe(true);
      expect(verified.disposition).toBe('attachment');
    });

    it('rejects tampered signature hash', () => {
      const signed = signedUrlService.sign('file-123', {
        expiresInSeconds: 60,
      });

      // Change one character in HMAC signature
      const tamperedSig =
        signed.sig.slice(0, -1) + (signed.sig.endsWith('a') ? 'b' : 'a');

      const verified = signedUrlService.verify('file-123', {
        exp: signed.exp,
        disp: signed.disp,
        sig: tamperedSig,
      });

      expect(verified.valid).toBe(false);
      expect(verified.reason).toBe('INVALID_SIGNATURE');
    });

    it('rejects expired signed URLs (replay prevention)', () => {
      const pastExp = Math.floor(Date.now() / 1000) - 30; // expired 30 seconds ago
      const verified = signedUrlService.verify('file-123', {
        exp: pastExp,
        disp: 'inline',
        sig: 'dummy-signature',
      });

      expect(verified.valid).toBe(false);
      expect(verified.reason).toBe('EXPIRED');
    });

    it('rejects signature reuse for a different fileId', () => {
      const signedFileA = signedUrlService.sign('file-A', {
        expiresInSeconds: 60,
      });

      // Attacker tries to use file-A's signature to download private file-B
      const verified = signedUrlService.verify('file-B', {
        exp: signedFileA.exp,
        disp: signedFileA.disp,
        sig: signedFileA.sig,
      });

      expect(verified.valid).toBe(false);
      expect(verified.reason).toBe('INVALID_SIGNATURE');
    });
  });

  // ── 5. JWT Algorithm Confusion Defense ──────────────────────────────────────
  describe('JWT Security & Algorithm Confusion Defense', () => {
    let jwtVerifier: JwtVerifierService;
    const mockConfig = {
      get: () => ({
        JWT_SECRET: TEST_JWT_SECRET,
        JWT_ALGORITHMS: 'HS256',
        IDENTITY_ISSUER: 'https://auth.esma.test',
        JWT_CLOCK_TOLERANCE_SECONDS: 5,
      }),
    } as unknown as AppConfigService;

    beforeEach(() => {
      jwtVerifier = new JwtVerifierService(mockConfig);
    });

    it('rejects JWT signed with "none" algorithm', async () => {
      // Header: {"alg":"none","typ":"JWT"}
      const noneHeader = Buffer.from('{"alg":"none","typ":"JWT"}').toString(
        'base64url',
      );
      const payload = Buffer.from('{"sub":"attacker","role":"admin"}').toString(
        'base64url',
      );
      const noneToken = `${noneHeader}.${payload}.`;

      await expect(jwtVerifier.verifyToken(noneToken)).rejects.toThrow();
    });

    it('rejects JWT signed with an untrusted / foreign secret', async () => {
      const forgedToken = await signToken(
        { userId: 'usr-attacker', role: 'admin' },
        {
          secret: 'wrong-secret-key-that-should-never-be-accepted-by-service!',
        },
      );

      await expect(jwtVerifier.verifyToken(forgedToken)).rejects.toThrow();
    });

    it('rejects expired JWT token', async () => {
      const expiredToken = await tokens.expired();
      await expect(jwtVerifier.verifyToken(expiredToken)).rejects.toThrow();
    });
  });

  // ── 6. API Key Syntax & Lockout Defense ──────────────────────────────────────
  describe('API Key Format & Lockout Defense', () => {
    it('fast-rejects malformed API keys before database lookup', async () => {
      const mockRepo = { findByPrefixAndHash: vi.fn() };
      const service = new ApiKeyAuthenticatorService(
        mockRepo as unknown as ApiClientRepository,
      );

      // Malformed keys: missing prefix, bad characters, SQL injection string
      const invalidKeys = [
        'not_an_api_key',
        'eus2_short',
        'eus2_12345678_short',
        "' OR '1'='1",
        'Bearer token_123',
      ];

      for (const key of invalidKeys) {
        await expect(service.authenticate(key)).rejects.toThrow();
      }

      // Proves DB was NEVER hit for malformed keys (fast rejection defense against DOS)
      expect(mockRepo.findByPrefixAndHash).not.toHaveBeenCalled();
    });
  });
});
