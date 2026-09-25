import { Injectable } from '@nestjs/common';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import { BaseRepository } from './base.repository.js';
import type { Database, TenantUsageTable } from '../types.js';
import type { TenantUsage } from '../../core/types.js';
import { mapTenantUsageRow } from '../mappers.js';

@Injectable()
export class UsageRepository extends BaseRepository {
  async get(
    namespace: string,
    tenantId: string,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<TenantUsage | null> {
    const result = await this.getExecutor(trx)
      .selectFrom('tenant_usage')
      .selectAll()
      .where('namespace', '=', namespace)
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();

    return result ? mapTenantUsageRow(result) : null;
  }

  async setQuota(
    namespace: string,
    tenantId: string,
    maxBytes: bigint | number | null,
    maxFiles: bigint | number | null,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<TenantUsage> {
    const maxBytesStr = maxBytes !== null ? String(maxBytes) : null;
    const maxFilesStr = maxFiles !== null ? String(maxFiles) : null;

    const result = await sql<Selectable<TenantUsageTable>>`
      INSERT INTO tenant_usage (namespace, tenant_id, bytes_used, file_count, max_bytes, max_files, updated_at)
      VALUES (${namespace}, ${tenantId}, 0, 0, ${maxBytesStr}::bigint, ${maxFilesStr}::bigint, now())
      ON CONFLICT (namespace, tenant_id)
      DO UPDATE SET
        max_bytes = EXCLUDED.max_bytes,
        max_files = EXCLUDED.max_files,
        updated_at = now()
      RETURNING *;
    `.execute(this.getExecutor(trx));

    return mapTenantUsageRow(result.rows[0]);
  }

  async tryReserve(
    namespace: string,
    tenantId: string,
    bytes: bigint | number,
    files = 1,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<boolean> {
    const bytesStr = String(bytes);
    const filesStr = String(files);

    const result = await sql<import('./../types.js').TenantUsageTable>`
      INSERT INTO tenant_usage (namespace, tenant_id, bytes_used, file_count, updated_at)
      VALUES (${namespace}, ${tenantId}, ${bytesStr}::bigint, ${filesStr}::bigint, now())
      ON CONFLICT (namespace, tenant_id)
      DO UPDATE SET
        bytes_used = tenant_usage.bytes_used + EXCLUDED.bytes_used,
        file_count = tenant_usage.file_count + EXCLUDED.file_count,
        updated_at = now()
      WHERE (tenant_usage.max_bytes IS NULL OR tenant_usage.bytes_used + EXCLUDED.bytes_used <= tenant_usage.max_bytes)
        AND (tenant_usage.max_files IS NULL OR tenant_usage.file_count + EXCLUDED.file_count <= tenant_usage.max_files)
      RETURNING *;
    `.execute(this.getExecutor(trx));

    return result.rows.length > 0;
  }

  async release(
    namespace: string,
    tenantId: string,
    bytes: bigint | number,
    files = 1,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<void> {
    const bytesStr = String(bytes);
    const filesStr = String(files);

    await sql`
      UPDATE tenant_usage
      SET
        bytes_used = GREATEST(0::bigint, bytes_used - ${bytesStr}::bigint),
        file_count = GREATEST(0::bigint, file_count - ${filesStr}::bigint),
        updated_at = now()
      WHERE namespace = ${namespace} AND tenant_id = ${tenantId};
    `.execute(this.getExecutor(trx));
  }
}
