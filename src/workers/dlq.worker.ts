import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { AppConfigService } from '../config/config.service.js';
import { DeadLetterService } from '../events/dead-letter.service.js';
import {
  MESSAGE_BROKER,
  type IMessageBroker,
  type Subscription,
  type HandlerOutcome,
  type DeliveryMeta,
} from '../events/broker.interface.js';
import type { EventEnvelope } from '../events/envelope.js';

export interface DlqWorkerMetrics {
  persisted: number;
  errors: number;
}

@Injectable()
export class DlqWorker {
  private readonly logger = new Logger(DlqWorker.name);
  private subscription: Subscription | null = null;
  private running = false;

  public readonly metrics: DlqWorkerMetrics = {
    persisted: 0,
    errors: 0,
  };

  constructor(
    private readonly configService: AppConfigService,
    private readonly deadLetterService: DeadLetterService,
    @Optional()
    @Inject(MESSAGE_BROKER)
    private readonly broker?: IMessageBroker,
  ) {}

  async start(): Promise<void> {
    if (!this.broker) {
      this.logger.warn(
        'DlqWorker: no message broker configured; DLQ consumer cannot start',
      );
      return;
    }

    if (this.running) {
      return;
    }

    this.subscription = await this.broker.subscribe<unknown>(
      'dlq',
      {
        consumerGroup: 'esma-dlq-workers',
        concurrency: 1,
        maxAttempts: 1, // Dead letter consumer should not loop on failures
      },
      async (
        envelope: EventEnvelope<unknown>,
        meta: DeliveryMeta,
      ): Promise<HandlerOutcome> => {
        return this.handleDeadLetter(envelope, meta);
      },
    );

    this.running = true;
    this.logger.log('DlqWorker started — consuming from logical topic "dlq"');
  }

  async stop(): Promise<void> {
    if (this.subscription) {
      await this.subscription.close();
      this.subscription = null;
    }
    this.running = false;
    this.logger.log('DlqWorker stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  async handleDeadLetter(
    envelope: EventEnvelope<unknown>,
    meta: DeliveryMeta,
  ): Promise<HandlerOutcome> {
    try {
      const headers = meta.headers ?? {};
      const originalTopic =
        headers['x-original-topic'] ?? headers['x-topic'] ?? 'unknown';
      const eventType =
        envelope.eventType ?? headers['x-event-type'] ?? 'unknown';
      const eventId =
        envelope.eventId ??
        (envelope as unknown as { id?: string }).id ??
        uuidv7();
      const error =
        headers['x-error'] ??
        headers['x-dlq-error'] ??
        headers['x-dlq-reason'] ??
        headers['x-last-error'] ??
        'Unknown delivery failure';
      const attempts =
        parseInt(headers['x-attempts'] ?? String(meta.attempt ?? 1), 10) || 1;

      await this.deadLetterService.recordDeadLetter({
        originalTopic,
        eventType,
        eventId,
        envelope: envelope as unknown as Record<string, unknown>,
        error,
        attempts,
      });

      this.metrics.persisted++;
      return { kind: 'ack' };
    } catch (err: unknown) {
      this.metrics.errors++;
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Failed to persist dead letter message: ${message}`,
        err,
      );
      // Still ack so bad format doesn't block the dead-letter partition indefinitely
      return { kind: 'ack' };
    }
  }
}
