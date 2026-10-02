import { Injectable } from '@nestjs/common';
import { type Kysely, type Transaction } from 'kysely';
import { BaseRepository } from './base.repository.js';
import type { Database } from '../types.js';

export interface IdempotencyKeyRecord {
  tenantId: string;
  key: string;
  requestHash: string;
  status: 'IN_PROGRESS' | 'COMPLETED';
  responseStatus: number | null;
  responseBody: Record<string, unknown> | null;
  fileId: string | null;
  createdAt: Date;
  expiresAt: Date;
}

@Injectable()
export class IdempotencyRepository extends BaseRepository {
  async findByKey(
    tenantId: string,
    key: string,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<IdempotencyKeyRecord | null> {
    const row = await this.getExecutor(trx)
      .selectFrom('idempotency_keys')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('key', '=', key)
      .executeTakeFirst();

    if (!row) return null;

    return {
      tenantId: row.tenant_id,
      key: row.key,
      requestHash: row.request_hash,
      status: row.status,
      responseStatus: row.response_status,
      responseBody: row.response_body,
      fileId: row.file_id,
      createdAt: new Date(row.created_at),
      expiresAt: new Date(row.expires_at),
    };
  }

  async createInProgress(
    params: {
      tenantId: string;
      key: string;
      requestHash: string;
      expiresAt: Date;
    },
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<boolean> {
    const result = await this.getExecutor(trx)
      .insertInto('idempotency_keys')
      .values({
        tenant_id: params.tenantId,
        key: params.key,
        request_hash: params.requestHash,
        status: 'IN_PROGRESS',
        expires_at: params.expiresAt,
      })
      .onConflict((oc) => oc.columns(['tenant_id', 'key']).doNothing())
      .executeTakeFirst();

    return Number(result.numInsertedOrUpdatedRows ?? 0) > 0;
  }

  async markCompleted(
    tenantId: string,
    key: string,
    responseStatus: number,
    responseBody: Record<string, unknown>,
    fileId?: string,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<void> {
    await this.getExecutor(trx)
      .updateTable('idempotency_keys')
      .set({
        status: 'COMPLETED',
        response_status: responseStatus,
        response_body: responseBody,
        file_id: fileId ?? null,
      })
      .where('tenant_id', '=', tenantId)
      .where('key', '=', key)
      .execute();
  }

  async deleteExpired(
    now: Date = new Date(),
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<number> {
    const result = await this.getExecutor(trx)
      .deleteFrom('idempotency_keys')
      .where('expires_at', '<', now)
      .executeTakeFirst();

    return Number(result.numDeletedRows ?? 0);
  }
}
