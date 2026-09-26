import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'node:crypto';
import { ApiClientRepository } from '../../db/repositories/api-client.repository.js';
import { ApiClient } from '../../core/types.js';
import {
  RateLimitedError,
  UnauthenticatedError,
} from '../../core/errors/app-error.js';

interface CacheEntry {
  readonly client: ApiClient | null; // null represents negative cache entry
  readonly cachedAt: number;
}

interface FailureTracker {
  count: number;
  firstFailedAt: number;
}

export interface GeneratedApiKey {
  readonly rawKey: string;
  readonly keyPrefix: string;
  readonly keyHash: string;
  readonly secret: string;
}

@Injectable()
export class ApiKeyAuthenticatorService {
  private readonly logger = new Logger(ApiKeyAuthenticatorService.name);
  private static readonly KEY_REGEX =
    /^(?:eus2|eus|gus)_([A-Za-z0-9]{8})_([A-Za-z0-9_-]{32,64})$/;
  private static readonly CACHE_TTL_MS = 30_000; // 30 seconds
  private static readonly MAX_FAILED_ATTEMPTS = 10;
  private static readonly FAILED_ATTEMPT_WINDOW_MS = 60_000; // 1 minute

  private readonly cache = new Map<string, CacheEntry>();
  private readonly ipFailures = new Map<string, FailureTracker>();

  constructor(private readonly apiClientRepository: ApiClientRepository) {}

  /**
   * Generates a new cryptographically secure API key with prefix and hash
   */
  static generateKey(): GeneratedApiKey {
    const keyPrefix = crypto.randomBytes(4).toString('hex'); // 8 characters
    const secret = crypto.randomBytes(32).toString('base64url'); // 43 chars
    const rawKey = `eus2_${keyPrefix}_${secret}`;
    const keyHash = crypto.createHash('sha256').update(secret).digest('hex');

    return {
      rawKey,
      keyPrefix,
      keyHash,
      secret,
    };
  }

  /**
   * Authenticates an API key string and returns the verified ApiClient
   */
  async authenticate(rawKey: string, ipAddress?: string): Promise<ApiClient> {
    // 1. IP-based rate limiting check for brute force protection
    if (ipAddress) {
      this.checkIpRateLimit(ipAddress);
    }

    if (!rawKey || typeof rawKey !== 'string') {
      this.recordFailure(ipAddress);
      throw new UnauthenticatedError('Missing API key');
    }

    const trimmed = rawKey.trim();
    const match = ApiKeyAuthenticatorService.KEY_REGEX.exec(trimmed);
    if (!match) {
      this.recordFailure(ipAddress);
      throw new UnauthenticatedError('Invalid API key format');
    }

    const keyPrefix = match[1];
    const secret = match[2];
    const cacheKey = crypto.createHash('sha256').update(trimmed).digest('hex');

    // 2. Check 30-second in-memory cache
    const cached = this.cache.get(cacheKey);
    const now = Date.now();
    if (
      cached &&
      now - cached.cachedAt < ApiKeyAuthenticatorService.CACHE_TTL_MS
    ) {
      if (!cached.client) {
        // Negative cache hit
        this.recordFailure(ipAddress);
        throw new UnauthenticatedError('Invalid API key');
      }

      // Check current validity of cached client
      this.assertClientActive(cached.client, ipAddress);
      this.throttleTouchLastUsed(cached.client);
      return cached.client;
    }

    // 3. Database lookup by prefix
    const client = await this.apiClientRepository.findByPrefix(keyPrefix);
    if (!client) {
      // Record negative cache hit
      this.cache.set(cacheKey, { client: null, cachedAt: now });
      this.recordFailure(ipAddress);
      throw new UnauthenticatedError('Invalid API key');
    }

    // 4. Timing-safe comparison of SHA-256 hashes
    const computedHash = crypto
      .createHash('sha256')
      .update(secret)
      .digest('hex');
    const computedBuffer = Buffer.from(computedHash, 'utf8');
    const expectedBuffer = Buffer.from(client.keyHash, 'utf8');

    const hashesMatch =
      computedBuffer.length === expectedBuffer.length &&
      crypto.timingSafeEqual(computedBuffer, expectedBuffer);

    if (!hashesMatch) {
      this.cache.set(cacheKey, { client: null, cachedAt: now });
      this.recordFailure(ipAddress);
      throw new UnauthenticatedError('Invalid API key');
    }

    // 5. Status & Expiration checks
    this.assertClientActive(client, ipAddress);

    // 6. Populate positive cache
    this.cache.set(cacheKey, { client, cachedAt: now });

    // 7. Update last_used_at throttled to at most once per minute
    this.throttleTouchLastUsed(client);

    return client;
  }

  /**
   * Invalidate cache for a specific key or all entries
   */
  clearCache(): void {
    this.cache.clear();
  }

  private assertClientActive(client: ApiClient, ipAddress?: string): void {
    if (client.status !== 'ACTIVE') {
      this.recordFailure(ipAddress);
      throw new UnauthenticatedError('API key has been revoked');
    }

    if (client.expiresAt && client.expiresAt.getTime() <= Date.now()) {
      this.recordFailure(ipAddress);
      throw new UnauthenticatedError('API key has expired');
    }
  }

  private throttleTouchLastUsed(client: ApiClient): void {
    const now = Date.now();
    const lastUsedMs = client.lastUsedAt ? client.lastUsedAt.getTime() : 0;

    if (now - lastUsedMs > 60_000) {
      // Update in DB asynchronously without blocking current request
      this.apiClientRepository.touchLastUsed(client.id).catch((err) => {
        this.logger.warn(
          `Failed to update last_used_at for client ${client.keyPrefix}: ${String(err)}`,
        );
      });
      // Mutate local object so subsequent cached calls see updated timestamp
      (client as { lastUsedAt: Date }).lastUsedAt = new Date(now);
    }
  }

  private checkIpRateLimit(ipAddress: string): void {
    const tracker = this.ipFailures.get(ipAddress);
    if (!tracker) return;

    const now = Date.now();
    if (
      now - tracker.firstFailedAt >
      ApiKeyAuthenticatorService.FAILED_ATTEMPT_WINDOW_MS
    ) {
      // Window expired, reset
      this.ipFailures.delete(ipAddress);
      return;
    }

    if (tracker.count >= ApiKeyAuthenticatorService.MAX_FAILED_ATTEMPTS) {
      throw new RateLimitedError(
        'Too many failed API key authentication attempts from this IP. Please try again later.',
      );
    }
  }

  private recordFailure(ipAddress?: string): void {
    if (!ipAddress) return;

    const now = Date.now();
    const tracker = this.ipFailures.get(ipAddress);

    if (
      !tracker ||
      now - tracker.firstFailedAt >
        ApiKeyAuthenticatorService.FAILED_ATTEMPT_WINDOW_MS
    ) {
      this.ipFailures.set(ipAddress, { count: 1, firstFailedAt: now });
    } else {
      tracker.count += 1;
    }
  }
}
