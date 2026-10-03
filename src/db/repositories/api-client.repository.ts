import { Injectable } from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { BaseRepository } from './base.repository.js';
import type { Database } from '../types.js';
import type { ApiClient, NewApiClient } from '../../core/types.js';
import { mapApiClientRow } from '../mappers.js';

@Injectable()
export class ApiClientRepository extends BaseRepository {
  async findByPrefix(
    keyPrefix: string,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<ApiClient | null> {
    const result = await this.getExecutor(trx)
      .selectFrom('api_clients')
      .selectAll()
      .where('key_prefix', '=', keyPrefix)
      .executeTakeFirst();

    return result ? mapApiClientRow(result) : null;
  }

  async create(
    client: NewApiClient,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<ApiClient> {
    const id = client.id ?? uuidv7();
    const result = await this.getExecutor(trx)
      .insertInto('api_clients')
      .values({
        id,
        name: client.name,
        key_prefix: client.keyPrefix,
        key_hash: client.keyHash,
        namespace: client.namespace,
        tenant_ids: client.tenantIds ?? [],
        allow_any_tenant: client.allowAnyTenant ?? false,
        scopes: client.scopes,
        status: client.status ?? 'ACTIVE',
        expires_at: client.expiresAt ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return mapApiClientRow(result);
  }

  async revoke(
    id: string,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<boolean> {
    const result = await this.getExecutor(trx)
      .updateTable('api_clients')
      .set({
        status: 'REVOKED',
        revoked_at: sql`now()`,
      })
      .where('id', '=', id)
      .where('status', '<>', 'REVOKED')
      .executeTakeFirst();

    return Number(result.numUpdatedRows) > 0;
  }

  async revokeByPrefix(
    keyPrefix: string,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<boolean> {
    const result = await this.getExecutor(trx)
      .updateTable('api_clients')
      .set({
        status: 'REVOKED',
        revoked_at: sql`now()`,
      })
      .where('key_prefix', '=', keyPrefix)
      .where('status', '<>', 'REVOKED')
      .executeTakeFirst();

    return Number(result.numUpdatedRows) > 0;
  }

  async list(
    options: { limit?: number; offset?: number } = {},
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<ApiClient[]> {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;

    const rows = await this.getExecutor(trx)
      .selectFrom('api_clients')
      .selectAll()
      .orderBy('created_at', 'desc')
      .limit(limit)
      .offset(offset)
      .execute();

    return rows.map(mapApiClientRow);
  }

  async touchLastUsed(
    id: string,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<void> {
    await this.getExecutor(trx)
      .updateTable('api_clients')
      .set({
        last_used_at: sql`now()`,
      })
      .where('id', '=', id)
      .execute();
  }
}
