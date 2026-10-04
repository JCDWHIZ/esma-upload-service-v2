import { Injectable } from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { BaseRepository } from './base.repository.js';
import type { Database } from '../types.js';
import type {
  DeadLetterFilter,
  DeadLetterRecord,
  DeadLetterStatus,
  NewDeadLetterRecord,
  PaginatedResult,
} from '../../core/types.js';
import { decodeCursor, encodeCursor, mapDeadLetterRow } from '../mappers.js';

@Injectable()
export class DeadLetterRepository extends BaseRepository {
  async insert(
    entry: NewDeadLetterRecord,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<DeadLetterRecord> {
    const id = entry.id ?? uuidv7();
    const result = await this.getExecutor(trx)
      .insertInto('dead_letters')
      .values({
        id,
        received_at: entry.receivedAt ?? sql<Date>`now()`,
        original_topic: entry.originalTopic,
        event_type: entry.eventType,
        event_id: entry.eventId,
        envelope: entry.envelope,
        error: entry.error,
        attempts: entry.attempts ?? 1,
        status: entry.status ?? 'OPEN',
        resolved_at: entry.resolvedAt ?? null,
        resolved_by: entry.resolvedBy ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return mapDeadLetterRow(result);
  }

  async findById(
    id: string,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<DeadLetterRecord | null> {
    const row = await this.getExecutor(trx)
      .selectFrom('dead_letters')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    return row ? mapDeadLetterRow(row) : null;
  }

  async findByEventId(
    eventId: string,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<DeadLetterRecord | null> {
    const row = await this.getExecutor(trx)
      .selectFrom('dead_letters')
      .selectAll()
      .where('event_id', '=', eventId)
      .executeTakeFirst();

    return row ? mapDeadLetterRow(row) : null;
  }

  async query(
    filter: DeadLetterFilter = {},
    cursor?: string | null,
    limit = 50,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<PaginatedResult<DeadLetterRecord>> {
    const safeLimit = Math.max(1, Math.min(limit, 200));
    let qb = this.getExecutor(trx).selectFrom('dead_letters').selectAll();

    if (filter.status) {
      qb = qb.where('status', '=', filter.status);
    }
    if (filter.originalTopic) {
      qb = qb.where('original_topic', '=', filter.originalTopic);
    }
    if (filter.eventType) {
      qb = qb.where('event_type', '=', filter.eventType);
    }
    if (filter.from) {
      qb = qb.where('received_at', '>=', filter.from);
    }
    if (filter.to) {
      qb = qb.where('received_at', '<=', filter.to);
    }

    if (cursor) {
      const decoded = decodeCursor(cursor);
      if (decoded) {
        qb = qb.where((eb) =>
          eb.or([
            eb('received_at', '<', decoded.createdAt),
            eb.and([
              eb('received_at', '=', decoded.createdAt),
              eb('id', '<', decoded.id),
            ]),
          ]),
        );
      }
    }

    qb = qb
      .orderBy('received_at', 'desc')
      .orderBy('id', 'desc')
      .limit(safeLimit + 1);

    const rows = await qb.execute();
    const hasMore = rows.length > safeLimit;
    const items = hasMore ? rows.slice(0, safeLimit) : rows;
    const mapped = items.map(mapDeadLetterRow);

    let nextCursor: string | null = null;
    if (hasMore && mapped.length > 0) {
      const last = mapped[mapped.length - 1];
      nextCursor = encodeCursor({
        createdAt: last.receivedAt,
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
    status: DeadLetterStatus,
    resolvedBy?: string | null,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<DeadLetterRecord | null> {
    const row = await this.getExecutor(trx)
      .updateTable('dead_letters')
      .set({
        status,
        resolved_at: sql<Date>`now()`,
        resolved_by: resolvedBy ?? null,
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();

    return row ? mapDeadLetterRow(row) : null;
  }

  async countOpen(
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<number> {
    const res = await this.getExecutor(trx)
      .selectFrom('dead_letters')
      .select(sql<string>`count(*)`.as('count'))
      .where('status', '=', 'OPEN')
      .executeTakeFirst();

    return res?.count ? parseInt(res.count, 10) : 0;
  }
}
