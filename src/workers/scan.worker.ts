import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
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
import { EVENT_TYPES, type FileScanPayload } from '../events/catalog.js';
import { createEnvelope, type EventEnvelope } from '../events/envelope.js';
import { ClamAvScanner } from '../ingest/clamav.scanner.js';
import type { FileRecord } from '../core/types.js';

export interface ScanWorkerMetrics {
  scanned: number;
  clean: number;
  infected: number;
  errors: number;
  retried: number;
}

@Injectable()
export class ScanWorker {
  private readonly logger = new Logger(ScanWorker.name);
  private consumer: ConsumerRunnable | null = null;

  public readonly metrics: ScanWorkerMetrics = {
    scanned: 0,
    clean: 0,
    infected: 0,
    errors: 0,
    retried: 0,
  };

  constructor(
    private readonly configService: AppConfigService,
    private readonly db: DatabaseService,
    private readonly fileRepo: FileRepository,
    private readonly replicaRepo: ReplicaRepository,
    private readonly storageRegistry: StorageRegistry,
    private readonly outboxWriter: OutboxWriter,
    private readonly clamAvScanner: ClamAvScanner,
    @Optional()
    @Inject(MESSAGE_BROKER)
    private readonly broker?: IMessageBroker,
  ) {}

  async start(): Promise<void> {
    if (!this.broker) {
      this.logger.warn(
        'ScanWorker: no message broker configured; scan worker cannot start',
      );
      return;
    }

    const concurrency = 4;
    const maxAttempts = 3;

    this.consumer = defineConsumer<unknown>({
      name: 'scan-worker',
      topic: 'processing',
      group: 'esma-scan-workers',
      broker: this.broker,
      concurrency,
      maxAttempts,
      handlerTimeoutMs: this.configService.consumerHandlerTimeoutMs,
      shutdownTimeoutMs: this.configService.consumerShutdownTimeoutMs,
      logger: this.logger,
      handler: async (envelope, ctx) => {
        if (envelope.eventType === EVENT_TYPES.FILE_SCAN) {
          return this.handleScan(
            envelope as EventEnvelope<FileScanPayload>,
            ctx.attempt,
            maxAttempts,
          );
        }
        this.logger.warn(
          `ScanWorker received unhandled eventType: ${envelope.eventType}`,
        );
        return { kind: 'ack' };
      },
    });

    await this.consumer.start();
    this.logger.log('ScanWorker started');
  }

  async stop(): Promise<void> {
    if (this.consumer) {
      await this.consumer.stop();
      this.consumer = null;
      this.logger.log('ScanWorker stopped');
    }
  }

  isRunning(): boolean {
    return this.consumer ? this.consumer.isRunning() : false;
  }

  async handleScan(
    envelope: EventEnvelope<FileScanPayload>,
    currentAttempt: number,
    maxAttempts: number,
  ): Promise<HandlerOutcome> {
    const { fileId } = envelope.payload;

    // 1. Fetch file record
    const file = await this.fileRepo.findById(fileId);
    if (!file) {
      this.logger.debug(
        `File ${fileId} not found during scan. Acknowledging no-op.`,
      );
      return { kind: 'ack' };
    }

    if (file.status === 'DELETED' || file.status === 'DELETING') {
      this.logger.debug(
        `File ${fileId} is ${file.status}. Acknowledging no-op scan.`,
      );
      return { kind: 'ack' };
    }

    if (file.scanStatus === 'CLEAN') {
      this.logger.debug(
        `File ${fileId} is already CLEAN. Acknowledging idempotent scan.`,
      );
      return { kind: 'ack' };
    }

    if (file.scanStatus === 'INFECTED') {
      this.logger.debug(
        `File ${fileId} is already INFECTED. Acknowledging idempotent scan.`,
      );
      return { kind: 'ack' };
    }

    // 2. Obtain stream from primary storage provider
    let primaryDriver;
    try {
      primaryDriver = this.storageRegistry.get(file.primaryProvider);
    } catch (driverErr: unknown) {
      this.logger.error(
        `Failed to obtain storage driver "${file.primaryProvider}" for file ${fileId}: ${String(driverErr)}`,
      );
      throw driverErr;
    }

    let downloadStream;
    try {
      downloadStream = await primaryDriver.downloadStream({
        provider: file.primaryProvider,
        key: file.storageKey,
      });
    } catch (downloadErr: unknown) {
      this.logger.error(
        `Failed to open stream from primary storage for file ${fileId}: ${String(downloadErr)}`,
      );
      throw downloadErr;
    }

    // 3. Stream through ClamAV scanner
    let scanResult;
    try {
      scanResult = await this.clamAvScanner.scanStream(downloadStream.stream);
    } catch (scanErr: unknown) {
      this.logger.error(
        `ClamAV scanner error on file ${fileId} (attempt ${currentAttempt}/${maxAttempts}): ${String(scanErr)}`,
      );

      if (currentAttempt < maxAttempts) {
        this.metrics.retried++;
        const backoffMs = Math.min(30000, 1000 * Math.pow(2, currentAttempt));
        return {
          kind: 'retry',
          delayMs: backoffMs,
          reason: `ClamAV scan error: ${String(scanErr)}`,
        };
      }

      // Scanner attempts exhausted -> apply SCAN_FAIL_MODE
      this.metrics.errors++;
      if (this.configService.scanFailMode === 'open') {
        this.logger.warn(
          `SCAN_FAIL_MODE=open: marking file ${fileId} as CLEAN despite scanner failure`,
        );
        await this.markClean(file, envelope);
        return { kind: 'ack' };
      } else {
        this.logger.error(
          `SCAN_FAIL_MODE=closed: marking file ${fileId} as ERROR due to scanner failure`,
        );
        await this.markError(file, envelope, String(scanErr));
        return { kind: 'ack' };
      }
    }

    this.metrics.scanned++;

    // 4. Handle scan verdict
    if (scanResult.clean) {
      this.metrics.clean++;
      await this.markClean(file, envelope);
      this.logger.log(
        `File ${fileId} scanned CLEAN (${scanResult.scannedBytes ?? 0} bytes)`,
      );
      return { kind: 'ack' };
    } else {
      this.metrics.infected++;
      const threat = scanResult.threat ?? 'Unknown threat';
      await this.markInfected(file, envelope, threat);
      return { kind: 'ack' };
    }
  }

  private async markClean(
    file: FileRecord,
    envelope: EventEnvelope<FileScanPayload>,
  ): Promise<void> {
    const database = this.db.getDb();
    if (!database) return;

    await database.transaction().execute(async (trx) => {
      const current = await this.fileRepo.findById(file.id, trx);
      if (
        !current ||
        current.status === 'DELETED' ||
        current.status === 'DELETING'
      ) {
        return;
      }

      await this.fileRepo.updateStatus(
        current.id,
        current.version,
        { scanStatus: 'CLEAN' },
        trx,
      );

      const scannedEnvelope = createEnvelope({
        eventType: EVENT_TYPES.FILE_SCANNED,
        partitionKey: file.id,
        correlationId: envelope.correlationId,
        causationId: envelope.eventId,
        payload: {
          fileId: file.id,
          result: 'CLEAN',
        },
        namespace: file.namespace,
        tenantId: file.tenantId,
      });

      await this.outboxWriter.enqueue(trx, scannedEnvelope);
    });
  }

  private async markInfected(
    file: FileRecord,
    envelope: EventEnvelope<FileScanPayload>,
    threat: string,
  ): Promise<void> {
    const database = this.db.getDb();
    if (!database) return;

    await database.transaction().execute(async (trx) => {
      const current = await this.fileRepo.findById(file.id, trx);
      if (!current) return;

      // 1. Mark file QUARANTINED and scanStatus INFECTED
      await this.fileRepo.updateStatus(
        current.id,
        current.version,
        {
          status: 'QUARANTINED',
          scanStatus: 'INFECTED',
        },
        trx,
      );

      // 2. Abort/cancel secondary replicas
      const replicas = await this.replicaRepo.listByFile(file.id, trx);
      for (const replica of replicas) {
        if (replica.role === 'secondary' && replica.status !== 'DELETED') {
          await this.replicaRepo.markDeleted(file.id, replica.provider, trx);
        }
      }

      // 3. Emit file.scanned audit event with threat metadata
      const scannedEnvelope = createEnvelope({
        eventType: EVENT_TYPES.FILE_SCANNED,
        partitionKey: file.id,
        correlationId: envelope.correlationId,
        causationId: envelope.eventId,
        payload: {
          fileId: file.id,
          result: 'INFECTED',
          threat,
        },
        namespace: file.namespace,
        tenantId: file.tenantId,
      });

      await this.outboxWriter.enqueue(trx, scannedEnvelope);
    });

    // 4. Emit high-severity security alert
    this.logger.error(
      `SECURITY ALERT: File ${file.id} (tenant=${file.tenantId}, name=${file.originalFilename}) is INFECTED with threat "${threat}". Quarantined.`,
    );
  }

  private async markError(
    file: FileRecord,
    envelope: EventEnvelope<FileScanPayload>,
    errorMessage: string,
  ): Promise<void> {
    const database = this.db.getDb();
    if (!database) return;

    await database.transaction().execute(async (trx) => {
      const current = await this.fileRepo.findById(file.id, trx);
      if (!current) return;

      await this.fileRepo.updateStatus(
        current.id,
        current.version,
        { scanStatus: 'ERROR' },
        trx,
      );

      const scannedEnvelope = createEnvelope({
        eventType: EVENT_TYPES.FILE_SCANNED,
        partitionKey: file.id,
        correlationId: envelope.correlationId,
        causationId: envelope.eventId,
        payload: {
          fileId: file.id,
          result: 'ERROR',
          threat: errorMessage,
        },
        namespace: file.namespace,
        tenantId: file.tenantId,
      });

      await this.outboxWriter.enqueue(trx, scannedEnvelope);
    });
  }
}
