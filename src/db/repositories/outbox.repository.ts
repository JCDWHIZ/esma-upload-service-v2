import { Injectable } from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { BaseRepository } from './base.repository.js';
import type { Database } from '../types.js';
import type { NewOutboxEvent, OutboxEvent } from '../../core/types.js';
import { mapOutboxRow } from '../mappers.js';

@Injectable()
export class OutboxRepository extends BaseRepository {
  async enqueue(
    event: NewOutboxEvent,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<OutboxEvent> {
    const id = event.id ?? uuidv7();
    const result = await this.getExecutor(trx)
      .insertInto('outbox_events')
      .values({
        id,
        topic: event.topic,
        partition_key: event.partitionKey,
        event_type: event.eventType,
        envelope: event.envelope,
        available_at: event.availableAt ?? sql<Date>`now()`,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return mapOutboxRow(result);
  }

  async claimBatch(
    limit = 50,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<OutboxEvent[]> {
    const safeLimit = Math.max(1, Math.min(limit, 500));
    const rows = await this.getExecutor(trx)
      .selectFrom('outbox_events')
      .selectAll()
      .where('published_at', 'is', null)
      .where(sql<boolean>`available_at <= now()`)
      .orderBy('created_at', 'asc')
      .limit(safeLimit)
      .forUpdate()
      .skipLocked()
      .execute();

    return rows.map(mapOutboxRow);
  }

  async markPublished(
    id: string,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<void> {
    await this.getExecutor(trx)
      .updateTable('outbox_events')
      .set({
        published_at: sql`now()`,
      })
      .where('id', '=', id)
      .execute();
  }

  async markFailed(
    id: string,
    error: string,
    nextAvailableAt: Date,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<void> {
    await this.getExecutor(trx)
      .updateTable('outbox_events')
      .set({
        attempts: sql`attempts + 1`,
        last_error: error,
        available_at: nextAvailableAt,
      })
      .where('id', '=', id)
      .execute();
  }

  async deletePublishedOlderThan(
    cutoff: Date,
    limit = 1000,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<number> {
    const result = await this.getExecutor(trx)
      .deleteFrom('outbox_events')
      .where('id', 'in', (eb) =>
        eb
          .selectFrom('outbox_events')
          .select('id')
          .where('published_at', 'is not', null)
          .where('published_at', '<', cutoff)
          .limit(limit),
      )
      .executeTakeFirst();

    return Number(result.numDeletedRows);
  }
}
