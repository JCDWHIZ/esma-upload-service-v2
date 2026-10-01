import { Logger } from '@nestjs/common';
import type { EventEnvelope } from './envelope.js';
import type { LogicalTopic } from './catalog.js';
import type {
  DeliveryMeta,
  HandlerOutcome,
  IMessageBroker,
  MessageHandler,
  PublishOptions,
  SubscribeOptions,
  Subscription,
} from './broker.interface.js';
import { TopicMap } from './topic-map.js';

// ─── Pulsar Interface Types ───────────────────────────────────────────────────

export interface PulsarMessageProperties {
  [key: string]: string;
}

export interface PulsarMessageLike {
  getData(): Buffer;
  getMessageId(): string | object;
  getPartitionKey(): string;
  getProperties(): PulsarMessageProperties;
  getTopicName(): string;
  getRedeliveryCount(): number;
  getEventTimestamp?(): number;
}

export interface PulsarProducerConfigLike {
  topic: string;
  sendTimeoutMs?: number;
  blockIfQueueFull?: boolean;
  batchingEnabled?: boolean;
  batchingMaxPublishDelayMs?: number;
  maxPendingMessages?: number;
}

export interface PulsarProducerLike {
  send(message: {
    data: Buffer;
    partitionKey?: string;
    properties?: Record<string, string>;
    eventTimestamp?: number;
    sequenceId?: number;
  }): Promise<void | string | object>;
  flush?(): Promise<void>;
  close(): Promise<void>;
}

export interface PulsarConsumerConfigLike {
  topic: string;
  subscription: string;
  subscriptionType?: 'Exclusive' | 'Shared' | 'Failover' | 'Key_Shared';
  subscriptionInitialPosition?: 'Latest' | 'Earliest';
  enableRetry?: boolean;
  deadLetterPolicy?: {
    maxRedeliverCount: number;
    deadLetterTopic: string;
    initialSubscriptionName?: string;
  };
  receiverQueueSize?: number;
}

export interface PulsarConsumerLike {
  receive(timeoutMs?: number): Promise<PulsarMessageLike>;
  acknowledge(message: PulsarMessageLike): Promise<void>;
  negativeAcknowledge(message: PulsarMessageLike): void | Promise<void>;
  reconsumeLater(message: PulsarMessageLike, delayMs: number): Promise<void>;
  close(): Promise<void>;
  isConnected?(): boolean;
}

export interface PulsarClientLike {
  createProducer(config: PulsarProducerConfigLike): Promise<PulsarProducerLike>;
  subscribe(config: PulsarConsumerConfigLike): Promise<PulsarConsumerLike>;
  close(): Promise<void>;
}

// ─── Driver Configuration ─────────────────────────────────────────────────────

export interface PulsarBrokerConfig {
  readonly serviceUrl: string;
  readonly authToken?: string;
  readonly tenant?: string;
  readonly namespace?: string;
  readonly topicMap?: TopicMap;
  readonly operationTimeoutSeconds?: number;
  readonly connectionTimeoutMs?: number;
  readonly pulsarInstance?: PulsarClientLike;
}

interface ActiveConsumerEntry {
  consumer: PulsarConsumerLike;
  stopSignal: { stopped: boolean };
  loopPromise: Promise<void>;
}

// ─── PulsarBrokerDriver ───────────────────────────────────────────────────────

export class PulsarBrokerDriver implements IMessageBroker {
  public readonly name = 'pulsar' as const;

  private readonly logger = new Logger(PulsarBrokerDriver.name);
  private client: PulsarClientLike | null = null;
  private readonly producers = new Map<string, PulsarProducerLike>();
  private readonly activeConsumers: ActiveConsumerEntry[] = [];
  private readonly inFlightExecutions = new Set<Promise<unknown>>();
  private isReady = false;

  private readonly tenant: string;
  private readonly namespace: string;
  private readonly topicMap: TopicMap;

  constructor(private readonly config: PulsarBrokerConfig) {
    this.tenant = config.tenant ?? 'esma';
    this.namespace = config.namespace ?? 'uploads';
    this.topicMap =
      config.topicMap ??
      new TopicMap({
        pulsarTenant: this.tenant,
        pulsarNamespace: this.namespace,
      });

    if (config.pulsarInstance) {
      this.client = config.pulsarInstance;
    }
  }

  private async getPulsarClient(): Promise<PulsarClientLike> {
    if (!this.client) {
      try {
        // @ts-expect-error pulsar-client is dynamically imported for optional runtime environments
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const Pulsar = await import('pulsar-client');
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
        const ClientConstructor = Pulsar.Client || Pulsar.default?.Client;

        const clientOptions: Record<string, unknown> = {
          serviceUrl: this.config.serviceUrl,
          operationTimeoutSeconds: this.config.operationTimeoutSeconds ?? 30,
        };

        if (this.config.connectionTimeoutMs) {
          clientOptions.connectionTimeoutMs = this.config.connectionTimeoutMs;
        }

        if (this.config.authToken && this.config.authToken.trim() !== '') {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          const AuthToken =
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
            Pulsar.AuthenticationToken || Pulsar.default?.AuthenticationToken;
          if (AuthToken) {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-call
            clientOptions.authentication = new AuthToken({
              token: this.config.authToken,
            });
          }
        }

        this.client = new (
          ClientConstructor as new (opts: unknown) => PulsarClientLike
        )(clientOptions);
      } catch (err) {
        this.logger.error(
          `Failed to load or connect to pulsar-client: ${String(err)}`,
        );
        throw new Error(
          `PulsarBrokerDriver: pulsar-client is not available or failed to initialize (${String(err)})`,
        );
      }
    }
    return this.client;
  }

  private getPhysicalTopic(topic: LogicalTopic): string {
    return this.topicMap.toPulsar(topic, {
      tenant: this.tenant,
      namespace: this.namespace,
    });
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    this.logger.log(
      `PulsarBrokerDriver initializing (serviceUrl: ${this.config.serviceUrl}, tenant: ${this.tenant}, namespace: ${this.namespace})`,
    );

    await this.getPulsarClient();
    this.isReady = true;
    this.logger.log('PulsarBrokerDriver ready');
  }

  async disconnect(): Promise<void> {
    this.isReady = false;
    this.logger.log('PulsarBrokerDriver disconnecting — draining consumers...');

    // Wait for in-flight handlers to drain (up to 5000ms)
    if (this.inFlightExecutions.size > 0) {
      this.logger.log(
        `PulsarBrokerDriver waiting for ${this.inFlightExecutions.size} in-flight handlers to drain...`,
      );
      await Promise.race([
        Promise.allSettled(Array.from(this.inFlightExecutions)),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    }

    // Stop consumer receive loops and close consumers
    for (const entry of this.activeConsumers) {
      entry.stopSignal.stopped = true;
      try {
        await entry.consumer.close();
      } catch (err) {
        this.logger.warn(`Error closing Pulsar consumer: ${String(err)}`);
      }
      try {
        await entry.loopPromise;
      } catch {
        // ignore loop completion errors during shutdown
      }
    }
    this.activeConsumers.length = 0;

    // Close all cached producers
    for (const [topic, producer] of this.producers.entries()) {
      try {
        await producer.close();
      } catch (err) {
        this.logger.warn(
          `Error closing Pulsar producer for ${topic}: ${String(err)}`,
        );
      }
    }
    this.producers.clear();

    // Close client if we own it
    if (this.client && !this.config.pulsarInstance) {
      try {
        await this.client.close();
      } catch (err) {
        this.logger.warn(`Error closing Pulsar client: ${String(err)}`);
      }
      this.client = null;
    }

    this.logger.log('PulsarBrokerDriver disconnected');
  }

  async healthCheck(): Promise<boolean> {
    await Promise.resolve();
    if (!this.isReady || !this.client) return false;
    return true;
  }

  // ─── Producer Management ───────────────────────────────────────────────────

  private async getProducer(
    physicalTopic: string,
  ): Promise<PulsarProducerLike> {
    let producer = this.producers.get(physicalTopic);
    if (!producer) {
      const client = await this.getPulsarClient();
      producer = await client.createProducer({
        topic: physicalTopic,
        sendTimeoutMs: (this.config.operationTimeoutSeconds ?? 30) * 1000,
        blockIfQueueFull: true,
        batchingEnabled: false,
      });
      this.producers.set(physicalTopic, producer);
    }
    return producer;
  }

  // ─── Publish ────────────────────────────────────────────────────────────────

  async publish<T>(
    topic: LogicalTopic,
    partitionKey: string,
    event: EventEnvelope<T>,
    opts?: PublishOptions,
  ): Promise<void> {
    if (!this.isReady) {
      // Auto-initialize if publish called before explicit initialize
      await this.initialize();
    }

    const physicalTopic = this.getPhysicalTopic(topic);
    const producer = await this.getProducer(physicalTopic);

    const properties: Record<string, string> = {
      'x-correlation-id': event.correlationId,
      'x-event-type': event.eventType,
      'x-schema-version': String(event.schemaVersion),
      ...(event.causationId ? { 'x-causation-id': event.causationId } : {}),
    };

    if (opts?.headers) {
      for (const [key, value] of Object.entries(opts.headers)) {
        if (value !== undefined && value !== null) {
          properties[key] = String(value);
        }
      }
    }

    if (opts?.deliverAfterMs && opts.deliverAfterMs > 0) {
      properties['x-not-before'] = String(Date.now() + opts.deliverAfterMs);
    }

    const payload = Buffer.from(JSON.stringify(event), 'utf8');

    await producer.send({
      data: payload,
      partitionKey,
      properties,
      eventTimestamp: Date.now(),
    });

    this.logger.debug(
      `Published ${event.eventType} → ${physicalTopic} (key=${partitionKey})`,
    );
  }

  // ─── Subscribe ──────────────────────────────────────────────────────────────

  async subscribe<T>(
    topic: LogicalTopic,
    opts: SubscribeOptions,
    handler: MessageHandler<T>,
  ): Promise<Subscription> {
    if (!this.isReady) {
      await this.initialize();
    }

    const client = await this.getPulsarClient();
    const physicalTopic = this.getPhysicalTopic(topic);
    const dlqPhysicalTopic = this.getPhysicalTopic('dlq');

    const consumer = await client.subscribe({
      topic: physicalTopic,
      subscription: opts.consumerGroup,
      subscriptionType: 'Key_Shared',
      enableRetry: true,
      deadLetterPolicy: {
        maxRedeliverCount: opts.maxAttempts,
        deadLetterTopic: dlqPhysicalTopic,
      },
    });

    const stopSignal = { stopped: false };
    const loopPromise = this.startConsumerLoop(
      consumer,
      topic,
      physicalTopic,
      opts,
      handler as MessageHandler<unknown>,
      stopSignal,
    );

    const entry: ActiveConsumerEntry = {
      consumer,
      stopSignal,
      loopPromise,
    };
    this.activeConsumers.push(entry);

    this.logger.log(
      `Subscribed to ${physicalTopic} (group=${opts.consumerGroup}, concurrency=${opts.concurrency}, maxAttempts=${opts.maxAttempts})`,
    );

    return {
      close: async () => {
        stopSignal.stopped = true;
        try {
          await consumer.close();
        } catch (err) {
          this.logger.warn(`Error closing consumer: ${String(err)}`);
        }
        try {
          await loopPromise;
        } catch {
          // ignore
        }
        const idx = this.activeConsumers.indexOf(entry);
        if (idx !== -1) {
          this.activeConsumers.splice(idx, 1);
        }
        this.logger.log(`Subscription to ${physicalTopic} closed`);
      },
    };
  }

  // ─── Consumer Run Loop ──────────────────────────────────────────────────────

  private async startConsumerLoop(
    consumer: PulsarConsumerLike,
    logicalTopic: LogicalTopic,
    physicalTopic: string,
    opts: SubscribeOptions,
    handler: MessageHandler<unknown>,
    stopSignal: { stopped: boolean },
  ): Promise<void> {
    const concurrency = Math.max(1, opts.concurrency ?? 1);

    const runWorker = async (): Promise<void> => {
      while (!stopSignal.stopped && this.isReady) {
        let msg: PulsarMessageLike | null = null;
        try {
          // Receive message with 200ms timeout to allow checking stopSignal periodically
          msg = await consumer.receive(200);
        } catch {
          // Timeout or connection error while polling; retry if not stopped
          if (stopSignal.stopped) break;
          continue;
        }

        if (!msg) continue;

        const execution = this.handleMessage(
          consumer,
          msg,
          logicalTopic,
          physicalTopic,
          opts,
          handler,
        );

        const tracked = execution.then(
          () => {},
          () => {},
        );
        this.inFlightExecutions.add(tracked);
        void tracked.finally(() => {
          this.inFlightExecutions.delete(tracked);
        });

        await execution;
      }
    };

    // Run concurrency workers in parallel sharing the consumer
    await Promise.allSettled(
      Array.from({ length: concurrency }, () => runWorker()),
    );
  }

  // ─── Message Handling ───────────────────────────────────────────────────────

  private async handleMessage(
    consumer: PulsarConsumerLike,
    msg: PulsarMessageLike,
    logicalTopic: LogicalTopic,
    physicalTopic: string,
    opts: SubscribeOptions,
    handler: MessageHandler<unknown>,
  ): Promise<void> {
    const properties = msg.getProperties?.() ?? {};

    // Honour x-not-before delay if present
    const notBeforeHeader = properties['x-not-before'];
    if (notBeforeHeader) {
      const notBefore = parseInt(notBeforeHeader, 10);
      const now = Date.now();
      if (now < notBefore) {
        const waitMs = notBefore - now;
        this.logger.debug(
          `Waiting ${waitMs}ms until ${new Date(notBefore).toISOString()} for delayed Pulsar message`,
        );
        await new Promise<void>((r) => setTimeout(r, waitMs));
      }
    }

    let envelope: EventEnvelope<unknown>;
    try {
      const raw = msg.getData().toString('utf8');
      envelope = JSON.parse(raw) as EventEnvelope<unknown>;
    } catch (parseErr) {
      this.logger.error(
        `Failed to parse message on ${physicalTopic}: ${String(parseErr)} — sending to DLQ`,
      );
      await this.publishToDlq(
        logicalTopic,
        msg.getPartitionKey() || 'unknown',
        {
          eventId: 'malformed-' + Date.now(),
          eventType: 'unknown',
          schemaVersion: 1,
          timestamp: new Date().toISOString(),
          correlationId: properties['x-correlation-id'] ?? 'unknown',
          causationId: properties['x-causation-id'],
          namespace: 'default',
          tenantId: this.tenant,
          partitionKey: msg.getPartitionKey() || 'unknown',
          attempt: 0,
          payload: { raw: msg.getData().toString('utf8') },
        },
        'malformed-json',
        String(parseErr),
        1,
        new Date().toISOString(),
      );
      await consumer.acknowledge(msg);
      return;
    }

    const attempt = msg.getRedeliveryCount?.() ?? 0;

    const meta: DeliveryMeta = {
      topic: logicalTopic,
      partitionKey: msg.getPartitionKey() || envelope.partitionKey,
      attempt,
      headers: properties,
      timestamp: new Date().toISOString(),
    };

    let outcome: HandlerOutcome;
    try {
      const handlerTimeoutMs =
        (opts as { handlerTimeoutMs?: number }).handlerTimeoutMs ?? 30_000;
      outcome = await Promise.race([
        handler(envelope, meta),
        new Promise<HandlerOutcome>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `Handler timed out after ${handlerTimeoutMs}ms for ${envelope.eventType} (${envelope.eventId})`,
                ),
              ),
            handlerTimeoutMs,
          ),
        ),
      ]);
    } catch (handlerErr) {
      this.logger.error(
        `Handler error for ${envelope.eventType} (${envelope.eventId}, attempt ${attempt + 1}/${opts.maxAttempts}): ${String(handlerErr)}`,
      );
      outcome = {
        kind: 'retry',
        reason: String(handlerErr),
        delayMs: Math.min(1000 * Math.pow(2, attempt), 30_000),
      };
    }

    // Process Outcome
    if (outcome.kind === 'ack') {
      await consumer.acknowledge(msg);
      return;
    }

    const firstFailedAt =
      properties['x-first-failed-at'] ?? new Date().toISOString();

    if (outcome.kind === 'dead-letter') {
      const err = (outcome as { error?: string }).error ?? outcome.reason;
      this.logger.warn(
        `Dead-lettering ${envelope.eventType} (${envelope.eventId}): reason=${outcome.reason} error=${err}`,
      );
      await this.publishToDlq(
        logicalTopic,
        msg.getPartitionKey() || envelope.partitionKey,
        envelope,
        outcome.reason,
        err,
        attempt + 1,
        firstFailedAt,
      );
      await consumer.acknowledge(msg);
      return;
    }

    if (outcome.kind === 'retry') {
      const nextAttempt = attempt + 1;
      if (nextAttempt >= opts.maxAttempts) {
        const errorReason = `Exceeded max attempts (${opts.maxAttempts}): ${outcome.reason}`;
        this.logger.warn(
          `Exhausted attempts (${nextAttempt}/${opts.maxAttempts}) for ${envelope.eventType} (${envelope.eventId}) → routing to DLQ`,
        );
        await this.publishToDlq(
          logicalTopic,
          msg.getPartitionKey() || envelope.partitionKey,
          envelope,
          'exhausted-attempts',
          errorReason,
          nextAttempt,
          firstFailedAt,
        );
        await consumer.acknowledge(msg);
      } else {
        const delayMs = outcome.delayMs ?? 1000;
        this.logger.debug(
          `Retrying ${envelope.eventType} (${envelope.eventId}) in ${delayMs}ms via reconsumeLater (next attempt ${nextAttempt}/${opts.maxAttempts})`,
        );
        try {
          await consumer.reconsumeLater(msg, delayMs);
        } catch (reconsumeErr) {
          this.logger.warn(
            `reconsumeLater failed, falling back to negativeAcknowledge: ${String(reconsumeErr)}`,
          );
          await consumer.negativeAcknowledge(msg);
        }
      }
    }
  }

  // ─── Dead-Letter Routing ────────────────────────────────────────────────────

  private async publishToDlq(
    originalLogicalTopic: LogicalTopic,
    partitionKey: string,
    envelope: EventEnvelope<unknown>,
    reason: string,
    error: string,
    attempts: number,
    firstFailedAt: string,
  ): Promise<void> {
    const dlqHeaders: Record<string, string> = {
      'x-correlation-id': envelope.correlationId,
      'x-event-type': envelope.eventType,
      'x-schema-version': String(envelope.schemaVersion),
      'x-original-topic': originalLogicalTopic,
      'x-dlq-reason': reason,
      'x-dlq-timestamp': new Date().toISOString(),
      'x-error': error,
      'x-dlq-error': error,
      'x-attempts': String(attempts),
      'x-first-failed-at': firstFailedAt,
      ...(envelope.causationId
        ? { 'x-causation-id': envelope.causationId }
        : {}),
    };

    try {
      await this.publish('dlq', partitionKey, envelope, {
        headers: dlqHeaders,
      });
    } catch (dlqErr) {
      this.logger.error(
        `CRITICAL: Failed to publish to DLQ for event ${envelope.eventId}: ${String(dlqErr)}`,
      );
    }
  }
}
