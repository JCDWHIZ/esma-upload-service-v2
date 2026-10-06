import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { AppConfigService } from '../config/config.service.js';
import { FileRepository } from '../db/repositories/file.repository.js';
import { StorageRegistry } from '../storage/registry.js';
import { OutboxWriter } from '../events/outbox-writer.js';
import {
  MESSAGE_BROKER,
  type IMessageBroker,
  type HandlerOutcome,
} from '../events/broker.interface.js';
import { defineConsumer } from '../events/consumer.js';
import type { ConsumerRunnable } from '../events/consumer.interface.js';
import { EVENT_TYPES, type FileProcessPayload } from '../events/catalog.js';
import { createEnvelope, type EventEnvelope } from '../events/envelope.js';
import { DerivativesService } from '../ingest/derivatives.service.js';
import type { FileDerivatives } from '../core/types.js';

export interface ProcessingWorkerMetrics {
  processed: number;
  skipped: number;
  errors: number;
  retried: number;
}

@Injectable()
export class ProcessingWorker {
  private readonly logger = new Logger(ProcessingWorker.name);
  private consumer: ConsumerRunnable | null = null;

  public readonly metrics: ProcessingWorkerMetrics = {
    processed: 0,
    skipped: 0,
    errors: 0,
    retried: 0,
  };

  constructor(
    private readonly configService: AppConfigService,
    private readonly fileRepo: FileRepository,
    private readonly storageRegistry: StorageRegistry,
    private readonly outboxWriter: OutboxWriter,
    private readonly derivativesService: DerivativesService,
    @Optional()
    @Inject(MESSAGE_BROKER)
    private readonly broker?: IMessageBroker,
  ) {}

  async start(): Promise<void> {
    if (!this.broker) {
      this.logger.warn(
        'ProcessingWorker: no message broker configured; processing worker cannot start',
      );
      return;
    }

    const concurrency = this.configService.derivativeConcurrency;
    const maxAttempts = 3;

    this.consumer = defineConsumer<unknown>({
      name: 'processing-worker',
      topic: 'processing',
      group: 'esma-processing-workers',
      broker: this.broker,
      concurrency,
      maxAttempts,
      handlerTimeoutMs: this.configService.consumerHandlerTimeoutMs,
      shutdownTimeoutMs: this.configService.consumerShutdownTimeoutMs,
      logger: this.logger,
      handler: async (envelope, ctx) => {
        if (envelope.eventType === EVENT_TYPES.FILE_PROCESS) {
          return this.handleProcess(
            envelope as EventEnvelope<FileProcessPayload>,
            ctx.attempt,
            maxAttempts,
          );
        }
        this.logger.debug(
          `ProcessingWorker ignoring unhandled eventType: ${envelope.eventType}`,
        );
        return { kind: 'ack' };
      },
    });

    await this.consumer.start();
    this.logger.log('ProcessingWorker started');
  }

  async stop(): Promise<void> {
    if (this.consumer) {
      await this.consumer.stop();
      this.consumer = null;
      this.logger.log('ProcessingWorker stopped');
    }
  }

  isRunning(): boolean {
    return this.consumer ? this.consumer.isRunning() : false;
  }

  async handleProcess(
    envelope: EventEnvelope<FileProcessPayload>,
    currentAttempt: number,
    maxAttempts: number,
  ): Promise<HandlerOutcome> {
    const { fileId, operations } = envelope.payload;

    // 1. Fetch file record
    const file = await this.fileRepo.findById(fileId);
    if (!file) {
      this.logger.debug(
        `File ${fileId} not found during processing. Acknowledging no-op.`,
      );
      return { kind: 'ack' };
    }

    // 2. Validate file status
    if (
      file.status === 'DELETED' ||
      file.status === 'DELETING' ||
      file.status === 'QUARANTINED'
    ) {
      this.logger.debug(
        `File ${fileId} is ${file.status}. Acknowledging no-op processing.`,
      );
      this.metrics.skipped++;
      return { kind: 'ack' };
    }

    // 3. Gate on virus scanning (P5-07 / ARCH §4.4)
    if (file.scanStatus === 'PENDING') {
      this.logger.log(
        `File ${fileId} virus scan is PENDING. Deferring derivative processing with retry.`,
      );
      this.metrics.retried++;
      return {
        kind: 'retry',
        delayMs: 5000,
        reason: 'Virus scan is pending',
      };
    }

    if (file.scanStatus === 'INFECTED' || file.scanStatus === 'ERROR') {
      this.logger.warn(
        `File ${fileId} virus scan is ${file.scanStatus}. Aborting derivative processing.`,
      );
      this.metrics.skipped++;
      return { kind: 'ack' };
    }

    // 4. Ensure file is a derivable raster image
    if (!this.derivativesService.isDerivableImage(file.mimetype)) {
      this.logger.debug(
        `File ${fileId} mimetype (${file.mimetype}) is not a derivable image. Skipping.`,
      );
      this.metrics.skipped++;
      return { kind: 'ack' };
    }

    // 5. Download original from primary storage driver
    let primaryDriver;
    try {
      primaryDriver = this.storageRegistry.get(file.primaryProvider);
    } catch (driverErr: unknown) {
      this.logger.error(
        `Failed to obtain primary storage driver "${file.primaryProvider}" for file ${fileId}: ${String(driverErr)}`,
      );
      throw driverErr;
    }

    let originalBuffer: Buffer;
    try {
      const { stream } = await primaryDriver.downloadStream({
        provider: file.primaryProvider,
        key: file.storageKey,
      });

      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array),
        );
      }
      originalBuffer = Buffer.concat(chunks);
    } catch (downloadErr: unknown) {
      this.logger.error(
        `Failed to download original image for file ${fileId}: ${String(downloadErr)}`,
      );
      if (currentAttempt < maxAttempts) {
        this.metrics.retried++;
        const backoffMs = Math.min(30000, 1000 * Math.pow(2, currentAttempt));
        return {
          kind: 'retry',
          delayMs: backoffMs,
          reason: `Failed to download original image: ${String(downloadErr)}`,
        };
      }
      this.metrics.errors++;
      return { kind: 'dead-letter', reason: String(downloadErr) };
    }

    // 6. Generate derivatives via Sharp
    let generated;
    try {
      generated = await this.derivativesService.generateDerivatives(
        originalBuffer,
        operations,
      );
    } catch (genErr: unknown) {
      this.logger.error(
        `Error generating image derivatives for file ${fileId}: ${String(genErr)}`,
      );
      if (currentAttempt < maxAttempts) {
        this.metrics.retried++;
        const backoffMs = Math.min(30000, 1000 * Math.pow(2, currentAttempt));
        return {
          kind: 'retry',
          delayMs: backoffMs,
          reason: `Failed to generate derivatives: ${String(genErr)}`,
        };
      }
      this.metrics.errors++;
      return { kind: 'dead-letter', reason: String(genErr) };
    }

    // If no derivatives generated (e.g. animated GIF skipped), mark as skipped and ack
    if (generated.length === 0) {
      this.logger.log(
        `No derivatives generated for file ${fileId} (e.g. animated GIF or empty ops).`,
      );
      this.metrics.skipped++;
      return { kind: 'ack' };
    }

    // 7. Store derivatives on primary storage provider under {key}.d/{name}.webp
    const updatedDerivatives: FileDerivatives = {
      ...(file.derivatives ?? {}),
    };

    for (const item of generated) {
      const derivKey = this.derivativesService.buildDerivativeKey(
        file.storageKey,
        item.name,
      );
      const sha256 = crypto
        .createHash('sha256')
        .update(item.buffer)
        .digest('hex');

      try {
        await primaryDriver.upload({
          key: derivKey,
          source: () => Readable.from(item.buffer),
          size: item.size,
          sha256,
          mimetype: item.mimetype,
          visibility: file.visibility,
        });

        updatedDerivatives[item.name] = {
          key: derivKey,
          size: item.size,
          width: item.width,
          height: item.height,
          mimetype: item.mimetype,
        };
      } catch (uploadErr: unknown) {
        this.logger.error(
          `Failed to upload derivative "${item.name}" for file ${fileId}: ${String(uploadErr)}`,
        );
        if (currentAttempt < maxAttempts) {
          this.metrics.retried++;
          const backoffMs = Math.min(30000, 1000 * Math.pow(2, currentAttempt));
          return {
            kind: 'retry',
            delayMs: backoffMs,
            reason: `Failed to upload derivative "${item.name}": ${String(uploadErr)}`,
          };
        }
        this.metrics.errors++;
        return { kind: 'dead-letter', reason: String(uploadErr) };
      }
    }

    // 8. Update files.derivatives in database
    await this.fileRepo.updateDerivatives(file.id, updatedDerivatives);

    // 9. Enqueue file.processed event on topic 'audit'
    if (this.configService.eventsEnabled) {
      const processedEnvelope = createEnvelope({
        eventType: EVENT_TYPES.FILE_PROCESSED,
        partitionKey: file.id,
        correlationId: envelope.correlationId,
        causationId: envelope.eventId,
        namespace: file.namespace,
        tenantId: file.tenantId,
        payload: {
          fileId: file.id,
          derivatives: Object.keys(updatedDerivatives),
        },
      });

      await this.outboxWriter.enqueue(null, processedEnvelope);
    }

    this.metrics.processed++;
    this.logger.log(
      `File ${fileId} derivatives generated successfully: [${Object.keys(updatedDerivatives).join(', ')}]`,
    );
    return { kind: 'ack' };
  }
}
