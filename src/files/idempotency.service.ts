import { Injectable, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { IdempotencyRepository } from '../db/repositories/idempotency.repository.js';
import { AppConfigService } from '../config/config.service.js';
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
} from '../core/errors/app-error.js';

export type IdempotencyEvaluation =
  | { status: 'NEW' }
  | {
      status: 'REPLAYED';
      responseStatus: number;
      responseBody: Record<string, unknown>;
      fileId: string | null;
    };

@Injectable()
export class IdempotencyService {
  constructor(
    private readonly idempotencyRepository: IdempotencyRepository,
    @Optional() private readonly configService?: AppConfigService,
  ) {}

  computeFingerprint(
    sha256: string,
    folder: string,
    visibility: string,
    tags: string[] = [],
  ): string {
    const sortedTags = [...tags].sort().join(',');
    const raw = `${sha256}|${folder.toLowerCase()}|${visibility.toLowerCase()}|${sortedTags}`;
    return createHash('sha256').update(raw).digest('hex');
  }

  async acquireOrCheck(
    tenantId: string,
    key: string,
    requestHash: string,
  ): Promise<IdempotencyEvaluation> {
    const existing = await this.idempotencyRepository.findByKey(tenantId, key);

    if (existing) {
      if (existing.status === 'IN_PROGRESS') {
        const staleTimeoutMs = 5 * 60 * 1000; // 5 min timeout for abandoned in-flight requests
        if (Date.now() - existing.createdAt.getTime() > staleTimeoutMs) {
          // Stale in-progress key from crashed worker or dead socket; reclaim it
          await this.idempotencyRepository.deleteByKey(tenantId, key);
        } else {
          throw new IdempotencyInProgressError();
        }
      } else {
        if (existing.requestHash !== requestHash) {
          throw new IdempotencyConflictError();
        }

        return {
          status: 'REPLAYED',
          responseStatus: existing.responseStatus ?? 200,
          responseBody: existing.responseBody ?? {},
          fileId: existing.fileId,
        };
      }
    }

    const ttlHours = this.configService?.idempotencyKeyTtlHours ?? 24;
    const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000);

    const inserted = await this.idempotencyRepository.createInProgress({
      tenantId,
      key,
      requestHash,
      expiresAt,
    });

    if (!inserted) {
      // Race condition fallback
      const recheck = await this.idempotencyRepository.findByKey(tenantId, key);
      if (recheck?.status === 'IN_PROGRESS') {
        throw new IdempotencyInProgressError();
      }
      if (recheck?.status === 'COMPLETED') {
        if (recheck.requestHash !== requestHash) {
          throw new IdempotencyConflictError();
        }
        return {
          status: 'REPLAYED',
          responseStatus: recheck.responseStatus ?? 200,
          responseBody: recheck.responseBody ?? {},
          fileId: recheck.fileId,
        };
      }
    }

    return { status: 'NEW' };
  }

  async recordCompleted(
    tenantId: string,
    key: string,
    responseStatus: number,
    responseBody: Record<string, unknown>,
    fileId?: string,
  ): Promise<void> {
    await this.idempotencyRepository.markCompleted(
      tenantId,
      key,
      responseStatus,
      responseBody,
      fileId,
    );
  }

  async releaseKey(tenantId: string, key: string): Promise<void> {
    await this.idempotencyRepository.deleteByKey(tenantId, key);
  }
}
