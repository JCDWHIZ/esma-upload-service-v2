import { Injectable } from '@nestjs/common';
import type { RequestContext } from '../core/request-context.js';

export const QUOTA_GATE = Symbol('QUOTA_GATE');

export interface IQuotaGate {
  reserve(ctx: RequestContext, bytes: number | bigint): Promise<void>;
  release(ctx: RequestContext, bytes: number | bigint): Promise<void>;
}

/**
 * Default no-op quota gate.
 * Serves as an architectural seam until P6-02 implements Redis/database rate limiting and quota enforcement.
 */
@Injectable()
export class NoOpQuotaGate implements IQuotaGate {
  reserve(ctx: RequestContext, bytes: number | bigint): Promise<void> {
    void ctx;
    void bytes;
    return Promise.resolve();
  }

  release(ctx: RequestContext, bytes: number | bigint): Promise<void> {
    void ctx;
    void bytes;
    return Promise.resolve();
  }
}
