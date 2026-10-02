import { Injectable, Logger } from '@nestjs/common';
import type { IQuotaGate } from './quota-gate.interface.js';
import type { RequestContext } from '../core/request-context.js';
import { UsageRepository } from '../db/repositories/usage.repository.js';
import { QuotaExceededError } from '../core/errors/app-error.js';

@Injectable()
export class DatabaseQuotaGate implements IQuotaGate {
  private readonly logger = new Logger(DatabaseQuotaGate.name);

  constructor(private readonly usageRepo: UsageRepository) {}

  async reserve(ctx: RequestContext, bytes: number | bigint): Promise<void> {
    const namespace = ctx.namespace;
    const tenantId = ctx.tenantId;

    if (!tenantId) {
      return;
    }

    const reserved = await this.usageRepo.tryReserve(
      namespace,
      tenantId,
      bytes,
      1,
    );
    if (!reserved) {
      this.logger.warn(
        `Quota exceeded for tenant ${tenantId} in ${namespace} (requested ${bytes} bytes)`,
      );
      throw new QuotaExceededError(
        `Tenant '${tenantId}' has exceeded its allowable storage quota`,
      );
    }
  }

  async release(ctx: RequestContext, bytes: number | bigint): Promise<void> {
    const namespace = ctx.namespace;
    const tenantId = ctx.tenantId;

    if (!tenantId) {
      return;
    }

    await this.usageRepo.release(namespace, tenantId, bytes, 1);
  }
}
