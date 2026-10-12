import { Injectable, Logger } from '@nestjs/common';
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { AppConfigService } from '../config/config.service.js';
import { ValidationError } from '../core/errors/app-error.js';

export type SignedDisposition = 'inline' | 'attachment';

export interface SignUrlOptions {
  expiresInSeconds?: number;
  ttlSeconds?: number;
  disposition?: SignedDisposition;
  organizationId?: string;
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
   * Conforms to ARCH §4.3 and UR-04.
   */
  sign(fileId: string, options?: SignUrlOptions): SignedUrlResult {
    if (!fileId || typeof fileId !== 'string' || fileId.trim().length === 0) {
      throw new ValidationError('File ID is required to generate a signed URL');
    }

    const disp: SignedDisposition =
      options?.disposition === 'attachment' ? 'attachment' : 'inline';

    const maxTtl = this.configService.signedUrlMaxTtlSeconds || 600;
    const requestedTtl =
      options?.expiresInSeconds !== undefined && options.expiresInSeconds > 0
        ? options.expiresInSeconds
        : options?.ttlSeconds !== undefined && options.ttlSeconds > 0
          ? options.ttlSeconds
          : maxTtl;
    const ttl = Math.min(requestedTtl, maxTtl);
    const exp = Math.floor(Date.now() / 1000) + ttl;

    const payload = options?.organizationId
      ? `v2|${fileId}|${exp}|${disp}|${options.organizationId}`
      : `v1|${fileId}|${exp}|${disp}`;

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
   * Covers organizationId when provided (UR-04) and supports SIGNED_URL_SECRET_PREVIOUS rotation.
   */
  verify(
    fileId: string,
    query: VerifySignatureQuery,
    organizationId?: string,
  ): VerifySignatureResult {
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

    // Candidate payloads: v2 binds organizationId, v1 fallback for un-scoped tokens
    const candidatePayloads: string[] = [];
    if (organizationId) {
      candidatePayloads.push(
        `v2|${fileId}|${expNum}|${disp}|${organizationId}`,
      );
    }
    candidatePayloads.push(`v1|${fileId}|${expNum}|${disp}`);

    // Candidate secrets for rotation window
    const candidateSecrets: string[] = [this.secret];
    const prevSecret = this.configService.signedUrlSecretPrevious;
    if (prevSecret && prevSecret !== this.secret) {
      candidateSecrets.push(prevSecret);
    }

    // Constant-time comparison using fixed-size SHA-256 digest of signatures
    const sigHash = createHash('sha256').update(String(sig)).digest();
    let matches = false;

    for (const secret of candidateSecrets) {
      for (const payload of candidatePayloads) {
        const expectedBase64Url = createHmac('sha256', secret)
          .update(payload)
          .digest('base64url');
        const expectedHex = createHmac('sha256', secret)
          .update(payload)
          .digest('hex');

        const expectedBase64UrlHash = createHash('sha256')
          .update(expectedBase64Url)
          .digest();
        const expectedHexHash = createHash('sha256')
          .update(expectedHex)
          .digest();

        if (
          timingSafeEqual(sigHash, expectedBase64UrlHash) ||
          timingSafeEqual(sigHash, expectedHexHash)
        ) {
          matches = true;
          break;
        }
      }
      if (matches) break;
    }

    // UR-04 rule 5: safe logging, never log user tokens or query string
    this.logger.debug(
      `Signed URL verify: fileId=${fileId}, exp=${expNum}, disp=${disp}, sigPrefix=${String(sig).slice(0, 6)}, matches=${matches}`,
    );

    if (!matches) {
      return { valid: false, reason: 'INVALID_SIGNATURE' };
    }

    return {
      valid: true,
      disposition: disp,
      expiresAt: new Date(expNum * 1000),
    };
  }
}
