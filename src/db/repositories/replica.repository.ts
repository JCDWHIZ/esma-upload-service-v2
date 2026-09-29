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
  ReplicationStatus,
} from '../../core/types.js';
import { mapReplicaRow } from '../mappers.js';
import { deriveReplicationStatus } from '../../core/replication-state.js';

export interface ClaimOptions {
  readonly allowStaleSec?: number;
}

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
          ...(r.createdAt ? { created_at: r.createdAt } : {}),
          ...(r.updatedAt ? { updated_at: r.updatedAt } : {}),
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

  /**
   * Recomputes files.replication_status based on current secondary replica states.
   * Conforms to ARCH §5.2.
   */
  async recomputeFileReplicationStatus(
    fileId: string,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<ReplicationStatus> {
    const rows = await this.getExecutor(trx)
      .selectFrom('file_replicas')
      .select(['status', 'role'])
      .where('file_id', '=', fileId)
      .execute();

    const newStatus = deriveReplicationStatus(
      rows.map((r) => ({
        status: r.status,
        role: r.role,
      })),
    );

    await this.getExecutor(trx)
      .updateTable('files')
      .set({
        replication_status: newStatus,
        updated_at: sql`now()`,
      })
      .where('id', '=', fileId)
      .execute();

    return newStatus;
  }

  /**
   * Claims a replica for processing via CAS (QUEUED -> IN_PROGRESS),
   * optionally reclaiming an expired IN_PROGRESS lease older than allowStaleSec.
   */
  async claim(
    fileId: string,
    provider: Provider,
    options?: ClaimOptions,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<boolean> {
    const executor = this.getExecutor(trx);
    let result;

    if (options?.allowStaleSec !== undefined && options.allowStaleSec > 0) {
      result = await executor
        .updateTable('file_replicas')
        .set({
          status: 'IN_PROGRESS',
          updated_at: sql`now()`,
        })
        .where('file_id', '=', fileId)
        .where('provider', '=', provider)
        .where((eb) =>
          eb.or([
            eb('status', '=', 'QUEUED'),
            eb.and([
              eb('status', '=', 'IN_PROGRESS'),
              eb(
                'updated_at',
                '<',
                sql<Date>`now() - (${sql.raw(String(options.allowStaleSec))} * interval '1 second')`,
              ),
            ]),
          ]),
        )
        .executeTakeFirst();
    } else {
      result = await executor
        .updateTable('file_replicas')
        .set({
          status: 'IN_PROGRESS',
          updated_at: sql`now()`,
        })
        .where('file_id', '=', fileId)
        .where('provider', '=', provider)
        .where('status', '=', 'QUEUED')
        .executeTakeFirst();
    }

    const updated = Number(result.numUpdatedRows) > 0;
    if (updated) {
      await this.recomputeFileReplicationStatus(fileId, trx);
    }
    return updated;
  }

  /**
   * Completes a replica copy via CAS (IN_PROGRESS -> AVAILABLE).
   */
  async complete(
    fileId: string,
    provider: Provider,
    meta: ReplicaAvailableMeta = {},
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<boolean> {
    const updates: Record<string, unknown> = {
      status: 'AVAILABLE',
      synced_at: sql`now()`,
      updated_at: sql`now()`,
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

    const result = await this.getExecutor(trx)
      .updateTable('file_replicas')
      .set(updates)
      .where('file_id', '=', fileId)
      .where('provider', '=', provider)
      .where('status', 'in', ['IN_PROGRESS', 'QUEUED'])
      .executeTakeFirst();

    const updated = Number(result.numUpdatedRows) > 0;
    if (updated) {
      await this.recomputeFileReplicationStatus(fileId, trx);
    }
    return updated;
  }

  /**
   * Backwards-compatible alias for complete().
   */
  async markAvailable(
    fileId: string,
    provider: Provider,
    meta: ReplicaAvailableMeta = {},
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<boolean> {
    return this.complete(fileId, provider, meta, trx);
  }

  /**
   * Records a retryable replication failure via CAS (IN_PROGRESS -> QUEUED).
   */
  async retry(
    fileId: string,
    provider: Provider,
    error: string,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<boolean> {
    const result = await this.getExecutor(trx)
      .updateTable('file_replicas')
      .set({
        status: 'QUEUED',
        last_error: error,
        attempts: sql`attempts + 1`,
        updated_at: sql`now()`,
      })
      .where('file_id', '=', fileId)
      .where('provider', '=', provider)
      .where('status', 'in', ['IN_PROGRESS', 'FAILED'])
      .executeTakeFirst();

    const updated = Number(result.numUpdatedRows) > 0;
    if (updated) {
      await this.recomputeFileReplicationStatus(fileId, trx);
    }
    return updated;
  }

  /**
   * Backwards-compatible alias for retry().
   */
  async requeue(
    fileId: string,
    provider: Provider,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<boolean> {
    return this.retry(fileId, provider, 'Requeued', trx);
  }

  /**
   * Records exhausted replication attempts via CAS (IN_PROGRESS -> FAILED).
   */
  async fail(
    fileId: string,
    provider: Provider,
    error: string,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<boolean> {
    const result = await this.getExecutor(trx)
      .updateTable('file_replicas')
      .set({
        status: 'FAILED',
        last_error: error,
        attempts: sql`attempts + 1`,
        updated_at: sql`now()`,
      })
      .where('file_id', '=', fileId)
      .where('provider', '=', provider)
      .where('status', '=', 'IN_PROGRESS')
      .executeTakeFirst();

    const updated = Number(result.numUpdatedRows) > 0;
    if (updated) {
      await this.recomputeFileReplicationStatus(fileId, trx);
    }
    return updated;
  }

  /**
   * Backwards-compatible alias for fail().
   */
  async markFailed(
    fileId: string,
    provider: Provider,
    error: string,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<boolean> {
    return this.fail(fileId, provider, error, trx);
  }

  /**
   * Redrives a previously failed replica via CAS (FAILED -> QUEUED).
   */
  async redrive(
    fileId: string,
    provider: Provider,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<boolean> {
    const result = await this.getExecutor(trx)
      .updateTable('file_replicas')
      .set({
        status: 'QUEUED',
        last_error: null,
        updated_at: sql`now()`,
      })
      .where('file_id', '=', fileId)
      .where('provider', '=', provider)
      .where('status', '=', 'FAILED')
      .executeTakeFirst();

    const updated = Number(result.numUpdatedRows) > 0;
    if (updated) {
      await this.recomputeFileReplicationStatus(fileId, trx);
    }
    return updated;
  }

  /**
   * Marks a replica as DELETING via CAS (AVAILABLE | IN_PROGRESS | FAILED | QUEUED -> DELETING).
   */
  async markDeleting(
    fileId: string,
    provider: Provider,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<boolean> {
    const result = await this.getExecutor(trx)
      .updateTable('file_replicas')
      .set({
        status: 'DELETING',
        updated_at: sql`now()`,
      })
      .where('file_id', '=', fileId)
      .where('provider', '=', provider)
      .where('status', 'in', ['AVAILABLE', 'IN_PROGRESS', 'FAILED', 'QUEUED'])
      .executeTakeFirst();

    const updated = Number(result.numUpdatedRows) > 0;
    if (updated) {
      await this.recomputeFileReplicationStatus(fileId, trx);
    }
    return updated;
  }

  /**
   * Finalizes deletion via CAS (DELETING | QUEUED | FAILED -> DELETED).
   */
  async markDeleted(
    fileId: string,
    provider: Provider,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<boolean> {
    const result = await this.getExecutor(trx)
      .updateTable('file_replicas')
      .set({
        status: 'DELETED',
        updated_at: sql`now()`,
      })
      .where('file_id', '=', fileId)
      .where('provider', '=', provider)
      .where('status', 'in', ['DELETING', 'QUEUED', 'FAILED'])
      .executeTakeFirst();

    const updated = Number(result.numUpdatedRows) > 0;
    if (updated) {
      await this.recomputeFileReplicationStatus(fileId, trx);
    }
    return updated;
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
