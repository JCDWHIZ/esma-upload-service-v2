import { Injectable, Logger } from '@nestjs/common';
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { AppConfigService } from '../config/config.service.js';
import { ValidationError } from '../core/errors/app-error.js';

export type SignedDisposition = 'inline' | 'attachment';

export interface SignUrlOptions {
  expiresInSeconds?: number;
  disposition?: SignedDisposition;
}

export interface SignedUrlResult {
  url: string;
  fileId: string;
  expiresAt: Date;
  exp: number;
  disp: SignedDisposition;
  sig: string;
}

export interface VerifySignatureQuery {
  exp?: string | number;
  disp?: string;
  sig?: string;
}

export interface VerifySignatureResult {
  valid: boolean;
  reason?:
    | 'MISSING_PARAMETERS'
    | 'EXPIRED'
    | 'INVALID_DISPOSITION'
    | 'INVALID_SIGNATURE';
  disposition?: SignedDisposition;
  expiresAt?: Date;
}

@Injectable()
export class SignedUrlService {
  private readonly logger = new Logger(SignedUrlService.name);
  private readonly secret: string;

  constructor(private readonly configService: AppConfigService) {
    this.secret =
      this.configService.signedUrlSecret ||
      'fallback-signed-url-secret-32-chars-at-least';
  }

  /**
   * Generates a cryptographically signed URL allowing time-limited access
   * to a private file without requiring Authorization headers.
   * Conforms to ARCH §4.3 and BACKEND_TASKS P2-07.
   */
  sign(fileId: string, options?: SignUrlOptions): SignedUrlResult {
    if (!fileId || typeof fileId !== 'string' || fileId.trim().length === 0) {
      throw new ValidationError('File ID is required to generate a signed URL');
    }

    const disp: SignedDisposition =
      options?.disposition === 'attachment' ? 'attachment' : 'inline';

    const maxTtl = this.configService.signedUrlMaxTtlSeconds || 900;
    const requestedTtl =
      options?.expiresInSeconds !== undefined && options.expiresInSeconds > 0
        ? options.expiresInSeconds
        : maxTtl;
    const ttl = Math.min(requestedTtl, maxTtl);
    const exp = Math.floor(Date.now() / 1000) + ttl;

    const payload = `v1|${fileId}|${exp}|${disp}`;
    const sig = createHmac('sha256', this.secret)
      .update(payload)
      .digest('base64url');

    const baseUrl = this.configService.appBaseUrl?.replace(/\/$/, '') || '';
    const url = `${baseUrl}/api/v1/files/${encodeURIComponent(fileId)}?exp=${exp}&disp=${disp}&sig=${sig}`;

    return {
      url,
      fileId,
      expiresAt: new Date(exp * 1000),
      exp,
      disp,
      sig,
    };
  }

  /**
   * Verifies the authenticity and validity of query parameters for a signed URL.
   * Performs constant-time comparison to prevent timing side-channel attacks.
   */
  verify(fileId: string, query: VerifySignatureQuery): VerifySignatureResult {
    const { exp, disp, sig } = query;
    if (!exp || !disp || !sig) {
      return { valid: false, reason: 'MISSING_PARAMETERS' };
    }

    if (disp !== 'inline' && disp !== 'attachment') {
      return { valid: false, reason: 'INVALID_DISPOSITION' };
    }

    const expNum =
      typeof exp === 'number' ? Math.floor(exp) : parseInt(String(exp), 10);
    if (isNaN(expNum)) {
      return { valid: false, reason: 'MISSING_PARAMETERS' };
    }

    const nowSec = Math.floor(Date.now() / 1000);
    if (expNum <= nowSec) {
      return { valid: false, reason: 'EXPIRED' };
    }

    const payload = `v1|${fileId}|${expNum}|${disp}`;
    const expectedBase64Url = createHmac('sha256', this.secret)
      .update(payload)
      .digest('base64url');
    const expectedHex = createHmac('sha256', this.secret)
      .update(payload)
      .digest('hex');

    // Constant-time comparison using fixed-size SHA-256 digest of signatures
    const sigHash = createHash('sha256').update(String(sig)).digest();
    const expectedBase64UrlHash = createHash('sha256')
      .update(expectedBase64Url)
      .digest();
    const expectedHexHash = createHash('sha256').update(expectedHex).digest();

    const matchesBase64Url = timingSafeEqual(sigHash, expectedBase64UrlHash);
    const matchesHex = timingSafeEqual(sigHash, expectedHexHash);

    if (!matchesBase64Url && !matchesHex) {
      return { valid: false, reason: 'INVALID_SIGNATURE' };
    }

    return {
      valid: true,
      disposition: disp,
      expiresAt: new Date(expNum * 1000),
    };
  }
}
