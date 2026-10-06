import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { sql } from 'kysely';
import { AppConfigService } from '../config/config.service.js';
import { PolicyRegistry } from '../config/policy-registry.js';
import { DatabaseService } from '../db/database.service.js';
import { FileRepository } from '../db/repositories/file.repository.js';
import { ReplicaRepository } from '../db/repositories/replica.repository.js';
import { OutboxRepository } from '../db/repositories/outbox.repository.js';
import { IdempotencyRepository } from '../db/repositories/idempotency.repository.js';
import { OutboxWriter } from '../events/outbox-writer.js';
import { createEnvelope } from '../events/envelope.js';
import { EVENT_TYPES } from '../events/catalog.js';

export interface SweeperSweepResult {
  stuckQueuedReenqueued: number;
  staleLeasesReset: number;
  stuckDeletingReenqueued: number;
  autoRedriven: number;
  tombstonesHardDeleted: number;
  quarantinedPurged: number;
  outboxCleaned: number;
  stagingCleaned: number;
  idempotencyKeysCleaned: number;
}

@Injectable()
export class SweeperService implements OnApplicationShutdown {
  private readonly logger = new Logger(SweeperService.name);
  private timer: NodeJS.Timeout | null = null;
  private isSweeping = false;

  constructor(
    private readonly configService: AppConfigService,
    private readonly db: DatabaseService,
    private readonly fileRepo: FileRepository,
    private readonly replicaRepo: ReplicaRepository,
    private readonly outboxRepo: OutboxRepository,
    private readonly outboxWriter: OutboxWriter,
    private readonly idempotencyRepo?: IdempotencyRepository,
    @Optional() private readonly policyRegistry?: PolicyRegistry,
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }
    const intervalMs = Math.max(
      5000,
      this.configService.sweepIntervalSeconds * 1000,
    );
    this.logger.log(
      `SweeperService starting: interval=${this.configService.sweepIntervalSeconds}s`,
    );

    this.timer = setInterval(() => {
      void this.runSweepCycle();
    }, intervalMs);

    // Initial trigger
    void this.runSweepCycle();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.logger.log('SweeperService stopped');
    }
  }

  onApplicationShutdown(): void {
    this.stop();
  }

  /**
   * Runs one full sweep cycle across all background maintenance jobs.
   */
  async runSweepCycle(): Promise<SweeperSweepResult> {
    if (this.isSweeping) {
      return {
        stuckQueuedReenqueued: 0,
        staleLeasesReset: 0,
        stuckDeletingReenqueued: 0,
        autoRedriven: 0,
        tombstonesHardDeleted: 0,
        quarantinedPurged: 0,
        outboxCleaned: 0,
        stagingCleaned: 0,
        idempotencyKeysCleaned: 0,
      };
    }

    this.isSweeping = true;
    try {
      const stuckQueuedReenqueued = await this.sweepStuckQueued();
      const staleLeasesReset = await this.sweepStaleLeases();
      const stuckDeletingReenqueued = await this.sweepStuckDeleting();
      const autoRedriven = await this.sweepAutoRedrive();
      const tombstonesHardDeleted = await this.sweepTombstones();
      const quarantinedPurged = await this.sweepQuarantined();
      const outboxCleaned = await this.sweepOutbox();
      const stagingCleaned = await this.sweepStaging();
      const idempotencyKeysCleaned = await this.sweepIdempotencyKeys();

      return {
        stuckQueuedReenqueued,
        staleLeasesReset,
        stuckDeletingReenqueued,
        autoRedriven,
        tombstonesHardDeleted,
        quarantinedPurged,
        outboxCleaned,
        stagingCleaned,
        idempotencyKeysCleaned,
      };
    } catch (err: unknown) {
      this.logger.error(`Error during sweep cycle: ${String(err)}`);
      return {
        stuckQueuedReenqueued: 0,
        staleLeasesReset: 0,
        stuckDeletingReenqueued: 0,
        autoRedriven: 0,
        tombstonesHardDeleted: 0,
        quarantinedPurged: 0,
        outboxCleaned: 0,
        stagingCleaned: 0,
        idempotencyKeysCleaned: 0,
      };
    } finally {
      this.isSweeping = false;
    }
  }

  /**
   * 1. Stuck queued sweep: Finds QUEUED replicas older than SWEEP_QUEUED_AFTER_MINUTES
   * with no pending outbox row, and re-enqueues 'file.replicate'.
   */
  async sweepStuckQueued(dryRun = false): Promise<number> {
    const database = this.db.getDb();
    if (!database) return 0;

    const cutoff = new Date(
      Date.now() - this.configService.sweepQueuedAfterMinutes * 60 * 1000,
    );

    return database.transaction().execute(async (trx) => {
      // Leader election lock
      const lock = await sql<{
        locked: boolean;
      }>`SELECT pg_try_advisory_xact_lock(hashtext('sweeper_stuck_queued')) AS locked`.execute(
        trx,
      );
      if (!lock.rows[0]?.locked) {
        return 0;
      }

      const stuckReplicas =
        await this.replicaRepo.findQueuedWithoutUnpublishedOutbox(
          cutoff,
          50,
          trx,
        );
      if (stuckReplicas.length === 0) {
        return 0;
      }

      if (dryRun) {
        this.logger.log(
          `[DRY-RUN] Stuck queued sweep: found ${stuckReplicas.length} replicas`,
        );
        return stuckReplicas.length;
      }

      let count = 0;
      for (const replica of stuckReplicas) {
        const file = await this.fileRepo.findById(replica.fileId, trx);
        if (!file || file.status !== 'ACTIVE') continue;

        const envelope = createEnvelope({
          eventType: EVENT_TYPES.FILE_REPLICATE,
          partitionKey: replica.fileId,
          payload: { fileId: replica.fileId, targetProvider: replica.provider },
          namespace: file.namespace,
          tenantId: file.tenantId,
        });

        await this.outboxWriter.enqueue(trx, envelope);
        count++;
      }

      if (count > 0) {
        this.logger.log(
          `Stuck queued sweep: re-enqueued ${count} file.replicate events`,
        );
      }
      return count;
    });
  }

  /**
   * 2. Stale lease sweep: Resets IN_PROGRESS replicas whose updated_at is older than SWEEP_LEASE_TIMEOUT_MINUTES
   * back to QUEUED, and re-enqueues 'file.replicate'.
   */
  async sweepStaleLeases(dryRun = false): Promise<number> {
    const database = this.db.getDb();
    if (!database) return 0;

    const cutoff = new Date(
      Date.now() - this.configService.sweepLeaseTimeoutMinutes * 60 * 1000,
    );

    return database.transaction().execute(async (trx) => {
      const lock = await sql<{
        locked: boolean;
      }>`SELECT pg_try_advisory_xact_lock(hashtext('sweeper_stale_leases')) AS locked`.execute(
        trx,
      );
      if (!lock.rows[0]?.locked) {
        return 0;
      }

      const staleReplicas = await this.replicaRepo.findStale(
        'IN_PROGRESS',
        cutoff,
        50,
        trx,
      );
      if (staleReplicas.length === 0) {
        return 0;
      }

      if (dryRun) {
        this.logger.log(
          `[DRY-RUN] Stale lease sweep: found ${staleReplicas.length} stuck IN_PROGRESS replicas`,
        );
        return staleReplicas.length;
      }

      let count = 0;
      for (const replica of staleReplicas) {
        await this.replicaRepo.retry(
          replica.fileId,
          replica.provider,
          'Lease expired by sweeper',
          trx,
        );

        const file = await this.fileRepo.findById(replica.fileId, trx);
        if (file && file.status === 'ACTIVE') {
          const envelope = createEnvelope({
            eventType: EVENT_TYPES.FILE_REPLICATE,
            partitionKey: replica.fileId,
            payload: {
              fileId: replica.fileId,
              targetProvider: replica.provider,
            },
            namespace: file.namespace,
            tenantId: file.tenantId,
          });
          await this.outboxWriter.enqueue(trx, envelope);
        }
        count++;
      }

      if (count > 0) {
        this.logger.log(
          `Stale lease sweep: reset ${count} IN_PROGRESS leases back to QUEUED`,
        );
      }
      return count;
    });
  }

  /**
   * 3. Stuck deleting sweep: Finds files in DELETING status for longer than SWEEP_DELETING_AFTER_MINUTES
   * and re-enqueues 'file.purge'.
   */
  async sweepStuckDeleting(dryRun = false): Promise<number> {
    const database = this.db.getDb();
    if (!database) return 0;

    const cutoff = new Date(
      Date.now() - this.configService.sweepDeletingAfterMinutes * 60 * 1000,
    );

    return database.transaction().execute(async (trx) => {
      const lock = await sql<{
        locked: boolean;
      }>`SELECT pg_try_advisory_xact_lock(hashtext('sweeper_stuck_deleting')) AS locked`.execute(
        trx,
      );
      if (!lock.rows[0]?.locked) {
        return 0;
      }

      const stuckFiles = await this.fileRepo.findStaleByStatus(
        'DELETING',
        cutoff,
        50,
        trx,
      );
      if (stuckFiles.length === 0) {
        return 0;
      }

      if (dryRun) {
        this.logger.log(
          `[DRY-RUN] Stuck deleting sweep: found ${stuckFiles.length} files`,
        );
        return stuckFiles.length;
      }

      let count = 0;
      for (const file of stuckFiles) {
        const envelope = createEnvelope({
          eventType: EVENT_TYPES.FILE_PURGE,
          partitionKey: file.id,
          payload: { fileId: file.id },
          namespace: file.namespace,
          tenantId: file.tenantId,
        });

        await this.outboxWriter.enqueue(trx, envelope);
        count++;
      }

      if (count > 0) {
        this.logger.log(
          `Stuck deleting sweep: re-enqueued ${count} file.purge events`,
        );
      }
      return count;
    });
  }

  /**
   * 4. Auto-redrive sweep: When REDRIVE_AFTER_HOURS > 0, finds FAILED replicas older than threshold
   * and resets them to QUEUED, capped by REDRIVE_MAX_TIMES.
   */
  async sweepAutoRedrive(dryRun = false): Promise<number> {
    const redriveHours = this.configService.redriveAfterHours;
    if (redriveHours <= 0) {
      return 0; // Auto-redrive disabled
    }

    const database = this.db.getDb();
    if (!database) return 0;

    const cutoff = new Date(Date.now() - redriveHours * 60 * 60 * 1000);
    const maxTimes = this.configService.redriveMaxTimes;

    return database.transaction().execute(async (trx) => {
      const lock = await sql<{
        locked: boolean;
      }>`SELECT pg_try_advisory_xact_lock(hashtext('sweeper_auto_redrive')) AS locked`.execute(
        trx,
      );
      if (!lock.rows[0]?.locked) {
        return 0;
      }

      const failedReplicas = await this.replicaRepo.findFailedOlderThan(
        cutoff,
        maxTimes,
        50,
        trx,
      );
      if (failedReplicas.length === 0) {
        return 0;
      }

      if (dryRun) {
        this.logger.log(
          `[DRY-RUN] Auto-redrive sweep: found ${failedReplicas.length} failed replicas`,
        );
        return failedReplicas.length;
      }

      let count = 0;
      for (const replica of failedReplicas) {
        await this.replicaRepo.redrive(replica.fileId, replica.provider, trx);

        const file = await this.fileRepo.findById(replica.fileId, trx);
        if (file && file.status === 'ACTIVE') {
          const envelope = createEnvelope({
            eventType: EVENT_TYPES.FILE_REPLICATE,
            partitionKey: replica.fileId,
            payload: {
              fileId: replica.fileId,
              targetProvider: replica.provider,
            },
            namespace: file.namespace,
            tenantId: file.tenantId,
          });
          await this.outboxWriter.enqueue(trx, envelope);
        }
        count++;
      }

      if (count > 0) {
        this.logger.log(
          `Auto-redrive sweep: redriven ${count} failed replicas`,
        );
      }
      return count;
    });
  }

  /**
   * 5. Tombstone sweep: Hard-deletes file records in DELETED status older than TOMBSTONE_RETENTION_DAYS
   * (or per-namespace override if configured in PolicyRegistry).
   */
  async sweepTombstones(dryRun = false): Promise<number> {
    const database = this.db.getDb();
    if (!database) return 0;

    const globalCutoff = new Date(
      Date.now() -
        this.configService.tombstoneRetentionDays * 24 * 60 * 60 * 1000,
    );

    return database.transaction().execute(async (trx) => {
      const lock = await sql<{
        locked: boolean;
      }>`SELECT pg_try_advisory_xact_lock(hashtext('sweeper_tombstones')) AS locked`.execute(
        trx,
      );
      if (!lock.rows[0]?.locked) {
        return 0;
      }

      let totalDeleted = 0;

      // 1. Process namespaces with specific retention overrides
      if (this.policyRegistry) {
        for (const [ns, policy] of this.policyRegistry.getAll().entries()) {
          if (
            policy.tombstoneRetentionDays !== undefined &&
            policy.tombstoneRetentionDays > 0
          ) {
            const nsCutoff = new Date(
              Date.now() - policy.tombstoneRetentionDays * 24 * 60 * 60 * 1000,
            );

            if (dryRun) {
              const nsTombstones = await this.fileRepo.findStaleByStatus(
                'DELETED',
                nsCutoff,
                100,
                trx,
              );
              const filtered = nsTombstones.filter((f) => f.namespace === ns);
              if (filtered.length > 0) {
                this.logger.log(
                  `[DRY-RUN] Tombstone sweep for namespace "${ns}": found ${filtered.length} DELETED tombstones older than ${policy.tombstoneRetentionDays}d`,
                );
                totalDeleted += filtered.length;
              }
            } else {
              const nsDeleted = await this.fileRepo.hardDeleteTombstones(
                nsCutoff,
                100,
                trx,
                ns,
              );
              if (nsDeleted > 0) {
                this.logger.log(
                  `Tombstone sweep for namespace "${ns}": hard-deleted ${nsDeleted} tombstones older than ${policy.tombstoneRetentionDays}d`,
                );
                totalDeleted += nsDeleted;
              }
            }
          }
        }
      }

      // 2. Process global fallback for remaining namespaces
      if (dryRun) {
        const tombstones = await this.fileRepo.findStaleByStatus(
          'DELETED',
          globalCutoff,
          100,
          trx,
        );
        this.logger.log(
          `[DRY-RUN] Global tombstone sweep: found ${tombstones.length} DELETED tombstones older than ${this.configService.tombstoneRetentionDays}d`,
        );
        return totalDeleted + tombstones.length;
      }

      const globalDeleted = await this.fileRepo.hardDeleteTombstones(
        globalCutoff,
        100,
        trx,
      );
      if (globalDeleted > 0) {
        this.logger.log(
          `Global tombstone sweep: hard-deleted ${globalDeleted} tombstones older than ${this.configService.tombstoneRetentionDays}d`,
        );
        totalDeleted += globalDeleted;
      }

      return totalDeleted;
    });
  }

  /**
   * 6. Quarantined sweep: Purges files in QUARANTINED status older than QUARANTINE_RETENTION_DAYS.
   * Marks them DELETING and enqueues 'file.purge' outbox events.
   */
  async sweepQuarantined(dryRun = false): Promise<number> {
    const database = this.db.getDb();
    if (!database) return 0;

    const retentionDays = this.configService.quarantineRetentionDays;
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    return database.transaction().execute(async (trx) => {
      const lock = await sql<{
        locked: boolean;
      }>`SELECT pg_try_advisory_xact_lock(hashtext('sweeper_quarantined')) AS locked`.execute(
        trx,
      );
      if (!lock.rows[0]?.locked) {
        return 0;
      }

      const quarantinedFiles = await this.fileRepo.findStaleByStatus(
        'QUARANTINED',
        cutoff,
        50,
        trx,
      );
      if (quarantinedFiles.length === 0) {
        return 0;
      }

      if (dryRun) {
        this.logger.log(
          `[DRY-RUN] Quarantined sweep: found ${quarantinedFiles.length} quarantined files`,
        );
        return quarantinedFiles.length;
      }

      let count = 0;
      for (const file of quarantinedFiles) {
        const marked = await this.fileRepo.markDeleting(file.id, trx);
        if (marked) {
          const envelope = createEnvelope({
            eventType: EVENT_TYPES.FILE_PURGE,
            partitionKey: file.id,
            payload: { fileId: file.id },
            namespace: file.namespace,
            tenantId: file.tenantId,
          });

          await this.outboxWriter.enqueue(trx, envelope);
          count++;
        }
      }

      if (count > 0) {
        this.logger.log(
          `Quarantined sweep: enqueued ${count} file.purge events for quarantined files older than ${retentionDays}d`,
        );
      }
      return count;
    });
  }

  /**
   * 7. Outbox sweep: Cleans published outbox events older than OUTBOX_RETENTION_HOURS.
   */
  async sweepOutbox(dryRun = false): Promise<number> {
    const database = this.db.getDb();
    if (!database) return 0;

    const cutoff = new Date(
      Date.now() - this.configService.outboxRetentionHours * 60 * 60 * 1000,
    );

    return database.transaction().execute(async (trx) => {
      const lock = await sql<{
        locked: boolean;
      }>`SELECT pg_try_advisory_xact_lock(hashtext('sweeper_outbox')) AS locked`.execute(
        trx,
      );
      if (!lock.rows[0]?.locked) {
        return 0;
      }

      if (dryRun) {
        return 0;
      }

      const deletedCount = await this.outboxRepo.deletePublishedOlderThan(
        cutoff,
        500,
        trx,
      );
      if (deletedCount > 0) {
        this.logger.log(
          `Outbox sweep: deleted ${deletedCount} published outbox rows older than ${this.configService.outboxRetentionHours}h`,
        );
      }
      return deletedCount;
    });
  }

  /**
   * 7. Staging sweep: Cleans temporary staging files older than STAGING_MAX_AGE_MINUTES.
   */
  async sweepStaging(dryRun = false): Promise<number> {
    const stagingDir = this.configService.stagingDir;
    const maxAgeMs = this.configService.stagingMaxAgeMinutes * 60 * 1000;
    const now = Date.now();
    let cleaned = 0;

    try {
      const files = await fs.readdir(stagingDir);
      for (const fileName of files) {
        const filePath = path.join(stagingDir, fileName);
        try {
          const stats = await fs.stat(filePath);
          if (stats.isFile() && now - stats.mtimeMs > maxAgeMs) {
            if (!dryRun) {
              await fs.unlink(filePath);
            }
            cleaned++;
          }
        } catch {
          // File may have been removed concurrently
        }
      }
      if (cleaned > 0) {
        this.logger.log(
          `Staging sweep: ${dryRun ? '[DRY-RUN] found' : 'removed'} ${cleaned} temporary staging files`,
        );
      }
    } catch {
      // Staging directory may not exist yet
    }

    return cleaned;
  }

  /**
   * 8. Idempotency sweep: Cleans expired idempotency keys past 24 hours (or configured TTL).
   */
  async sweepIdempotencyKeys(dryRun = false): Promise<number> {
    const database = this.db.getDb();
    const repo = this.idempotencyRepo;
    if (!database || !repo) return 0;

    return database.transaction().execute(async (trx) => {
      const lock = await sql<{
        locked: boolean;
      }>`SELECT pg_try_advisory_xact_lock(hashtext('sweeper_idempotency_keys')) AS locked`.execute(
        trx,
      );
      if (!lock.rows[0]?.locked) {
        return 0;
      }

      if (dryRun) {
        return 0;
      }

      const deletedCount = await repo.deleteExpired(new Date(), trx);
      if (deletedCount > 0) {
        this.logger.log(
          `Idempotency sweep: deleted ${deletedCount} expired idempotency keys`,
        );
      }
      return deletedCount;
    });
  }
}
