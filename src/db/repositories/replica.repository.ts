import { Injectable } from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { BaseRepository } from './base.repository.js';
import type { Database } from '../types.js';
import type {
  FileReplica,
  NewFileReplica,
  Provider,
  ReplicaAvailableMeta,
  ReplicaStatus,
} from '../../core/types.js';
import { mapReplicaRow } from '../mappers.js';

@Injectable()
export class ReplicaRepository extends BaseRepository {
  async insertMany(
    replicas: NewFileReplica[],
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<FileReplica[]> {
    if (replicas.length === 0) {
      return [];
    }

    const rows = await this.getExecutor(trx)
      .insertInto('file_replicas')
      .values(
        replicas.map((r) => ({
          file_id: r.fileId,
          provider: r.provider,
          role: r.role,
          status: r.status ?? 'QUEUED',
          provider_key: r.providerKey,
          provider_meta: r.providerMeta ?? {},
          url: r.url ?? null,
          etag: r.etag ?? null,
          attempts: r.attempts ?? 0,
          last_error: r.lastError ?? null,
          synced_at: r.syncedAt ?? null,
        })),
      )
      .returningAll()
      .execute();

    return rows.map(mapReplicaRow);
  }

  async listByFile(
    fileId: string,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<FileReplica[]> {
    const rows = await this.getExecutor(trx)
      .selectFrom('file_replicas')
      .selectAll()
      .where('file_id', '=', fileId)
      .orderBy('role', 'asc')
      .execute();

    return rows.map(mapReplicaRow);
  }

  async claim(
    fileId: string,
    provider: Provider,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<boolean> {
    const result = await this.getExecutor(trx)
      .updateTable('file_replicas')
      .set({
        status: 'IN_PROGRESS',
        updated_at: sql`now()`,
      })
      .where('file_id', '=', fileId)
      .where('provider', '=', provider)
      .where('status', '=', 'QUEUED')
      .executeTakeFirst();

    return Number(result.numUpdatedRows) > 0;
  }

  async markAvailable(
    fileId: string,
    provider: Provider,
    meta: ReplicaAvailableMeta = {},
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<void> {
    const updates: Record<string, unknown> = {
      status: 'AVAILABLE',
      synced_at: sql`now()`,
      last_error: null,
    };

    if (meta.url !== undefined) {
      updates.url = meta.url;
    }
    if (meta.etag !== undefined) {
      updates.etag = meta.etag;
    }
    if (meta.providerMeta !== undefined) {
      updates.provider_meta = meta.providerMeta;
    }

    await this.getExecutor(trx)
      .updateTable('file_replicas')
      .set(updates)
      .where('file_id', '=', fileId)
      .where('provider', '=', provider)
      .execute();
  }

  async markFailed(
    fileId: string,
    provider: Provider,
    error: string,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<void> {
    await this.getExecutor(trx)
      .updateTable('file_replicas')
      .set({
        status: 'FAILED',
        last_error: error,
        attempts: sql`attempts + 1`,
      })
      .where('file_id', '=', fileId)
      .where('provider', '=', provider)
      .execute();
  }

  async requeue(
    fileId: string,
    provider: Provider,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<void> {
    await this.getExecutor(trx)
      .updateTable('file_replicas')
      .set({
        status: 'QUEUED',
      })
      .where('file_id', '=', fileId)
      .where('provider', '=', provider)
      .execute();
  }

  async markDeleting(
    fileId: string,
    provider: Provider,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<void> {
    await this.getExecutor(trx)
      .updateTable('file_replicas')
      .set({
        status: 'DELETING',
      })
      .where('file_id', '=', fileId)
      .where('provider', '=', provider)
      .execute();
  }

  async markDeleted(
    fileId: string,
    provider: Provider,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<void> {
    await this.getExecutor(trx)
      .updateTable('file_replicas')
      .set({
        status: 'DELETED',
      })
      .where('file_id', '=', fileId)
      .where('provider', '=', provider)
      .execute();
  }

  async findStale(
    status: ReplicaStatus,
    olderThan: Date,
    limit = 50,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<FileReplica[]> {
    const rows = await this.getExecutor(trx)
      .selectFrom('file_replicas')
      .selectAll()
      .where('status', '=', status)
      .where('updated_at', '<', olderThan)
      .orderBy('updated_at', 'asc')
      .limit(limit)
      .execute();

    return rows.map(mapReplicaRow);
  }
}
