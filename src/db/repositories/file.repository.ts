import { Injectable } from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { BaseRepository } from './base.repository.js';
import type { Database } from '../types.js';
import type {
  FileListFilter,
  FileRecord,
  FileStatusUpdate,
  NewFileRecord,
  PaginatedResult,
} from '../../core/types.js';
import { decodeCursor, encodeCursor, mapFileRow } from '../mappers.js';
import { OptimisticLockError } from '../../core/errors/app-error.js';

@Injectable()
export class FileRepository extends BaseRepository {
  async insert(
    data: NewFileRecord,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<FileRecord> {
    const id = data.id ?? uuidv7();
    const result = await this.getExecutor(trx)
      .insertInto('files')
      .values({
        id,
        namespace: data.namespace,
        tenant_id: data.tenantId,
        sub_tenant_id: data.subTenantId ?? null,
        folder: data.folder ?? '',
        storage_key: data.storageKey,
        original_filename: data.originalFilename,
        mimetype: data.mimetype,
        declared_mimetype: data.declaredMimetype ?? null,
        size_bytes: String(data.sizeBytes),
        sha256: data.sha256 ?? null,
        visibility: data.visibility,
        status: data.status ?? 'ACTIVE',
        scan_status: data.scanStatus ?? 'NOT_REQUIRED',
        replication_status: data.replicationStatus ?? 'NOT_REQUIRED',
        primary_provider: data.primaryProvider,
        uploaded_by: data.uploadedBy,
        tags: data.tags ?? [],
        attributes: data.attributes ?? {},
        legacy_public_id: data.legacyPublicId ?? null,
        idempotency_key: data.idempotencyKey ?? null,
        correlation_id: data.correlationId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return mapFileRow(result);
  }

  async findById(
    id: string,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<FileRecord | null> {
    const result = await this.getExecutor(trx)
      .selectFrom('files')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    return result ? mapFileRow(result) : null;
  }

  async findByLegacyPublicId(
    legacyPublicId: string,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<FileRecord | null> {
    const result = await this.getExecutor(trx)
      .selectFrom('files')
      .selectAll()
      .where('legacy_public_id', '=', legacyPublicId)
      .executeTakeFirst();

    return result ? mapFileRow(result) : null;
  }

  async findByIdempotencyKey(
    namespace: string,
    tenantId: string,
    idempotencyKey: string,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<FileRecord | null> {
    const result = await this.getExecutor(trx)
      .selectFrom('files')
      .selectAll()
      .where('namespace', '=', namespace)
      .where('tenant_id', '=', tenantId)
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirst();

    return result ? mapFileRow(result) : null;
  }

  async list(
    filter: FileListFilter,
    cursor?: string | null,
    limit = 20,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<PaginatedResult<FileRecord>> {
    const safeLimit = Math.max(1, Math.min(limit, 100));
    let query = this.getExecutor(trx)
      .selectFrom('files')
      .selectAll()
      .where('namespace', '=', filter.namespace)
      .where('tenant_id', '=', filter.tenantId);

    if (filter.subTenantId !== undefined) {
      if (filter.subTenantId === null) {
        query = query.where('sub_tenant_id', 'is', null);
      } else {
        query = query.where('sub_tenant_id', '=', filter.subTenantId);
      }
    }

    if (filter.folder !== undefined) {
      query = query.where('folder', '=', filter.folder);
    }

    if (filter.status !== undefined) {
      query = query.where('status', '=', filter.status);
    } else {
      query = query.where('status', '<>', 'DELETED');
    }

    if (filter.visibility !== undefined) {
      query = query.where('visibility', '=', filter.visibility);
    }

    if (filter.tags && filter.tags.length > 0) {
      query = query.where(
        sql<boolean>`${sql.ref('tags')} @> ${filter.tags}::text[]`,
      );
    }

    if (cursor) {
      const decoded = decodeCursor(cursor);
      if (decoded) {
        query = query.where((eb) =>
          eb.or([
            eb('created_at', '<', decoded.createdAt),
            eb.and([
              eb('created_at', '=', decoded.createdAt),
              eb('id', '<', decoded.id),
            ]),
          ]),
        );
      }
    }

    query = query
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(safeLimit + 1);

    const rows = await query.execute();
    const hasMore = rows.length > safeLimit;
    const items = hasMore ? rows.slice(0, safeLimit) : rows;
    const mapped = items.map(mapFileRow);

    let nextCursor: string | null = null;
    if (hasMore && mapped.length > 0) {
      const last = mapped[mapped.length - 1];
      nextCursor = encodeCursor({
        createdAt: last.createdAt,
        id: last.id,
      });
    }

    return {
      items: mapped,
      nextCursor,
      hasMore,
    };
  }

  async updateStatus(
    id: string,
    currentVersion: number,
    updates: FileStatusUpdate,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<FileRecord> {
    const updateValues: Record<string, unknown> = {
      version: sql`version + 1`,
    };

    if (updates.status !== undefined) {
      updateValues.status = updates.status;
    }
    if (updates.scanStatus !== undefined) {
      updateValues.scan_status = updates.scanStatus;
    }
    if (updates.replicationStatus !== undefined) {
      updateValues.replication_status = updates.replicationStatus;
    }
    if (updates.sha256 !== undefined) {
      updateValues.sha256 = updates.sha256;
    }
    if (updates.attributes !== undefined) {
      updateValues.attributes = updates.attributes;
    }

    const result = await this.getExecutor(trx)
      .updateTable('files')
      .set(updateValues)
      .where('id', '=', id)
      .where('version', '=', currentVersion)
      .returningAll()
      .executeTakeFirst();

    if (!result) {
      throw new OptimisticLockError(
        `Optimistic lock collision updating file ${id} at version ${currentVersion}`,
      );
    }

    return mapFileRow(result);
  }

  async markDeleting(
    id: string,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<boolean> {
    const result = await this.getExecutor(trx)
      .updateTable('files')
      .set({ status: 'DELETING' })
      .where('id', '=', id)
      .where('status', '<>', 'DELETED')
      .executeTakeFirst();

    return Number(result.numUpdatedRows) > 0;
  }

  async markDeleted(
    id: string,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<boolean> {
    const result = await this.getExecutor(trx)
      .updateTable('files')
      .set({
        status: 'DELETED',
        deleted_at: sql`now()`,
      })
      .where('id', '=', id)
      .executeTakeFirst();

    return Number(result.numUpdatedRows) > 0;
  }
}
