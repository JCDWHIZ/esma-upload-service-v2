import { Injectable } from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { BaseRepository } from './base.repository.js';
import type { Database } from '../types.js';

@Injectable()
export class ProcessedEventsRepository extends BaseRepository {
  async tryMark(
    consumer: string,
    eventId: string,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<boolean> {
    const result = await sql<import('./../types.js').ProcessedEventsTable>`
      INSERT INTO processed_events (consumer, event_id, processed_at)
      VALUES (${consumer}, ${eventId}::uuid, now())
      ON CONFLICT (consumer, event_id) DO NOTHING
      RETURNING *;
    `.execute(this.getExecutor(trx));

    return result.rows.length > 0;
  }
}
