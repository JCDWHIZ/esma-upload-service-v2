import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { AuthenticatedHttpRequest } from '../../auth/context.js';
import {
  RateLimiterService,
  type RateLimitBucket,
} from '../rate-limiter.service.js';
import { RateLimitedError } from '../../core/errors/app-error.js';

@Injectable()
export class RateLimiterGuard implements CanActivate {
  constructor(private readonly rateLimiterService: RateLimiterService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const req = http.getRequest<AuthenticatedHttpRequest & Request>();
    const res = http.getResponse<Response>();

    const method = req.method.toUpperCase();
    const path = req.path ?? req.url ?? '';

    // Determine bucket
    let bucket: RateLimitBucket = 'read_req';
    const points = 1;

    if (
      method === 'POST' ||
      method === 'PUT' ||
      method === 'PATCH' ||
      method === 'DELETE'
    ) {
      if (path.includes('/upload') || path.includes('/files')) {
        bucket = 'upload_req';
        const contentLength = parseInt(
          req.headers['content-length'] ?? '0',
          10,
        );
        if (contentLength > 0) {
          // Check payload bytes in addition to request count
          const bytesBucket: RateLimitBucket = 'upload_bytes';
          const actorOrIpKey = req.ctx?.actor?.id ?? req.ip ?? 'anonymous';
          const bytesRes = await this.rateLimiterService.consume(
            bytesBucket,
            actorOrIpKey,
            contentLength,
          );
          if (!bytesRes.allowed) {
            res.setHeader('RateLimit-Limit', String(bytesRes.limit));
            res.setHeader('RateLimit-Remaining', String(bytesRes.remaining));
            res.setHeader('RateLimit-Reset', String(bytesRes.resetSeconds));
            res.setHeader('Retry-After', String(bytesRes.resetSeconds));
            throw new RateLimitedError(
              'Upload bandwidth limit exceeded. Please try again later.',
              { headers: { 'Retry-After': String(bytesRes.resetSeconds) } },
            );
          }
        }
      }
    }

    const key = req.ctx?.actor?.id ?? req.ip ?? 'anonymous';
    const result = await this.rateLimiterService.consume(bucket, key, points);

    res.setHeader('RateLimit-Limit', String(result.limit));
    res.setHeader('RateLimit-Remaining', String(result.remaining));
    res.setHeader('RateLimit-Reset', String(result.resetSeconds));

    if (!result.allowed) {
      res.setHeader('Retry-After', String(result.resetSeconds));
      throw new RateLimitedError('Too many requests, please slow down', {
        headers: { 'Retry-After': String(result.resetSeconds) },
      });
    }

    return true;
  }
}
