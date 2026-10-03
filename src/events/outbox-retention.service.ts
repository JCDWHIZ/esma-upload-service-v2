import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/config.service.js';
import { DatabaseService } from '../db/database.service.js';
import { OutboxRepository } from '../db/repositories/outbox.repository.js';

/**
 * OutboxRetentionService removes published outbox_events rows that are older
 * than OUTBOX_RETENTION_HOURS (default 72).
 *
 * It runs as a periodic job in the worker's "relay" role.
 * Rows are deleted in capped batches (default 1000) to avoid holding
 * long-lived locks on the outbox_events table.
 *
 * ARCH §8.4: "A retention job deletes published rows older than
 * OUTBOX_RETENTION_HOURS (default 72)."
 */
@Injectable()
export class OutboxRetentionService {
  private readonly logger = new Logger(OutboxRetentionService.name);
  private intervalHandle?: ReturnType<typeof setInterval>;

  /** Rows deleted per sweep pass. Kept small to limit lock contention. */
  private static readonly BATCH_LIMIT = 1000;

  /** How often the retention sweep runs (ms). */
  private static readonly SWEEP_INTERVAL_MS = 10 * 60 * 1000; // 10 min

  constructor(
    private readonly configService: AppConfigService,
    private readonly databaseService: DatabaseService,
    private readonly outboxRepo: OutboxRepository,
  ) {}

  start(): void {
    if (this.intervalHandle) return;
    this.logger.log('OutboxRetentionService started');
    // Run immediately on start, then on interval.
    void this.sweep();
    this.intervalHandle = setInterval(
      () => void this.sweep(),
      OutboxRetentionService.SWEEP_INTERVAL_MS,
    );
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
    }
    this.logger.log('OutboxRetentionService stopped');
  }

  /** Exposed for testing. */
  async sweep(): Promise<number> {
    const db = this.databaseService.getDb();
    if (!db) return 0;

    const retentionHours = this.configService.outboxRetentionHours;
    const cutoff = new Date(Date.now() - retentionHours * 60 * 60 * 1000);

    try {
      const deleted = await this.outboxRepo.deletePublishedOlderThan(
        cutoff,
        OutboxRetentionService.BATCH_LIMIT,
      );
      if (deleted > 0) {
        this.logger.log(
          `OutboxRetention: deleted ${deleted} published rows older than ${retentionHours}h`,
        );
      }
      return deleted;
    } catch (err: unknown) {
      this.logger.error(
        `OutboxRetention sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }
}
