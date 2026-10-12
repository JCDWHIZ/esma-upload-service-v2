import { Injectable } from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { BaseRepository } from './base.repository.js';
import type { Database } from '../types.js';
import type {
  FileListFilter,
  FileRecord,
  FileStatus,
  FileStatusUpdate,
  NewFileRecord,
  PaginatedResult,
} from '../../core/types.js';
import { decodeCursor, encodeCursor, mapFileRow } from '../mappers.js';
import {
  NotFoundError,
  OptimisticLockError,
} from '../../core/errors/app-error.js';

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
        scan_status: data.scanStatus ?? 'SKIPPED',
        replication_status: data.replicationStatus ?? 'NOT_REQUIRED',
        primary_provider: data.primaryProvider,
        uploaded_by: data.uploadedBy,
        acting_service: data.actingService ?? null,
        tags: data.tags ?? [],
        attributes: data.attributes ?? {},
        legacy_public_id: data.legacyPublicId ?? null,
        idempotency_key: data.idempotencyKey ?? null,
        correlation_id: data.correlationId,
        expires_at: data.expiresAt ?? null,
        claimed: data.claimed ?? true,
        claimed_at: data.claimedAt !== undefined ? data.claimedAt : data.claimed === false ? null : new Date(),
        unclaimed_expires_at: data.unclaimedExpiresAt ?? null,
        retain_until: data.retainUntil ?? null,
        held: data.held ?? false,
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

  async countBySha256(
    tenantId: string,
    sha256: string,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<number> {
    const result = await this.getExecutor(trx)
      .selectFrom('files')
      .select((eb) => eb.fn.count<string>('id').as('count'))
      .where('tenant_id', '=', tenantId)
      .where('sha256', '=', sha256)
      .where('status', 'in', ['ACTIVE', 'PENDING_UPLOAD'])
      .executeTakeFirst();

    return result ? Number(result.count) : 0;
  }

  async list(
    filter: FileListFilter,
    cursor?: string | null,
    limit = 20,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<PaginatedResult<FileRecord>> {
    const safeLimit = Math.max(1, Math.min(limit, 200));
    let query = this.getExecutor(trx)
      .selectFrom('files')
      .selectAll()
      .where('tenant_id', '=', filter.tenantId);

    if (filter.namespace !== undefined) {
      query = query.where('namespace', '=', filter.namespace);
    }

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
      query = query
        .where('status', '<>', 'DELETED')
        .where('status', '<>', 'DELETING')
        .where('status', '<>', 'PENDING_UPLOAD');
    }

    if (filter.visibility !== undefined) {
      query = query.where('visibility', '=', filter.visibility);
    }

    if (filter.mimetype !== undefined) {
      query = query.where('mimetype', '=', filter.mimetype);
    }

    if (filter.createdFrom !== undefined) {
      query = query.where('created_at', '>=', filter.createdFrom);
    }

    if (filter.createdTo !== undefined) {
      query = query.where('created_at', '<=', filter.createdTo);
    }

    if (filter.tags && filter.tags.length > 0) {
      query = query.where(
        sql<boolean>`${sql.ref('tags')} @> ${filter.tags}::text[]`,
      );
    }

    if (filter.ownerType !== undefined) {
      query = query.where(
        sql<boolean>`${sql.ref('attributes')}->>'ownerType' = ${filter.ownerType}`,
      );
    }

    if (filter.ownerId !== undefined) {
      query = query.where(
        sql<boolean>`${sql.ref('attributes')}->>'ownerId' = ${filter.ownerId}`,
      );
    }

    if (filter.kind !== undefined) {
      query = query.where(
        sql<boolean>`${sql.ref('attributes')}->>'kind' = ${filter.kind}`,
      );
    }

    if (filter.claimed !== undefined) {
      query = query.where('claimed', '=', filter.claimed);
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
    if (updates.sizeBytes !== undefined) {
      updateValues.size_bytes = String(updates.sizeBytes);
    }
    if (updates.expiresAt !== undefined) {
      updateValues.expires_at = updates.expiresAt;
    }
    if (updates.attributes !== undefined) {
      updateValues.attributes = updates.attributes;
    }
    if (updates.derivatives !== undefined) {
      updateValues.derivatives = updates.derivatives;
    }
    if (updates.claimed !== undefined) {
      updateValues.claimed = updates.claimed;
    }
    if (updates.claimedAt !== undefined) {
      updateValues.claimed_at = updates.claimedAt;
    }
    if (updates.unclaimedExpiresAt !== undefined) {
      updateValues.unclaimed_expires_at = updates.unclaimedExpiresAt;
    }
    if (updates.retainUntil !== undefined) {
      updateValues.retain_until = updates.retainUntil;
    }
    if (updates.held !== undefined) {
      updateValues.held = updates.held;
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

  async updateDerivatives(
    id: string,
    derivatives: Record<string, unknown>,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<FileRecord> {
    const result = await this.getExecutor(trx)
      .updateTable('files')
      .set({
        derivatives,
        version: sql`version + 1`,
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();

    if (!result) {
      throw new NotFoundError(`File ${id} not found`);
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

  async hardDelete(
    id: string,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<boolean> {
    const result = await this.getExecutor(trx)
      .deleteFrom('files')
      .where('id', '=', id)
      .executeTakeFirst();

    return Number(result.numDeletedRows) > 0;
  }

  async findExpiredPendingUploads(
    cutoff: Date,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<FileRecord[]> {
    const results = await this.getExecutor(trx)
      .selectFrom('files')
      .selectAll()
      .where('status', '=', 'PENDING_UPLOAD')
      .where('expires_at', '<', cutoff)
      .execute();

    return results.map(mapFileRow);
  }

  async findStaleByStatus(
    status: FileStatus,
    olderThan: Date,
    limit = 50,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<FileRecord[]> {
    const results = await this.getExecutor(trx)
      .selectFrom('files')
      .selectAll()
      .where('status', '=', status)
      .where('updated_at', '<', olderThan)
      .orderBy('updated_at', 'asc')
      .limit(limit)
      .execute();

    return results.map(mapFileRow);
  }

  async hardDeleteTombstones(
    olderThan: Date,
    limit = 100,
    trx?: Transaction<Database> | Kysely<Database>,
    namespace?: string,
  ): Promise<number> {
    const result = await this.getExecutor(trx)
      .deleteFrom('files')
      .where('id', 'in', (eb) => {
        let sub = eb
          .selectFrom('files')
          .select('id')
          .where('status', '=', 'DELETED')
          .where((w) =>
            w.or([
              w('deleted_at', '<', olderThan),
              w('updated_at', '<', olderThan),
            ]),
          );
        if (namespace) {
          sub = sub.where('namespace', '=', namespace);
        }
        return sub.limit(limit);
      })
      .executeTakeFirst();

    return Number(result.numDeletedRows);
  }

  async findByOwner(
    tenantId: string,
    ownerType: string,
    ownerId: string,
    namespace?: string,
    limit = 1000,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<FileRecord[]> {
    let query = this.getExecutor(trx)
      .selectFrom('files')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where(
        sql<boolean>`${sql.ref('attributes')}->>'ownerType' = ${ownerType}`,
      )
      .where(sql<boolean>`${sql.ref('attributes')}->>'ownerId' = ${ownerId}`)
      .where('status', '<>', 'DELETED')
      .where('status', '<>', 'DELETING');

    if (namespace) {
      query = query.where('namespace', '=', namespace);
    }

    const rows = await query
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .execute();
    return rows.map(mapFileRow);
  }

  async countUnclaimedForUser(
    tenantId: string,
    uploadedBy: string,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<{ count: number; totalBytes: number }> {
    const executor = trx ?? this.defaultDb;
    if (!executor) {
      return { count: 0, totalBytes: 0 };
    }
    const result = await executor
      .selectFrom('files')
      .select([
        (eb) => eb.fn.count<string>('id').as('count'),
        (eb) =>
          eb.fn
            .coalesce(eb.fn.sum<string>('size_bytes'), sql<string>`'0'`)
            .as('totalBytes'),
      ])
      .where('tenant_id', '=', tenantId)
      .where('uploaded_by', '=', uploadedBy)
      .where('claimed', '=', false)
      .where('status', 'in', ['ACTIVE', 'PENDING_UPLOAD'])
      .executeTakeFirst();

    return {
      count: result ? Number(result.count) : 0,
      totalBytes: result ? Number(result.totalBytes) : 0,
    };
  }

  async findExpiredUnclaimed(
    now: Date,
    limit = 100,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<FileRecord[]> {
    const rows = await this.getExecutor(trx)
      .selectFrom('files')
      .selectAll()
      .where('claimed', '=', false)
      .where('unclaimed_expires_at', '<=', now)
      .where('status', '<>', 'DELETED')
      .where('status', '<>', 'DELETING')
      .orderBy('unclaimed_expires_at', 'asc')
      .limit(limit)
      .execute();

    return rows.map(mapFileRow);
  }

  async findExpiredRetained(
    now: Date,
    limit = 100,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<FileRecord[]> {
    const rows = await this.getExecutor(trx)
      .selectFrom('files')
      .selectAll()
      .where('retain_until', 'is not', null)
      .where('retain_until', '<=', now)
      .where('held', '=', false)
      .where('status', '<>', 'DELETED')
      .where('status', '<>', 'DELETING')
      .orderBy('retain_until', 'asc')
      .limit(limit)
      .execute();

    return rows.map(mapFileRow);
  }
}
