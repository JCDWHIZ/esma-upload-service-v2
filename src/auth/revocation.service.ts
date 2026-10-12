import { Injectable, Logger, Optional } from '@nestjs/common';
import { RedisService } from '../common/redis.service.js';
import { MetricsService } from '../observability/metrics.service.js';
import {
  TokenRevokedError,
  TokenStaleError,
  UnauthenticatedError,
} from '../core/errors/app-error.js';
import type { VerifiedTokenClaims } from './context.js';

@Injectable()
export class RevocationService {
  private readonly logger = new Logger(RevocationService.name);

  constructor(
    private readonly redisService: RedisService,
    @Optional() private readonly metricsService?: MetricsService,
  ) {}

  /**
   * Checks whether a user token has been revoked or its permission version is stale (UR-09).
   * Fail open for reads (GET, HEAD), fail closed for mutations (POST, PUT, PATCH, DELETE)
   * when Redis is unavailable.
   */
  async checkRevocation(
    claims: VerifiedTokenClaims,
    method = 'GET',
  ): Promise<void> {
    // 1. Service principals do not carry sid / permissionVersion
    if (claims.grant_type === 'client_credentials') {
      return;
    }

    const isRead =
      method.toUpperCase() === 'GET' ||
      method.toUpperCase() === 'HEAD' ||
      method.toUpperCase() === 'OPTIONS';
    const isReady = this.redisService.isReady();
    const client = this.redisService.getClient();

    if (!isReady || !client) {
      this.metricsService?.revocationRedisUnavailableTotal?.inc();
      if (!isRead) {
        this.logger.warn(
          'Redis unavailable for token revocation check during mutation; failing closed (UR-09.3)',
        );
        throw new UnauthenticatedError(
          'Revocation verification service unavailable',
        );
      }
      this.logger.debug(
        'Redis unavailable for token revocation check during read; failing open (UR-09.3)',
      );
      return;
    }

    try {
      // 2. Check session revocation: esma:revoked:sid:<sid>
      if (claims.sid && typeof claims.sid === 'string') {
        const revoked = await client.get(`esma:revoked:sid:${claims.sid}`);
        if (revoked !== null) {
          throw new TokenRevokedError('Token session has been revoked');
        }
      }

      // 3. Check permission version: esma:org-permission-version:<organisationId>
      const orgId = claims.organizationId ?? claims.schoolId;
      if (
        orgId &&
        claims.permissionVersion !== undefined &&
        claims.permissionVersion !== null
      ) {
        const currentVersionStr = await client.get(
          `esma:org-permission-version:${orgId}`,
        );
        if (currentVersionStr !== null) {
          const currentVersion = parseInt(currentVersionStr, 10);
          const tokenVersion = Number(claims.permissionVersion);
          if (
            !isNaN(currentVersion) &&
            !isNaN(tokenVersion) &&
            tokenVersion < currentVersion
          ) {
            throw new TokenStaleError('Token permission version is stale');
          }
        }
      }
    } catch (err) {
      if (err instanceof TokenRevokedError || err instanceof TokenStaleError) {
        throw err;
      }
      // Redis error during execution
      this.metricsService?.revocationRedisUnavailableTotal?.inc();
      if (!isRead) {
        this.logger.error(
          `Redis error during revocation check on mutation: ${String(err)}`,
        );
        throw new UnauthenticatedError('Revocation verification service error');
      }
      this.logger.warn(
        `Redis error during revocation check on read; failing open: ${String(err)}`,
      );
    }
  }
}
