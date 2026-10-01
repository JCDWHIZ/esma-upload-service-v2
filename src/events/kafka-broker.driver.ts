import { Logger } from '@nestjs/common';
import type { KafkaJS } from '@confluentinc/kafka-javascript';
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
import type { TopicMap, KafkaRetryTier } from './topic-map.js';

// ─── Configuration ────────────────────────────────────────────────────────────

export interface KafkaBrokerConfig {
  readonly brokers: string; // comma-separated
  readonly clientId: string;
  readonly topicMap: TopicMap;
  readonly topicPrefix: string;
  readonly topicPartitions: number;
  readonly topicReplicationFactor: number;
  readonly ssl: boolean;
  readonly saslMechanism?: 'plain' | 'scram-sha-256' | 'scram-sha-512';
  readonly saslUsername?: string;
  readonly saslPassword?: string;
  readonly ensureTopics: boolean; // false in production
  readonly kafkaInstance?: KafkaJS.Kafka; // Optional injected instance (e.g. testing)
}

// ─── Internal types ──────────────────────────────────────────────────────────

const RETRY_TIERS: { tier: KafkaRetryTier; maxDelayMs: number }[] = [
  { tier: '10s', maxDelayMs: 30_000 },
  { tier: '1m', maxDelayMs: 300_000 },
  { tier: '10m', maxDelayMs: Infinity },
];

function pickRetryTier(delayMs: number): KafkaRetryTier {
  for (const { tier, maxDelayMs } of RETRY_TIERS) {
    if (delayMs <= maxDelayMs) return tier;
  }
  return '10m';
}

function buildKafkaConfig(config: KafkaBrokerConfig): KafkaJS.KafkaConfig {
  const brokerList = config.brokers.split(',').map((b) => b.trim());
  const kafkaConfig: KafkaJS.KafkaConfig = {
    brokers: brokerList,
    clientId: config.clientId,
    ssl: config.ssl,
  };

  if (config.saslMechanism && config.saslUsername && config.saslPassword) {
    kafkaConfig.sasl = {
      mechanism: config.saslMechanism,
      username: config.saslUsername,
      password: config.saslPassword,
    };
  }

  return kafkaConfig;
}

// ─── KafkaBrokerDriver ────────────────────────────────────────────────────────

export class KafkaBrokerDriver implements IMessageBroker {
  public readonly name = 'kafka' as const;

  private readonly logger = new Logger(KafkaBrokerDriver.name);
  private kafka: KafkaJS.Kafka | null = null;
  private producer: KafkaJS.Producer | null = null;
  private admin: KafkaJS.Admin | null = null;
  private readonly activeConsumers: KafkaJS.Consumer[] = [];
  private isReady = false;

  constructor(private readonly config: KafkaBrokerConfig) {
    if (config.kafkaInstance) {
      this.kafka = config.kafkaInstance;
    }
  }

  private async getKafkaClient(): Promise<KafkaJS.Kafka> {
    if (!this.kafka) {
      const { KafkaJS } = await import('@confluentinc/kafka-javascript');
      this.kafka = new KafkaJS.Kafka({
        kafkaJS: buildKafkaConfig(this.config),
      });
    }
    return this.kafka;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    this.logger.log(
      `KafkaBrokerDriver initializing (brokers: ${this.config.brokers})`,
    );

    const kafka = await this.getKafkaClient();

    this.producer = kafka.producer({
      kafkaJS: {
        idempotent: true,
        acks: -1,
        retry: { retries: 10 },
      },
    });
    await this.producer.connect();

    this.admin = kafka.admin();
    await this.admin.connect();

    if (this.config.ensureTopics) {
      await this.ensureTopics();
    }

    this.isReady = true;
    this.logger.log('KafkaBrokerDriver ready');
  }

  async disconnect(): Promise<void> {
    this.isReady = false;
    this.logger.log('KafkaBrokerDriver disconnecting — draining consumers...');

    await Promise.allSettled(
      this.activeConsumers.map(async (c) => {
        try {
          await c.stop();
          await c.disconnect();
        } catch (err) {
          this.logger.warn(`Error disconnecting consumer: ${String(err)}`);
        }
      }),
    );
    this.activeConsumers.length = 0;

    if (this.producer) {
      await this.producer.disconnect();
      this.producer = null;
    }
    if (this.admin) {
      await this.admin.disconnect();
      this.admin = null;
    }
    if (!this.config.kafkaInstance) {
      this.kafka = null;
    }

    this.logger.log('KafkaBrokerDriver disconnected');
  }

  async healthCheck(): Promise<boolean> {
    if (!this.isReady || !this.admin) return false;
    try {
      await this.admin.listTopics({ timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  // ─── Publish ────────────────────────────────────────────────────────────────

  async publish<T>(
    topic: LogicalTopic,
    partitionKey: string,
    event: EventEnvelope<T>,
    opts?: PublishOptions,
  ): Promise<void> {
    if (!this.producer) {
      throw new Error('KafkaBrokerDriver: producer not initialized');
    }

    const physicalTopic = this.config.topicMap.toKafka(topic);
    const headers: KafkaJS.IHeaders = {
      'x-correlation-id': event.correlationId,
      'x-event-type': event.eventType,
      'x-schema-version': String(event.schemaVersion),
      ...(event.causationId ? { 'x-causation-id': event.causationId } : {}),
      ...(opts?.headers ?? {}),
    };

    if (opts?.deliverAfterMs && opts.deliverAfterMs > 0) {
      headers['x-not-before'] = String(Date.now() + opts.deliverAfterMs);
    }

    await this.producer.send({
      topic: physicalTopic,
      messages: [
        {
          key: partitionKey,
          value: JSON.stringify(event),
          headers,
        },
      ],
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
    const physicalTopic = this.config.topicMap.toKafka(topic);
    const kafka = await this.getKafkaClient();

    const consumer = kafka.consumer({
      kafkaJS: {
        groupId: opts.consumerGroup,
        autoCommit: false,
      },
    });

    await consumer.connect();
    await consumer.subscribe({ topics: [physicalTopic] });
    this.activeConsumers.push(consumer);

    // Start the consumer run loop
    void consumer.run({
      partitionsConsumedConcurrently: opts.concurrency,
      eachMessage: async (payload) => {
        await this.handleMessage(
          consumer,
          payload.topic,
          payload.partition,
          payload.message,
          topic,
          opts,
          handler as MessageHandler<unknown>,
          () => payload.pause(),
        );
      },
    });

    this.logger.log(
      `Subscribed to ${physicalTopic} (group=${opts.consumerGroup}, concurrency=${opts.concurrency})`,
    );

    return {
      close: async () => {
        await consumer.stop();
        await consumer.disconnect();
        const idx = this.activeConsumers.indexOf(consumer);
        if (idx !== -1) this.activeConsumers.splice(idx, 1);
        this.logger.log(`Subscription to ${physicalTopic} closed`);
      },
    };
  }

  // ─── Message Handling ───────────────────────────────────────────────────────

  private async handleMessage(
    consumer: KafkaJS.Consumer,
    msgTopic: string,
    partition: number,
    message: KafkaJS.KafkaMessage,
    logicalTopic: LogicalTopic,
    opts: SubscribeOptions,
    handler: MessageHandler<unknown>,
    pause: () => () => void,
  ): Promise<void> {
    // Honour x-not-before header for retry tier consumers
    const notBeforeHeader = this.getHeader(message, 'x-not-before');
    if (notBeforeHeader) {
      const notBefore = parseInt(notBeforeHeader, 10);
      const now = Date.now();
      if (now < notBefore) {
        const waitMs = notBefore - now;
        this.logger.debug(
          `Pausing ${msgTopic}[${partition}] for ${waitMs}ms until ${new Date(notBefore).toISOString()}`,
        );
        const resume = pause();
        await new Promise<void>((r) => setTimeout(r, waitMs));
        resume();
        return;
      }
    }

    let envelope: EventEnvelope<unknown>;
    try {
      const raw = message.value?.toString() ?? '{}';
      envelope = JSON.parse(raw) as EventEnvelope<unknown>;
    } catch {
      await this.publishToDlq(
        null,
        logicalTopic,
        message,
        'Unparseable message body',
        1,
        new Date().toISOString(),
      );
      await this.commitMessage(consumer, msgTopic, partition, message);
      return;
    }

    const attempt = envelope.attempt ?? 0;
    const meta: DeliveryMeta = {
      topic: logicalTopic,
      partitionKey: message.key?.toString() ?? envelope.partitionKey,
      attempt,
      headers: this.extractHeaders(message),
      timestamp: message.timestamp ?? new Date().toISOString(),
    };

    let outcome: HandlerOutcome;
    try {
      outcome = await handler(envelope, meta);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      outcome = { kind: 'retry', reason };
    }

    await this.handleOutcome(
      consumer,
      msgTopic,
      partition,
      message,
      logicalTopic,
      envelope,
      attempt,
      opts,
      outcome,
    );
  }

  // ─── Outcome Routing ────────────────────────────────────────────────────────

  private async handleOutcome(
    consumer: KafkaJS.Consumer,
    msgTopic: string,
    partition: number,
    message: KafkaJS.KafkaMessage,
    logicalTopic: LogicalTopic,
    envelope: EventEnvelope<unknown>,
    attempt: number,
    opts: SubscribeOptions,
    outcome: HandlerOutcome,
  ): Promise<void> {
    if (outcome.kind === 'ack') {
      await this.commitMessage(consumer, msgTopic, partition, message);
      return;
    }

    if (outcome.kind === 'dead-letter') {
      const firstFailedAt =
        this.getHeader(message, 'x-first-failed-at') ??
        new Date().toISOString();
      await this.publishToDlq(
        envelope,
        logicalTopic,
        message,
        outcome.reason,
        attempt + 1,
        firstFailedAt,
      );
      await this.commitMessage(consumer, msgTopic, partition, message);
      return;
    }

    // retry outcome
    const nextAttempt = attempt + 1;
    const firstFailedAt =
      this.getHeader(message, 'x-first-failed-at') ?? new Date().toISOString();

    if (nextAttempt >= opts.maxAttempts) {
      await this.publishToDlq(
        envelope,
        logicalTopic,
        message,
        `Exceeded max attempts (${opts.maxAttempts}): ${outcome.reason}`,
        nextAttempt,
        firstFailedAt,
      );
      await this.commitMessage(consumer, msgTopic, partition, message);
      return;
    }

    const delayMs = Math.max(0, outcome.delayMs ?? 10_000);
    const tier = pickRetryTier(delayMs);
    const retryTopic = this.config.topicMap.toKafkaRetry(logicalTopic, tier);

    const retryEnvelope: EventEnvelope<unknown> = {
      ...envelope,
      attempt: nextAttempt,
    };

    const notBefore = Date.now() + delayMs;
    await this.publishRaw(
      retryTopic,
      message.key?.toString() ?? envelope.partitionKey,
      retryEnvelope,
      {
        'x-not-before': String(notBefore),
        'x-original-topic': logicalTopic,
        'x-first-failed-at': firstFailedAt,
        'x-attempts': String(nextAttempt),
      },
    );

    await this.commitMessage(consumer, msgTopic, partition, message);
    this.logger.debug(
      `Retried ${envelope.eventType} → ${retryTopic} (attempt=${nextAttempt}, delay=${delayMs}ms)`,
    );
  }

  // ─── DLQ ────────────────────────────────────────────────────────────────────

  private async publishToDlq(
    envelope: EventEnvelope<unknown> | null,
    originalTopic: LogicalTopic,
    message: KafkaJS.KafkaMessage,
    reason: string,
    attempts: number,
    firstFailedAt: string,
  ): Promise<void> {
    const dlqTopic = this.config.topicMap.toKafka('dlq');
    const extraHeaders: Record<string, string> = {
      'x-original-topic': originalTopic,
      'x-event-type': envelope?.eventType ?? 'unknown',
      'x-error': reason,
      'x-attempts': String(attempts),
      'x-first-failed-at': firstFailedAt,
    };

    const partitionKey =
      message.key?.toString() ?? envelope?.partitionKey ?? 'unknown';

    if (envelope) {
      await this.publishRaw(dlqTopic, partitionKey, envelope, extraHeaders);
    } else {
      // Unparseable — forward raw bytes with DLQ headers
      if (!this.producer) return;
      await this.producer.send({
        topic: dlqTopic,
        messages: [
          {
            key: partitionKey,
            value: message.value ?? Buffer.from('{}'),
            headers: extraHeaders,
          },
        ],
      });
    }

    this.logger.warn(
      `DLQ: ${extraHeaders['x-event-type']} on ${originalTopic} after ${attempts} attempts — ${reason}`,
    );
  }

  // ─── Topic Management ───────────────────────────────────────────────────────

  private async ensureTopics(): Promise<void> {
    if (!this.admin) return;

    const logicalTopics: LogicalTopic[] = [
      'replication',
      'processing',
      'audit',
      'dlq',
    ];
    const retryTiers: KafkaRetryTier[] = ['10s', '1m', '10m'];
    const topicsToCreate: KafkaJS.ITopicConfig[] = [];

    // Main topics
    for (const logical of logicalTopics) {
      topicsToCreate.push({
        topic: this.config.topicMap.toKafka(logical),
        numPartitions: this.config.topicPartitions,
        replicationFactor: this.config.topicReplicationFactor,
        configEntries: [
          { name: 'retention.ms', value: String(7 * 24 * 60 * 60 * 1000) },
          { name: 'cleanup.policy', value: 'delete' },
        ],
      });
    }

    // Retry tier topics for replication and processing
    for (const logical of ['replication', 'processing'] as LogicalTopic[]) {
      for (const tier of retryTiers) {
        topicsToCreate.push({
          topic: this.config.topicMap.toKafkaRetry(logical, tier),
          numPartitions: this.config.topicPartitions,
          replicationFactor: this.config.topicReplicationFactor,
          configEntries: [
            { name: 'retention.ms', value: String(24 * 60 * 60 * 1000) },
            { name: 'cleanup.policy', value: 'delete' },
          ],
        });
      }
    }

    const existing = await this.admin.listTopics();
    const existingSet = new Set(existing);
    const toCreate = topicsToCreate.filter((t) => !existingSet.has(t.topic));

    if (toCreate.length > 0) {
      await this.admin.createTopics({ topics: toCreate });
      this.logger.log(
        `Created Kafka topics: ${toCreate.map((t) => t.topic).join(', ')}`,
      );
    } else {
      this.logger.log('All Kafka topics already exist');
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private async publishRaw(
    physicalTopic: string,
    partitionKey: string,
    envelope: EventEnvelope<unknown>,
    extraHeaders: Record<string, string>,
  ): Promise<void> {
    if (!this.producer) return;
    await this.producer.send({
      topic: physicalTopic,
      messages: [
        {
          key: partitionKey,
          value: JSON.stringify(envelope),
          headers: {
            'x-correlation-id': envelope.correlationId,
            'x-event-type': envelope.eventType,
            ...extraHeaders,
          },
        },
      ],
    });
  }

  private async commitMessage(
    consumer: KafkaJS.Consumer,
    topic: string,
    partition: number,
    message: KafkaJS.KafkaMessage,
  ): Promise<void> {
    const offset = message.offset;
    try {
      await consumer.commitOffsets([
        {
          topic,
          partition,
          offset: String(parseInt(offset, 10) + 1),
        },
      ]);
    } catch (err) {
      this.logger.warn(`Failed to commit offset ${offset}: ${String(err)}`);
    }
  }

  private getHeader(
    message: KafkaJS.KafkaMessage,
    key: string,
  ): string | undefined {
    if (!('headers' in message) || !message.headers) return undefined;
    const val = (
      message.headers as Record<string, Buffer | string | undefined>
    )[key];
    if (!val) return undefined;
    return Buffer.isBuffer(val) ? val.toString() : String(val);
  }

  private extractHeaders(
    message: KafkaJS.KafkaMessage,
  ): Record<string, string> {
    if (!('headers' in message) || !message.headers) return {};
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(
      message.headers as Record<string, Buffer | string | undefined>,
    )) {
      if (v !== undefined) {
        result[k] = Buffer.isBuffer(v) ? v.toString() : String(v);
      }
    }
    return result;
  }
}
