import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import * as crypto from 'node:crypto';
import { PassThrough } from 'node:stream';
import { sql } from 'kysely';
import { AppConfigService } from '../config/config.service.js';
import { DatabaseService } from '../db/database.service.js';
import { FileRepository } from '../db/repositories/file.repository.js';
import { ReplicaRepository } from '../db/repositories/replica.repository.js';
import { StorageRegistry } from '../storage/registry.js';
import { OutboxWriter } from '../events/outbox-writer.js';
import {
  MESSAGE_BROKER,
  type IMessageBroker,
  type HandlerOutcome,
} from '../events/broker.interface.js';
import { defineConsumer } from '../events/consumer.js';
import type { ConsumerRunnable } from '../events/consumer.interface.js';
import {
  EVENT_TYPES,
  type FileReplicatePayload,
  type FilePurgePayload,
} from '../events/catalog.js';
import { createEnvelope, type EventEnvelope } from '../events/envelope.js';
import { PermanentError, RetryableError } from '../core/errors/app-error.js';
import type { Provider } from '../core/types.js';
import type { ProviderRef } from '../storage/types.js';

export interface ReplicationWorkerMetrics {
  replicated: number;
  retried: number;
  failed: number;
  dataCorruptionAlerts: number;
  purged: number;
}

@Injectable()
export class ReplicationWorker {
  private readonly logger = new Logger(ReplicationWorker.name);
  private consumer: ConsumerRunnable | null = null;
  private readonly activePerTenant = new Map<string, number>();

  public readonly metrics: ReplicationWorkerMetrics = {
    replicated: 0,
    retried: 0,
    failed: 0,
    dataCorruptionAlerts: 0,
    purged: 0,
  };

  constructor(
    private readonly configService: AppConfigService,
    private readonly db: DatabaseService,
    private readonly fileRepo: FileRepository,
    private readonly replicaRepo: ReplicaRepository,
    private readonly storageRegistry: StorageRegistry,
    private readonly outboxWriter: OutboxWriter,
    @Optional()
    @Inject(MESSAGE_BROKER)
    private readonly broker?: IMessageBroker,
  ) {}

  async start(): Promise<void> {
    if (!this.broker) {
      this.logger.warn(
        'ReplicationWorker: no message broker configured; replication worker cannot start',
      );
      return;
    }

    const concurrency = this.configService.replicationConcurrency;
    const maxAttempts = this.configService.replicationMaxAttempts;

    this.consumer = defineConsumer<unknown>({
      name: 'replication-worker',
      topic: 'replication',
      group: 'esma-replication-workers',
      broker: this.broker,
      concurrency,
      maxAttempts,
      handlerTimeoutMs: this.configService.consumerHandlerTimeoutMs,
      shutdownTimeoutMs: this.configService.consumerShutdownTimeoutMs,
      logger: this.logger,
      handler: async (envelope, ctx) => {
        if (envelope.eventType === EVENT_TYPES.FILE_REPLICATE) {
          return this.handleReplication(
            envelope as EventEnvelope<FileReplicatePayload>,
            ctx.attempt,
            maxAttempts,
          );
        }
        if (envelope.eventType === EVENT_TYPES.FILE_PURGE) {
          return this.handlePurge(
            envelope as EventEnvelope<FilePurgePayload>,
            ctx.attempt,
            maxAttempts,
          );
        }
        this.logger.warn(
          `ReplicationWorker received unhandled eventType: ${envelope.eventType}`,
        );
        return { kind: 'ack' };
      },
    });

    await this.consumer.start();
    this.logger.log(
      `ReplicationWorker started: concurrency=${concurrency}, maxAttempts=${maxAttempts}`,
    );
  }

  async stop(): Promise<void> {
    if (this.consumer) {
      await this.consumer.stop();
      this.consumer = null;
      this.logger.log('ReplicationWorker stopped');
    }
  }

  isRunning(): boolean {
    return this.consumer ? this.consumer.isRunning() : false;
  }

  /**
   * Internal replication handler conforming to BACKEND_TASKS.md P4-07:
   * 1. Check file ACTIVE & replica QUEUED (ack if not).
   * 2. CAS claim QUEUED -> IN_PROGRESS.
   * 3. Select source replica (primary or any AVAILABLE).
   * 4. Stream copy through sha256 hasher.
   * 5. Stat target, verify size equals file.sizeBytes.
   * 6. Re-check file status (F-23); delete target & mark replica DELETED if not ACTIVE.
   * 7. CAS IN_PROGRESS -> AVAILABLE, recompute aggregate, insert file.replicated into outbox.
   */
  async handleReplication(
    envelope: EventEnvelope<FileReplicatePayload>,
    currentAttempt: number,
    maxAttempts: number,
  ): Promise<HandlerOutcome> {
    const { fileId, targetProvider } = envelope.payload;
    const provider = targetProvider as Provider;

    // 1. Initial status checks
    const file = await this.fileRepo.findById(fileId);
    if (!file || file.status !== 'ACTIVE') {
      this.logger.debug(
        `File ${fileId} not found or not ACTIVE (status=${file?.status ?? 'missing'}). Acknowledging no-op.`,
      );
      return { kind: 'ack' };
    }

    // Gate on scan_status per P5-07: do not replicate while scanning is PENDING or file is INFECTED
    if (file.scanStatus === 'PENDING') {
      this.logger.debug(
        `File ${fileId} virus scan is PENDING. Retrying replication after delay.`,
      );
      return {
        kind: 'retry',
        delayMs: 5000,
        reason: 'Waiting for virus scan to complete',
      };
    }

    if (file.scanStatus === 'INFECTED' || file.scanStatus === 'ERROR') {
      this.logger.warn(
        `File ${fileId} scan status is ${file.scanStatus}. Replication aborted.`,
      );
      return { kind: 'ack' };
    }

    const replicas = await this.replicaRepo.listByFile(fileId);
    const targetReplica = replicas.find((r) => r.provider === provider);

    if (!targetReplica) {
      this.logger.warn(
        `Target replica for provider "${provider}" on file ${fileId} does not exist. Acknowledging.`,
      );
      return { kind: 'ack' };
    }

    if (targetReplica.status === 'AVAILABLE') {
      this.logger.debug(
        `Target replica for provider "${provider}" on file ${fileId} is already AVAILABLE. Acknowledging duplicate.`,
      );
      return { kind: 'ack' };
    }

    if (targetReplica.status !== 'QUEUED') {
      this.logger.debug(
        `Target replica for provider "${provider}" on file ${fileId} status is "${targetReplica.status}" (not QUEUED). Acknowledging.`,
      );
      return { kind: 'ack' };
    }

    // Tenant concurrency throttling
    const tenantId = file.tenantId;
    const activeCount = this.activePerTenant.get(tenantId) ?? 0;
    const maxPerTenant = Math.max(2, this.configService.replicationConcurrency);
    if (activeCount >= maxPerTenant) {
      throw new RetryableError(
        `Tenant "${tenantId}" exceeded maximum concurrent replications (${maxPerTenant})`,
      );
    }

    this.activePerTenant.set(tenantId, activeCount + 1);

    try {
      // 2. CAS claim: QUEUED -> IN_PROGRESS
      const claimed = await this.replicaRepo.claim(fileId, provider);
      if (!claimed) {
        this.logger.debug(
          `CAS claim failed for file ${fileId} on provider "${provider}" (already claimed). Acknowledging.`,
        );
        return { kind: 'ack' };
      }

      // 3. Choose source replica
      const refreshedReplicas = await this.replicaRepo.listByFile(fileId);
      let sourceReplica = refreshedReplicas.find(
        (r) => r.role === 'primary' && r.status === 'AVAILABLE',
      );
      if (!sourceReplica) {
        sourceReplica = refreshedReplicas.find(
          (r) => r.status === 'AVAILABLE' && r.provider !== provider,
        );
      }

      if (!sourceReplica) {
        throw new RetryableError(
          `No AVAILABLE source replica found to replicate file ${fileId} to ${provider}`,
        );
      }

      const sourceDriver = this.storageRegistry.get(sourceReplica.provider);
      const targetDriver = this.storageRegistry.get(provider);

      if (!sourceDriver.isConfigured() || !targetDriver.isConfigured()) {
        throw new RetryableError(
          `Storage driver not configured: source=${sourceReplica.provider}, target=${provider}`,
        );
      }

      const sourceRef: ProviderRef = {
        provider: sourceReplica.provider,
        key: sourceReplica.providerKey,
        meta: sourceReplica.providerMeta,
      };

      const targetKey = targetReplica.providerKey || file.storageKey;
      let computedSha256 = '';

      // 4. Stream copy through hashing transform
      const uploadResult = await targetDriver.upload({
        key: targetKey,
        source: () => {
          const pt = new PassThrough();
          const hasher = crypto.createHash('sha256');

          void (async () => {
            try {
              const downloadRes = await sourceDriver.downloadStream(sourceRef);
              downloadRes.stream.on('data', (chunk: Buffer) => {
                hasher.update(chunk);
              });
              downloadRes.stream.on('end', () => {
                computedSha256 = hasher.digest('hex');
              });
              downloadRes.stream.on('error', (err) => {
                pt.destroy(err);
              });
              downloadRes.stream.pipe(pt);
            } catch (err: unknown) {
              pt.destroy(err instanceof Error ? err : new Error(String(err)));
            }
          })();

          return pt;
        },
        size: Number(file.sizeBytes),
        sha256: file.sha256 ?? '',
        mimetype: file.mimetype,
        visibility: file.visibility,
        tags: file.tags,
        attributes: file.attributes
          ? Object.fromEntries(
              Object.entries(file.attributes).map(([k, v]) => [k, String(v)]),
            )
          : undefined,
      });

      const targetRef: ProviderRef = {
        provider,
        key: targetKey,
        meta: uploadResult.ref.meta,
      };

      // Verify SHA-256
      if (
        file.sha256 &&
        computedSha256 &&
        file.sha256.toLowerCase() !== computedSha256.toLowerCase()
      ) {
        this.metrics.dataCorruptionAlerts++;
        this.logger.error(
          `DATA CORRUPTION ALERT: sha256 mismatch for file ${fileId} on replica ${provider}. Expected: ${file.sha256}, Computed: ${computedSha256}`,
        );
        await targetDriver.delete(targetRef).catch(() => {});
        throw new PermanentError(
          `Data corruption: sha256 mismatch (expected ${file.sha256}, computed ${computedSha256})`,
        );
      }

      const db = this.db.getDb();
      if (!db) {
        throw new RetryableError('Database connection is unavailable');
      }

      // If file.sha256 was null (backfilled asset), update DB
      if (!file.sha256 && computedSha256) {
        await db
          .updateTable('files')
          .set({ sha256: computedSha256, updated_at: sql`now()` })
          .where('id', '=', fileId)
          .execute();
      }

      // 5. Stat target, verify size
      const stat = await targetDriver.stat(targetRef);
      if (!stat || BigInt(stat.size) !== BigInt(file.sizeBytes)) {
        await targetDriver.delete(targetRef).catch(() => {});
        throw new PermanentError(
          `Replicated object size mismatch for file ${fileId}: expected ${file.sizeBytes}, got ${stat?.size ?? 'null'}`,
        );
      }

      // 6. Re-check file status (F-23)
      const freshFile = await this.fileRepo.findById(fileId);
      if (!freshFile || freshFile.status !== 'ACTIVE') {
        this.logger.warn(
          `File ${fileId} is no longer ACTIVE (status=${freshFile?.status ?? 'missing'}). Deleting target object and marking replica DELETED.`,
        );
        await targetDriver.delete(targetRef).catch(() => {});
        await this.replicaRepo.markDeleted(fileId, provider);
        return { kind: 'ack' };
      }

      // 7. CAS IN_PROGRESS -> AVAILABLE, recompute aggregate, insert file.replicated into outbox
      await db.transaction().execute(async (trx) => {
        await this.replicaRepo.complete(
          fileId,
          provider,
          {
            url: uploadResult.url ?? undefined,
            etag: uploadResult.etag ?? stat.etag ?? undefined,
            providerMeta: uploadResult.ref.meta ?? {},
          },
          trx,
        );

        const envelope = createEnvelope({
          eventType: EVENT_TYPES.FILE_REPLICATED,
          partitionKey: fileId,
          payload: {
            fileId,
            provider,
          },
        });

        await this.outboxWriter.enqueue(trx, envelope);
      });

      this.metrics.replicated++;
      this.logger.log(
        `File ${fileId} successfully replicated to provider "${provider}"`,
      );
      return { kind: 'ack' };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      if (err instanceof PermanentError) {
        this.metrics.failed++;
        await this.failReplica(fileId, provider, errorMsg);
        throw err;
      }

      // Check retry attempts
      if (currentAttempt >= maxAttempts) {
        this.metrics.failed++;
        await this.failReplica(
          fileId,
          provider,
          `Exceeded max attempts (${maxAttempts}): ${errorMsg}`,
        );
        throw new PermanentError(
          `Replication failed after ${maxAttempts} attempts: ${errorMsg}`,
        );
      }

      this.metrics.retried++;
      await this.replicaRepo.retry(fileId, provider, errorMsg).catch(() => {});
      throw err;
    } finally {
      const current = this.activePerTenant.get(tenantId) ?? 1;
      if (current <= 1) {
        this.activePerTenant.delete(tenantId);
      } else {
        this.activePerTenant.set(tenantId, current - 1);
      }
    }
  }

  private async failReplica(
    fileId: string,
    provider: Provider,
    error: string,
  ): Promise<void> {
    try {
      const db = this.db.getDb();
      if (!db) {
        return;
      }

      await db.transaction().execute(async (trx) => {
        await this.replicaRepo.fail(fileId, provider, error, trx);

        const failEnvelope = createEnvelope({
          eventType: EVENT_TYPES.FILE_REPLICATION_FAILED,
          partitionKey: fileId,
          payload: {
            fileId,
            provider,
            error,
          },
        });
        await this.outboxWriter.enqueue(trx, failEnvelope);
      });
    } catch (err: unknown) {
      this.logger.error(
        `Failed to record replication failure in DB for file ${fileId} (${provider}): ${String(err)}`,
      );
    }
  }

  /**
   * Internal purge handler conforming to BACKEND_TASKS.md P4-09:
   * 1. Check file existence & status. If file not found or already DELETED, ack (idempotent).
   * 2. For each replica not DELETED:
   *    - QUEUED: mark DELETED without driver I/O.
   *    - IN_PROGRESS: if replication is actively in-flight, throw RetryableError to allow replication handler step 6 to clean up.
   *    - AVAILABLE | FAILED | DELETING: call driver.delete(ref) (idempotent), mark replica DELETED.
   * 3. On driver failure, throw RetryableError (or PermanentError after maxAttempts) so message is retried; file remains DELETING.
   * 4. When all replicas are DELETED:
   *    - In a transaction:
   *      - Mark file DELETED (deleted_at = now())
   *      - Enqueue file.deleted into outbox (audit topic)
   * 5. Return { kind: 'ack' }.
   */
  async handlePurge(
    envelope: EventEnvelope<FilePurgePayload>,
    currentAttempt: number,
    maxAttempts: number,
  ): Promise<HandlerOutcome> {
    const { fileId } = envelope.payload;

    // 1. Initial status checks
    const file = await this.fileRepo.findById(fileId);
    if (!file) {
      this.logger.debug(
        `File ${fileId} not found during purge. Acknowledging no-op.`,
      );
      return { kind: 'ack' };
    }

    if (file.status === 'DELETED') {
      this.logger.debug(
        `File ${fileId} already DELETED. Acknowledging idempotent replay.`,
      );
      return { kind: 'ack' };
    }

    // Ensure file status is in DELETING state
    if (file.status !== 'DELETING') {
      await this.fileRepo.markDeleting(fileId);
    }

    const replicas = await this.replicaRepo.listByFile(fileId);

    // If any replica is IN_PROGRESS, allow in-flight replication copy to detect status change at step 6 and abort
    const inProgressReplicas = replicas.filter(
      (r) => r.status === 'IN_PROGRESS',
    );
    if (inProgressReplicas.length > 0 && currentAttempt < maxAttempts) {
      this.metrics.retried++;
      throw new RetryableError(
        `Replication in progress for file ${fileId} on ${inProgressReplicas.map((r) => r.provider).join(', ')}; waiting for replication cleanup`,
      );
    }

    // Delete driver objects for each non-DELETED replica
    for (const replica of replicas) {
      if (replica.status === 'DELETED') {
        continue;
      }

      if (replica.status === 'QUEUED') {
        // No driver write occurred for QUEUED replicas
        await this.replicaRepo.markDeleted(fileId, replica.provider);
        continue;
      }

      // AVAILABLE, FAILED, DELETING, or forced IN_PROGRESS
      const driver = this.storageRegistry.get(replica.provider);
      const ref: ProviderRef = {
        provider: replica.provider,
        key: replica.providerKey || file.storageKey,
        meta: replica.providerMeta,
      };

      try {
        await driver.delete(ref);
        await this.replicaRepo.markDeleted(fileId, replica.provider);
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `Failed to delete object on provider "${replica.provider}" for file ${fileId}: ${errorMsg}`,
        );

        if (currentAttempt >= maxAttempts) {
          this.metrics.failed++;
          throw new PermanentError(
            `Driver deletion failed after ${maxAttempts} attempts for file ${fileId} on ${replica.provider}: ${errorMsg}`,
          );
        }

        this.metrics.retried++;
        throw new RetryableError(
          `Driver deletion failed for file ${fileId} on ${replica.provider}: ${errorMsg}`,
        );
      }
    }

    // Confirm all replicas have reached DELETED status
    const refreshedReplicas = await this.replicaRepo.listByFile(fileId);
    const pendingReplicas = refreshedReplicas.filter(
      (r) => r.status !== 'DELETED',
    );
    if (pendingReplicas.length > 0) {
      this.metrics.retried++;
      throw new RetryableError(
        `File ${fileId} still has ${pendingReplicas.length} non-DELETED replicas`,
      );
    }

    // All replicas are DELETED: update file status and emit file.deleted
    const db = this.db.getDb();
    if (!db) {
      throw new RetryableError('Database connection unavailable');
    }

    await db.transaction().execute(async (trx) => {
      await this.fileRepo.markDeleted(fileId, trx);

      const deletedEnvelope = createEnvelope({
        eventType: EVENT_TYPES.FILE_DELETED,
        partitionKey: fileId,
        payload: { fileId },
        correlationId: envelope.correlationId,
        causationId: envelope.eventId,
        namespace: file.namespace,
        tenantId: file.tenantId,
      });

      await this.outboxWriter.enqueue(trx, deletedEnvelope);
    });

    this.metrics.purged++;
    this.logger.log(`File ${fileId} purge completed and file.deleted emitted`);
    return { kind: 'ack' };
  }
}
