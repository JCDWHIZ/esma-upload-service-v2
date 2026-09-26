import { Injectable, Logger } from '@nestjs/common';
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
  type JWTPayload,
} from 'jose';
import { AppConfigService } from '../../config/config.service.js';
import { UnauthenticatedError } from '../../core/errors/app-error.js';
import { TokenAccessClaims, VerifiedTokenClaims } from '../context.js';

export interface KeyRingEntry {
  readonly kid: string;
  readonly secret: string;
  readonly status: 'active' | 'verify-only';
  readonly secretBytes: Uint8Array;
}

@Injectable()
export class JwtVerifierService {
  private readonly logger = new Logger(JwtVerifierService.name);
  private keyRing: KeyRingEntry[] = [];
  private remoteJwks?: JWTVerifyGetKey;
  private jwksUri: string;
  private expectedIssuer?: string;
  private clockToleranceSeconds: number;
  private allowedAlgorithms: string[];

  constructor(private readonly configService: AppConfigService) {
    const config = this.configService.get();
    this.jwksUri = config.IDENTITY_JWKS_URI;
    this.expectedIssuer = config.IDENTITY_ISSUER;
    this.clockToleranceSeconds = config.JWT_CLOCK_TOLERANCE_SECONDS ?? 5;
    this.allowedAlgorithms = (config.JWT_ALGORITHMS ?? 'HS256,RS256')
      .split(',')
      .map((a) => a.trim().toUpperCase());

    this.initKeyRing(config.JWT_KEYS, config.JWT_SECRET);

    if (this.jwksUri) {
      try {
        this.remoteJwks = createRemoteJWKSet(new URL(this.jwksUri), {
          cacheMaxAge: 10 * 60 * 1000, // 10 minutes
          cooldownDuration: 30 * 1000, // 30 seconds
        });
      } catch (err) {
        this.logger.warn(
          `Failed to initialize remote JWKS for ${this.jwksUri}: ${String(err)}`,
        );
      }
    }
  }

  /**
   * Allows tests or custom configurations to provide a custom JWKS resolver
   */
  setJwksResolver(resolver: JWTVerifyGetKey): void {
    this.remoteJwks = resolver;
  }

  /**
   * Allows tests or secret rotators to reconfigure the in-memory key ring
   */
  setKeyRing(
    keys: Array<{
      kid: string;
      secret: string;
      status: 'active' | 'verify-only';
    }>,
  ): void {
    this.keyRing = keys.map((k) => ({
      ...k,
      secretBytes: new TextEncoder().encode(k.secret),
    }));
  }

  /**
   * Returns current key ring representation (excluding raw secrets)
   */
  getKeyRingMetadata(): Array<{
    kid: string;
    status: 'active' | 'verify-only';
  }> {
    return this.keyRing.map((k) => ({ kid: k.kid, status: k.status }));
  }

  private initKeyRing(jwtKeysJson?: string, defaultSecret?: string): void {
    if (jwtKeysJson && jwtKeysJson.trim() !== '') {
      try {
        const parsed = JSON.parse(jwtKeysJson) as Array<{
          kid: string;
          secret: string;
          status: 'active' | 'verify-only';
        }>;
        if (Array.isArray(parsed) && parsed.length > 0) {
          this.setKeyRing(parsed);
          return;
        }
      } catch (err) {
        this.logger.warn(`Failed to parse JWT_KEYS JSON: ${String(err)}`);
      }
    }

    if (defaultSecret) {
      this.setKeyRing([
        {
          kid: 'default',
          secret: defaultSecret,
          status: 'active',
        },
      ]);
    }
  }

  /**
   * Verify an incoming token string and return normalized VerifiedTokenClaims
   */
  async verifyToken(tokenString: string): Promise<VerifiedTokenClaims> {
    if (
      !tokenString ||
      typeof tokenString !== 'string' ||
      tokenString.trim() === ''
    ) {
      throw new UnauthenticatedError('Missing token');
    }

    const trimmed = tokenString.trim();

    // 1. Decode header to inspect algorithm and kid
    const parts = trimmed.split('.');
    if (parts.length < 2 || !parts[0]) {
      throw new UnauthenticatedError('Malformed token header');
    }

    let headerObj: Record<string, unknown>;
    try {
      const rawHeader = Buffer.from(parts[0], 'base64url').toString('utf8');
      const parsed: unknown = JSON.parse(rawHeader);
      if (!parsed || typeof parsed !== 'object') {
        throw new UnauthenticatedError('Malformed token header');
      }
      headerObj = parsed as Record<string, unknown>;
    } catch {
      throw new UnauthenticatedError('Malformed token header');
    }

    const alg = (
      typeof headerObj.alg === 'string' ? headerObj.alg : ''
    ).toUpperCase();
    if (!alg || alg === 'NONE') {
      throw new UnauthenticatedError('Algorithm "none" is forbidden');
    }

    if (!this.allowedAlgorithms.includes(alg)) {
      throw new UnauthenticatedError(`Algorithm "${alg}" is not allowed`);
    }

    let payload: JWTPayload;

    // 2. Dispatch verification based on algorithm
    if (alg === 'RS256') {
      payload = await this.verifyRs256(trimmed);
    } else if (alg === 'HS256') {
      const kid = typeof headerObj.kid === 'string' ? headerObj.kid : undefined;
      payload = await this.verifyHs256(trimmed, kid);
    } else {
      throw new UnauthenticatedError(
        `Unsupported token signature algorithm: ${alg}`,
      );
    }

    // 3. Strict token claim validation
    // A-02: Require 'exp' claim on all tokens
    if (payload.exp === undefined || typeof payload.exp !== 'number') {
      throw new UnauthenticatedError(
        'Token is missing mandatory "exp" expiration claim',
      );
    }

    // Must have a subject or userId identifier
    const subject = payload.sub ?? (payload['userId'] as string | undefined);
    if (!subject || typeof subject !== 'string' || subject.trim() === '') {
      throw new UnauthenticatedError(
        'Token is missing mandatory "sub" or "userId" claim',
      );
    }

    return this.normalizeClaims(payload);
  }

  private async verifyRs256(jwt: string): Promise<JWTPayload> {
    if (!this.remoteJwks) {
      throw new UnauthenticatedError(
        'OIDC JWKS verification is not configured or available',
      );
    }

    try {
      const verifyOptions: { clockTolerance: number; issuer?: string } = {
        clockTolerance: this.clockToleranceSeconds,
      };
      if (this.expectedIssuer) {
        verifyOptions.issuer = this.expectedIssuer;
      }

      const { payload } = await jwtVerify(jwt, this.remoteJwks, verifyOptions);
      return payload;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (
        message.includes('expired') ||
        (err as { code?: string })?.code === 'ERR_JWT_EXPIRED'
      ) {
        throw new UnauthenticatedError('Token has expired');
      }
      throw new UnauthenticatedError(
        `JWKS token verification failed: ${message}`,
      );
    }
  }

  private async verifyHs256(jwt: string, kid?: string): Promise<JWTPayload> {
    if (this.keyRing.length === 0) {
      throw new UnauthenticatedError(
        'No HMAC verification keys are configured',
      );
    }

    const verifyOptions = {
      clockTolerance: this.clockToleranceSeconds,
    };

    // If token header specified a key ID, strictly match it
    if (kid) {
      const matchedKey = this.keyRing.find((k) => k.kid === kid);
      if (!matchedKey) {
        throw new UnauthenticatedError(`Unknown key ID "${kid}" in key ring`);
      }

      try {
        const { payload } = await jwtVerify(
          jwt,
          matchedKey.secretBytes,
          verifyOptions,
        );
        return payload;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (
          message.includes('expired') ||
          (err as { code?: string })?.code === 'ERR_JWT_EXPIRED'
        ) {
          throw new UnauthenticatedError('Token has expired');
        }
        throw new UnauthenticatedError(
          `Signature verification failed for key ID "${kid}"`,
        );
      }
    }

    // If no kid: try active keys first, then verify-only keys
    const activeKeys = this.keyRing.filter((k) => k.status === 'active');
    const verifyOnlyKeys = this.keyRing.filter(
      (k) => k.status === 'verify-only',
    );
    const candidateKeys = [...activeKeys, ...verifyOnlyKeys];

    let lastError: Error | undefined;

    for (const key of candidateKeys) {
      try {
        const { payload } = await jwtVerify(
          jwt,
          key.secretBytes,
          verifyOptions,
        );
        return payload;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (
          message.includes('expired') ||
          (err as { code?: string })?.code === 'ERR_JWT_EXPIRED'
        ) {
          throw new UnauthenticatedError('Token has expired');
        }
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }

    throw new UnauthenticatedError(
      `HMAC signature verification failed against all keys in ring (${candidateKeys.length} evaluated): ${lastError?.message ?? 'Invalid signature'}`,
    );
  }

  private normalizeClaims(payload: JWTPayload): VerifiedTokenClaims {
    const orgId =
      (payload['organizationId'] as string | undefined) ??
      (payload['schoolId'] as string | undefined);

    const schoolId =
      (payload['schoolId'] as string | undefined) ??
      (payload['organizationId'] as string | undefined);

    const sub = payload.sub;
    const userId = (payload['userId'] as string | undefined) ?? sub;

    const role = payload['role'] as string | undefined;
    const rolesArray =
      (payload['roles'] as string[] | undefined) ?? (role ? [role] : []);

    return {
      sub,
      userId,
      organizationId: orgId,
      schoolId,
      branchId: payload['branchId'] as string | undefined,
      branches: payload['branches'] as
        Array<{ id: string } | string> | undefined,
      role,
      roles: rolesArray,
      permissions: payload['permissions'] as string[] | undefined,
      email: payload['email'] as string | undefined,
      access: payload['access'] as TokenAccessClaims | undefined,
      platformAdmin: payload['platformAdmin'] as boolean | undefined,
      ...payload,
    };
  }
}
