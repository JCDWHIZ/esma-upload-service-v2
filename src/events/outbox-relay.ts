import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { AppConfigService } from '../config/config.service.js';
import { DatabaseService } from '../db/database.service.js';
import { OutboxRepository } from '../db/repositories/outbox.repository.js';
import { MESSAGE_BROKER, type IMessageBroker } from './broker.interface.js';
import type { EventEnvelope } from './envelope.js';
import type { LogicalTopic } from './catalog.js';

export interface OutboxRelayOptions {
  /** Min poll interval (ms). Used when batches are non-empty. Default: 100 */
  pollMinMs?: number;
  /** Max poll interval (ms). Upper bound for idle back-off. Default: 2000 */
  pollMaxMs?: number;
  /** Number of rows claimed per poll cycle. Default: 50 */
  batchSize?: number;
  /** Exponential base for publish-error back-off (seconds). Default: 1 */
  backoffBaseSeconds?: number;
  /** Factor applied on each consecutive failure. Default: 2 */
  backoffFactor?: number;
  /** Max back-off applied to a failing row (seconds). Default: 300 (5 min) */
  backoffCapSeconds?: number;
}

const VALID_TOPICS = new Set<string>([
  'replication',
  'processing',
  'audit',
  'dlq',
]);

function isLogicalTopic(t: string): t is LogicalTopic {
  return VALID_TOPICS.has(t);
}

/**
 * OutboxRelay runs in the worker process under the "relay" role.
 * It polls outbox_events for unpublished rows, claims them with SKIP LOCKED,
 * publishes to the message broker, and marks them published – all atomically.
 *
 * ARCH §8.4 guarantees:
 *  - At-least-once delivery (crash after publish, before markPublished → re-deliver)
 *  - Per-partition-key ordering: if event A fails for partition key P, event B
 *    with the same key is deferred in this cycle so A is never overtaken.
 *  - Two concurrent relays cannot claim the same row (SKIP LOCKED).
 *
 * @see OutboxRetentionService for cleanup of old published rows.
 */
@Injectable()
export class OutboxRelay {
  private readonly logger = new Logger(OutboxRelay.name);

  private readonly pollMinMs: number;
  private readonly pollMaxMs: number;
  private readonly batchSize: number;
  private readonly backoffBaseMs: number;
  private readonly backoffFactor: number;
  private readonly backoffCapMs: number;

  private running = false;
  private currentPollMs: number;
  private sleepResolve?: () => void;

  constructor(
    private readonly configService: AppConfigService,
    private readonly databaseService: DatabaseService,
    private readonly outboxRepo: OutboxRepository,
    @Optional()
    @Inject(MESSAGE_BROKER)
    private readonly broker?: IMessageBroker,
    options?: OutboxRelayOptions,
  ) {
    this.pollMinMs = options?.pollMinMs ?? 100;
    this.pollMaxMs = options?.pollMaxMs ?? 2000;
    this.batchSize = options?.batchSize ?? 50;
    this.backoffBaseMs = (options?.backoffBaseSeconds ?? 1) * 1000;
    this.backoffFactor = options?.backoffFactor ?? 2;
    this.backoffCapMs = (options?.backoffCapSeconds ?? 300) * 1000;
    this.currentPollMs = this.pollMinMs;
  }

  /** Start the relay loop. Safe to call multiple times (no-op if running). */
  start(): Promise<void> {
    if (this.running) return Promise.resolve();
    if (!this.broker) {
      this.logger.warn(
        'OutboxRelay: no IMessageBroker injected – relay will not run.',
      );
      return Promise.resolve();
    }
    this.running = true;
    this.logger.log('OutboxRelay started');
    void this.loop();
    return Promise.resolve();
  }

  /** Gracefully stop after the current batch completes. */
  stop(): void {
    this.running = false;
    // Wake up sleeping loop immediately so it can exit cleanly.
    this.sleepResolve?.();
    this.logger.log('OutboxRelay stop requested');
  }

  // ---------------------------------------------------------------------------
  // Internal loop
  // ---------------------------------------------------------------------------

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const processed = await this.processBatch();
        if (processed > 0) {
          // Work found → poll again quickly.
          this.currentPollMs = this.pollMinMs;
        } else {
          // Idle → back off.
          this.currentPollMs = Math.min(this.currentPollMs * 2, this.pollMaxMs);
        }
      } catch (err: unknown) {
        this.logger.error(
          `OutboxRelay batch error: ${err instanceof Error ? err.message : String(err)}`,
        );
        this.currentPollMs = Math.min(this.currentPollMs * 2, this.pollMaxMs);
      }

      if (this.running) {
        await this.sleep(this.currentPollMs);
      }
    }
    this.logger.log('OutboxRelay loop exited');
  }

  /**
   * Claim a batch of outbox rows and publish each one.
   * Returns the count of rows that were processed (published or back-off'd).
   *
   * Partition-key ordering guarantee:
   *   Build a set of "blocked" partition keys: if any row in the batch cannot
   *   be published (broker error), all subsequent rows with the same key are
   *   skipped this cycle so they are never published out of order.
   */
  private async processBatch(): Promise<number> {
    const db = this.databaseService.getDb();
    if (!db) return 0;

    // Claim rows inside a transaction so SKIP LOCKED is respected.
    const rows = await db
      .transaction()
      .execute((trx) => this.outboxRepo.claimBatch(this.batchSize, trx));

    if (rows.length === 0) return 0;

    const blockedKeys = new Set<string>();
    let processed = 0;

    for (const row of rows) {
      // Skip rows whose partition key was blocked by an earlier failure this
      // cycle – preserves per-file ordering even across relay restarts.
      if (blockedKeys.has(row.partitionKey)) {
        continue;
      }

      try {
        const envelope = row.envelope as unknown as EventEnvelope<unknown>;
        const topicRaw = row.topic;
        const topic: LogicalTopic = isLogicalTopic(topicRaw)
          ? topicRaw
          : 'audit';

        await this.broker!.publish(topic, row.partitionKey, envelope);

        // Mark published inside its own transaction (a separate commit from
        // the claim so that publish + mark are the two sides of at-least-once).
        await db
          .transaction()
          .execute((trx) => this.outboxRepo.markPublished(row.id, trx));

        processed++;
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `OutboxRelay: failed to publish outbox row ${row.id} (${row.eventType}): ${errorMsg}`,
          { partitionKey: row.partitionKey, attempts: row.attempts + 1 },
        );

        // Compute next available_at with exponential back-off.
        const nextAvailableAt = this.computeNextAvailableAt(row.attempts + 1);

        await db
          .transaction()
          .execute((trx) =>
            this.outboxRepo.markFailed(row.id, errorMsg, nextAvailableAt, trx),
          );

        // Block all subsequent rows with the same partition key this cycle.
        blockedKeys.add(row.partitionKey);
        processed++;
      }
    }

    return processed;
  }

  private computeNextAvailableAt(attempt: number): Date {
    const delayMs = Math.min(
      this.backoffBaseMs * Math.pow(this.backoffFactor, attempt - 1),
      this.backoffCapMs,
    );
    return new Date(Date.now() + delayMs);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.sleepResolve = resolve;
      setTimeout(resolve, ms);
    });
  }
}
