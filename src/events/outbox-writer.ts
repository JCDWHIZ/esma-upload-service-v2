import { Injectable } from '@nestjs/common';
import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../db/types.js';
import { OutboxRepository } from '../db/repositories/outbox.repository.js';
import { EVENT_CATALOG, type EventType } from './catalog.js';
import type { EventEnvelope } from './envelope.js';
import type { LogicalTopic } from './catalog.js';

/**
 * OutboxWriter is the single point of entry for inserting events into the
 * transactional outbox table. It must be called inside an open DB transaction
 * so the event row and the state change commit atomically.
 *
 * Usage (inside UploadService / DeleteService transaction):
 *   await this.outboxWriter.enqueue(trx, envelope);
 *
 * The topic is derived from EVENT_CATALOG using the envelope eventType;
 * an explicit override can be supplied for exceptional cases.
 */
@Injectable()
export class OutboxWriter {
  constructor(private readonly outboxRepo: OutboxRepository) {}

  /**
   * Enqueue a typed event envelope into the outbox within an existing transaction.
   * The row inherits its topic from the catalog; the partition key is taken from
   * the envelope so that per-file ordering is preserved by the relay.
   */
  async enqueue<T>(
    trx: Transaction<Database> | Kysely<Database>,
    envelope: EventEnvelope<T>,
    topicOverride?: LogicalTopic,
  ): Promise<void> {
    const catalogEntry = EVENT_CATALOG[envelope.eventType as EventType];
    const topic: string =
      topicOverride ?? catalogEntry?.defaultTopic ?? 'audit';

    await this.outboxRepo.enqueue(
      {
        topic,
        partitionKey: envelope.partitionKey,
        eventType: envelope.eventType,
        // The envelope is stored as-is; the relay deserialises and validates it
        // against the catalog schema before publishing.
        envelope: envelope as unknown as Record<string, unknown>,
      },
      trx,
    );
  }
}
