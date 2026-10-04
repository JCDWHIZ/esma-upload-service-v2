import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  RateLimiterRedis,
  RateLimiterMemory,
  RateLimiterRes,
  type IRateLimiterOptions,
} from 'rate-limiter-flexible';
import { AppConfigService } from '../config/config.service.js';
import { RedisService } from './redis.service.js';

export interface RateLimitCheckResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
}

export type RateLimitBucket =
  'upload_req' | 'upload_bytes' | 'read_req' | 'auth_fail';

@Injectable()
export class RateLimiterService implements OnModuleInit {
  private readonly logger = new Logger(RateLimiterService.name);

  private requestsLimiter!: RateLimiterRedis | RateLimiterMemory;
  private bytesLimiter!: RateLimiterRedis | RateLimiterMemory;
  private readLimiter!: RateLimiterRedis | RateLimiterMemory;
  private authLimiter!: RateLimiterRedis | RateLimiterMemory;

  constructor(
    private readonly configService: AppConfigService,
    private readonly redisService: RedisService,
  ) {}

  onModuleInit(): void {
    this.initLimiters();
  }

  public initLimiters(): void {
    const redisClient = this.redisService.getClient();
    const isRedis = this.redisService.isReady() && redisClient !== null;

    const reqOptions: IRateLimiterOptions = {
      points: this.configService.defaultUploadLimitPerMin,
      duration: 60,
    };
    const bytesOptions: IRateLimiterOptions = {
      points: this.configService.defaultUploadBytesPerMin,
      duration: 60,
    };
    const readOptions: IRateLimiterOptions = {
      points: this.configService.defaultReadLimitPerMin,
      duration: 60,
    };
    const authOptions: IRateLimiterOptions = {
      points: this.configService.defaultFailedAuthLimitPerMin,
      duration: 60,
    };

    if (isRedis && redisClient) {
      this.requestsLimiter = new RateLimiterRedis({
        ...reqOptions,
        storeClient: redisClient,
        keyPrefix: 'rl:upload_req',
      });
      this.bytesLimiter = new RateLimiterRedis({
        ...bytesOptions,
        storeClient: redisClient,
        keyPrefix: 'rl:upload_bytes',
      });
      this.readLimiter = new RateLimiterRedis({
        ...readOptions,
        storeClient: redisClient,
        keyPrefix: 'rl:read_req',
      });
      this.authLimiter = new RateLimiterRedis({
        ...authOptions,
        storeClient: redisClient,
        keyPrefix: 'rl:auth_fail',
      });
    } else {
      this.requestsLimiter = new RateLimiterMemory({
        ...reqOptions,
        keyPrefix: 'rl:upload_req',
      });
      this.bytesLimiter = new RateLimiterMemory({
        ...bytesOptions,
        keyPrefix: 'rl:upload_bytes',
      });
      this.readLimiter = new RateLimiterMemory({
        ...readOptions,
        keyPrefix: 'rl:read_req',
      });
      this.authLimiter = new RateLimiterMemory({
        ...authOptions,
        keyPrefix: 'rl:auth_fail',
      });
    }
  }

  /**
   * Consume rate limit points for requests or bytes.
   */
  async consume(
    bucket: RateLimitBucket,
    key: string,
    points = 1,
  ): Promise<RateLimitCheckResult> {
    if (!this.configService.rateLimitEnabled) {
      return { allowed: true, limit: 1000, remaining: 999, resetSeconds: 0 };
    }

    let limiter: RateLimiterRedis | RateLimiterMemory;
    switch (bucket) {
      case 'upload_req':
        limiter = this.requestsLimiter;
        break;
      case 'upload_bytes':
        limiter = this.bytesLimiter;
        break;
      case 'read_req':
        limiter = this.readLimiter;
        break;
      case 'auth_fail':
        limiter = this.authLimiter;
        break;
    }

    try {
      const res: RateLimiterRes = await limiter.consume(key, points);
      return {
        allowed: true,
        limit: limiter.points,
        remaining: res.remainingPoints,
        resetSeconds: Math.ceil(res.msBeforeNext / 1000),
      };
    } catch (rej: unknown) {
      if (
        rej !== null &&
        typeof rej === 'object' &&
        'remainingPoints' in rej &&
        'msBeforeNext' in rej
      ) {
        const res = rej as RateLimiterRes;
        return {
          allowed: false,
          limit: limiter.points,
          remaining: res.remainingPoints,
          resetSeconds: Math.ceil(res.msBeforeNext / 1000),
        };
      }

      // Unexpected Redis error or failure
      this.logger.warn(
        `Rate limiter execution error for ${bucket}:${key}: ${String(rej)}`,
      );

      if (bucket === 'read_req' && this.configService.rateLimitFailOpenReads) {
        return { allowed: true, limit: 1000, remaining: 999, resetSeconds: 0 };
      }

      if (this.configService.rateLimitFailClosedMutations) {
        return { allowed: false, limit: 0, remaining: 0, resetSeconds: 60 };
      }

      return { allowed: true, limit: 1000, remaining: 999, resetSeconds: 0 };
    }
  }
}
