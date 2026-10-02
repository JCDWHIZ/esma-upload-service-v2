import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import type { Request, Response } from 'express';
import { RateLimiterService } from '../../src/common/rate-limiter.service.js';
import { RateLimiterGuard } from '../../src/common/guards/rate-limiter.guard.js';
import type { AppConfigService } from '../../src/config/config.service.js';
import type { RedisService } from '../../src/common/redis.service.js';
import { RateLimitedError } from '../../src/core/errors/app-error.js';
import type { AuthenticatedHttpRequest } from '../../src/auth/context.js';

describe('RateLimiterGuard & RateLimiterService (P6-02)', () => {
  let rateLimiterService: RateLimiterService;
  let guard: RateLimiterGuard;
  let mockConfig: Partial<AppConfigService>;
  let mockRedisService: Partial<RedisService>;

  beforeEach(() => {
    mockConfig = {
      rateLimitEnabled: true,
      rateLimitFailOpenReads: true,
      rateLimitFailClosedMutations: true,
      defaultUploadLimitPerMin: 5,
      defaultUploadBytesPerMin: 1000000,
      defaultReadLimitPerMin: 10,
      defaultFailedAuthLimitPerMin: 3,
    };

    mockRedisService = {
      getClient: vi.fn().mockReturnValue(null),
      isReady: vi.fn().mockReturnValue(false),
    };

    rateLimiterService = new RateLimiterService(
      mockConfig as AppConfigService,
      mockRedisService as RedisService,
    );

    rateLimiterService.onModuleInit();
    guard = new RateLimiterGuard(rateLimiterService);
  });

  function createMockContext(
    method = 'GET',
    url = '/api/v1/files',
    headers: Record<string, string> = {},
    actorId?: string,
  ): {
    context: ExecutionContext;
    resHeaders: Record<string, string>;
  } {
    const resHeaders: Record<string, string> = {};

    const req: Partial<AuthenticatedHttpRequest & Request> = {
      method,
      path: url,
      url,
      ip: '127.0.0.1',
      headers,
      ctx: actorId
        ? {
            correlationId: 'corr-1',
            namespace: 'default',
            tenantId: 'tenant-1',
            ipAddress: '127.0.0.1',
            attributes: {},
            actor: { id: actorId, type: 'user', roles: ['user'], scopes: [] },
          }
        : undefined,
    };

    const res: Partial<Response> = {
      setHeader: vi.fn().mockImplementation((key: string, val: string) => {
        resHeaders[key.toLowerCase()] = val;
        return res;
      }),
    };

    const context = {
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => res,
      }),
    } as unknown as ExecutionContext;

    return { context, resHeaders };
  }

  it('sets standard RateLimit headers on successful requests', async () => {
    const { context, resHeaders } = createMockContext('GET', '/api/v1/files');

    const allowed = await guard.canActivate(context);

    expect(allowed).toBe(true);
    expect(resHeaders['ratelimit-limit']).toBe('10');
    expect(resHeaders['ratelimit-remaining']).toBeDefined();
    expect(resHeaders['ratelimit-reset']).toBeDefined();
  });

  it('throws RateLimitedError (429) when points are exhausted', async () => {
    const actorId = 'exhausted-actor';

    // Exhaust 10 points
    for (let i = 0; i < 10; i++) {
      const { context } = createMockContext(
        'GET',
        '/api/v1/files',
        {},
        actorId,
      );
      await guard.canActivate(context);
    }

    const { context, resHeaders } = createMockContext(
      'GET',
      '/api/v1/files',
      {},
      actorId,
    );

    await expect(guard.canActivate(context)).rejects.toThrow(RateLimitedError);
    expect(resHeaders['retry-after']).toBeDefined();
  });

  it('checks payload content-length for upload request byte limits', async () => {
    const { context, resHeaders } = createMockContext(
      'POST',
      '/api/v1/files/upload',
      { 'content-length': '2000000' }, // Exceeds 1,000,000 bytes limit
      'actor-bytes',
    );

    await expect(guard.canActivate(context)).rejects.toThrow(RateLimitedError);
    expect(resHeaders['retry-after']).toBeDefined();
  });

  it('bypasses rate limiting when rateLimitEnabled is false', async () => {
    (mockConfig as Record<string, unknown>).rateLimitEnabled = false;

    const { context, resHeaders } = createMockContext('GET', '/api/v1/files');
    const allowed = await guard.canActivate(context);

    expect(allowed).toBe(true);
    expect(resHeaders['ratelimit-limit']).toBe('1000');
  });
});
