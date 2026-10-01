/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/require-await, @typescript-eslint/unbound-method */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  PulsarBrokerDriver,
  type PulsarClientLike,
  type PulsarProducerLike,
  type PulsarConsumerLike,
  type PulsarMessageLike,
  type PulsarProducerConfigLike,
  type PulsarConsumerConfigLike,
} from '../../src/events/pulsar-broker.driver.js';
import { TopicMap } from '../../src/events/topic-map.js';
import { createEnvelope } from '../../src/events/envelope.js';
import { EVENT_TYPES } from '../../src/events/catalog.js';

describe('PulsarBrokerDriver (P5-04)', () => {
  let driver: PulsarBrokerDriver;
  let topicMap: TopicMap;

  // Mock Pulsar State
  let sentMessages: Array<{
    topic: string;
    message: {
      data: Buffer;
      partitionKey?: string;
      properties?: Record<string, string>;
      eventTimestamp?: number;
    };
  }>;

  let createdProducers: Map<string, PulsarProducerLike>;
  let createdConsumers: PulsarConsumerLike[];
  let mockClient: PulsarClientLike;

  // Helpers to create simulated incoming Pulsar messages
  const createMockMessage = (opts: {
    topic: string;
    data: unknown;
    partitionKey?: string;
    properties?: Record<string, string>;
    redeliveryCount?: number;
  }): PulsarMessageLike => {
    const rawData =
      typeof opts.data === 'string'
        ? Buffer.from(opts.data, 'utf8')
        : Buffer.from(JSON.stringify(opts.data), 'utf8');

    return {
      getData: () => rawData,
      getMessageId: () => 'msg-id-12345',
      getPartitionKey: () => opts.partitionKey ?? 'key-1',
      getProperties: () => opts.properties ?? {},
      getTopicName: () => opts.topic,
      getRedeliveryCount: () => opts.redeliveryCount ?? 0,
      getEventTimestamp: () => Date.now(),
    };
  };

  beforeEach(() => {
    sentMessages = [];
    createdProducers = new Map();
    createdConsumers = [];

    topicMap = new TopicMap({
      pulsarTenant: 'esma',
      pulsarNamespace: 'uploads',
    });

    mockClient = {
      createProducer: vi
        .fn()
        .mockImplementation(async (config: PulsarProducerConfigLike) => {
          const producer: PulsarProducerLike = {
            send: vi.fn().mockImplementation(async (msg: any) => {
              sentMessages.push({ topic: config.topic, message: msg });
            }),
            flush: vi.fn().mockResolvedValue(undefined),
            close: vi.fn().mockResolvedValue(undefined),
          };
          createdProducers.set(config.topic, producer);
          return producer;
        }),

      subscribe: vi
        .fn()
        .mockImplementation(async (config: PulsarConsumerConfigLike) => {
          const incomingQueue: PulsarMessageLike[] = [];
          const receiveResolvers: Array<(msg: PulsarMessageLike) => void> = [];

          const consumer: PulsarConsumerLike = {
            receive: vi.fn().mockImplementation(async (timeoutMs = 1000) => {
              if (incomingQueue.length > 0) {
                return incomingQueue.shift()!;
              }
              return new Promise<PulsarMessageLike>((resolve, reject) => {
                const timer = setTimeout(() => {
                  const idx = receiveResolvers.indexOf(resolve);
                  if (idx !== -1) receiveResolvers.splice(idx, 1);
                  reject(new Error('Receive timeout'));
                }, timeoutMs);

                receiveResolvers.push((msg) => {
                  clearTimeout(timer);
                  resolve(msg);
                });
              });
            }),
            acknowledge: vi.fn().mockResolvedValue(undefined),
            negativeAcknowledge: vi.fn(),
            reconsumeLater: vi.fn().mockResolvedValue(undefined),
            close: vi.fn().mockResolvedValue(undefined),
          };

          // Attach simulated message injector
          (consumer as any).pushMessage = (msg: PulsarMessageLike) => {
            if (receiveResolvers.length > 0) {
              const resolve = receiveResolvers.shift()!;
              resolve(msg);
            } else {
              incomingQueue.push(msg);
            }
          };

          (consumer as any).config = config;
          createdConsumers.push(consumer);
          return consumer;
        }),

      close: vi.fn().mockResolvedValue(undefined),
    };

    driver = new PulsarBrokerDriver({
      serviceUrl: 'pulsar://localhost:6650',
      tenant: 'esma',
      namespace: 'uploads',
      topicMap,
      pulsarInstance: mockClient,
    });
  });

  afterEach(async () => {
    await driver.disconnect();
  });

  // ─── 1. Lifecycle ─────────────────────────────────────────────────────────────

  describe('Lifecycle', () => {
    it('initializes and reports healthCheck = true', async () => {
      expect(await driver.healthCheck()).toBe(false);
      await driver.initialize();
      expect(await driver.healthCheck()).toBe(true);
    });

    it('reports healthCheck = false after disconnect', async () => {
      await driver.initialize();
      expect(await driver.healthCheck()).toBe(true);

      await driver.disconnect();
      expect(await driver.healthCheck()).toBe(false);
    });

    it('gracefully drains in-flight handlers and closes resources on disconnect', async () => {
      await driver.initialize();

      let handlerRunning = false;
      let handlerFinished = false;

      const sub = await driver.subscribe(
        'replication',
        { consumerGroup: 'test-group', concurrency: 1, maxAttempts: 3 },
        async () => {
          handlerRunning = true;
          await new Promise((r) => setTimeout(r, 60));
          handlerFinished = true;
          return { kind: 'ack' };
        },
      );

      const consumer = createdConsumers[0] as any;
      const envelope = createEnvelope({
        eventType: EVENT_TYPES.FILE_REPLICATE,
        partitionKey: 'file-123',
        payload: { fileId: 'file-123', targetProvider: 'seaweedfs' },
        correlationId: 'corr-1',
      });

      consumer.pushMessage(
        createMockMessage({
          topic: topicMap.toPulsar('replication'),
          data: envelope,
          partitionKey: 'file-123',
        }),
      );

      // Wait for handler to start
      while (!handlerRunning) {
        await new Promise((r) => setTimeout(r, 5));
      }

      // Disconnect while handler is in flight
      await driver.disconnect();

      expect(handlerFinished).toBe(true);
      expect(consumer.close).toHaveBeenCalled();
      await sub.close();
    });
  });

  // ─── 2. Publishing ───────────────────────────────────────────────────────────

  describe('Publishing', () => {
    it('publishes event to persistent://{tenant}/{namespace}/{topic} with envelope, key and properties', async () => {
      await driver.initialize();

      const envelope = createEnvelope({
        eventType: EVENT_TYPES.FILE_UPLOADED,
        partitionKey: 'file-upload-1',
        payload: {
          fileId: 'file-upload-1',
          storageKey: 'tenants/t-1/test.pdf',
          sizeBytes: 1024,
          primaryProvider: 'seaweedfs',
          sha256: 'hash-abc',
        },
        correlationId: 'corr-publish-1',
        causationId: 'caus-root-0',
      });

      await driver.publish('replication', 'file-upload-1', envelope, {
        headers: { 'x-custom-tenant': 'tenant-alpha' },
      });

      expect(sentMessages).toHaveLength(1);
      const sent = sentMessages[0];

      expect(sent.topic).toBe('persistent://esma/uploads/replication');
      expect(sent.message.partitionKey).toBe('file-upload-1');

      const payload = JSON.parse(sent.message.data.toString('utf8'));
      expect(payload).toEqual(envelope);

      expect(sent.message.properties).toMatchObject({
        'x-correlation-id': 'corr-publish-1',
        'x-event-type': EVENT_TYPES.FILE_UPLOADED,
        'x-schema-version': '1',
        'x-causation-id': 'caus-root-0',
        'x-custom-tenant': 'tenant-alpha',
      });
    });

    it('attaches x-not-before property when deliverAfterMs is provided', async () => {
      await driver.initialize();

      const envelope = createEnvelope({
        eventType: EVENT_TYPES.FILE_REPLICATE,
        partitionKey: 'file-delayed',
        payload: { fileId: 'file-delayed', targetProvider: 'local' },
        correlationId: 'corr-delay',
      });

      const before = Date.now();
      await driver.publish('replication', 'file-delayed', envelope, {
        deliverAfterMs: 5000,
      });

      expect(sentMessages).toHaveLength(1);
      const notBeforeStr = sentMessages[0].message.properties?.['x-not-before'];
      expect(notBeforeStr).toBeDefined();

      const notBefore = parseInt(notBeforeStr!, 10);
      expect(notBefore).toBeGreaterThanOrEqual(before + 4900);
    });

    it('reuses cached producer for the same physical topic', async () => {
      await driver.initialize();

      const env1 = createEnvelope({
        eventType: EVENT_TYPES.FILE_UPLOADED,
        partitionKey: 'f-1',
        payload: {
          fileId: 'f-1',
          storageKey: 'k',
          sizeBytes: 10,
          primaryProvider: 'local',
          sha256: 'h',
        },
        correlationId: 'c1',
      });
      const env2 = createEnvelope({
        eventType: EVENT_TYPES.FILE_UPLOADED,
        partitionKey: 'f-2',
        payload: {
          fileId: 'f-2',
          storageKey: 'k',
          sizeBytes: 10,
          primaryProvider: 'local',
          sha256: 'h',
        },
        correlationId: 'c2',
      });

      await driver.publish('replication', 'f-1', env1);
      await driver.publish('replication', 'f-2', env2);

      expect(mockClient.createProducer).toHaveBeenCalledTimes(1);
      expect(sentMessages).toHaveLength(2);
    });
  });

  // ─── 3. Subscriptions & Outcome Handling ─────────────────────────────────────

  describe('Subscriptions & Outcome Handling', () => {
    it('subscribes with Key_Shared subscriptionType and deadLetterPolicy', async () => {
      await driver.initialize();

      await driver.subscribe(
        'replication',
        { consumerGroup: 'rep-worker-group', concurrency: 2, maxAttempts: 5 },
        async () => ({ kind: 'ack' }),
      );

      expect(mockClient.subscribe).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: 'persistent://esma/uploads/replication',
          subscription: 'rep-worker-group',
          subscriptionType: 'Key_Shared',
          enableRetry: true,
          deadLetterPolicy: {
            maxRedeliverCount: 5,
            deadLetterTopic: 'persistent://esma/uploads/dlq',
          },
        }),
      );
    });

    it('acknowledges message when handler returns ack', async () => {
      await driver.initialize();

      let deliveredEnvelope: any = null;
      let deliveredMeta: any = null;

      await driver.subscribe(
        'replication',
        { consumerGroup: 'worker-ack', concurrency: 1, maxAttempts: 3 },
        async (env, meta) => {
          deliveredEnvelope = env;
          deliveredMeta = meta;
          return { kind: 'ack' };
        },
      );

      const consumer = createdConsumers[0] as any;
      const envelope = createEnvelope({
        eventType: EVENT_TYPES.FILE_REPLICATE,
        partitionKey: 'f-ack-1',
        payload: { fileId: 'f-ack-1', targetProvider: 'seaweedfs' },
        correlationId: 'corr-ack-99',
      });

      const mockMsg = createMockMessage({
        topic: topicMap.toPulsar('replication'),
        data: envelope,
        partitionKey: 'f-ack-1',
        properties: { 'x-correlation-id': 'corr-ack-99' },
        redeliveryCount: 0,
      });

      consumer.pushMessage(mockMsg);

      // Wait for execution
      await new Promise((r) => setTimeout(r, 40));

      expect(deliveredEnvelope).toEqual(envelope);
      expect(deliveredMeta.topic).toBe('replication');
      expect(deliveredMeta.partitionKey).toBe('f-ack-1');
      expect(deliveredMeta.attempt).toBe(0);
      expect(consumer.acknowledge).toHaveBeenCalledWith(mockMsg);
      expect(consumer.reconsumeLater).not.toHaveBeenCalled();
    });

    it('calls reconsumeLater with delayMs when handler returns retry before maxAttempts', async () => {
      await driver.initialize();

      await driver.subscribe(
        'replication',
        { consumerGroup: 'worker-retry', concurrency: 1, maxAttempts: 3 },
        async () => ({
          kind: 'retry',
          reason: 'transient network error',
          delayMs: 2500,
        }),
      );

      const consumer = createdConsumers[0] as any;
      const envelope = createEnvelope({
        eventType: EVENT_TYPES.FILE_REPLICATE,
        partitionKey: 'f-retry-1',
        payload: { fileId: 'f-retry-1', targetProvider: 'seaweedfs' },
        correlationId: 'corr-retry-1',
      });

      const mockMsg = createMockMessage({
        topic: topicMap.toPulsar('replication'),
        data: envelope,
        partitionKey: 'f-retry-1',
        redeliveryCount: 1, // attempt 2 of 3
      });

      consumer.pushMessage(mockMsg);

      await new Promise((r) => setTimeout(r, 40));

      expect(consumer.reconsumeLater).toHaveBeenCalledWith(mockMsg, 2500);
      expect(consumer.acknowledge).not.toHaveBeenCalled();
    });

    it('routes to DLQ and acknowledges when retry attempts are exhausted', async () => {
      await driver.initialize();

      await driver.subscribe(
        'replication',
        {
          consumerGroup: 'worker-dlq-exhausted',
          concurrency: 1,
          maxAttempts: 3,
        },
        async () => ({
          kind: 'retry',
          reason: 'exhaustion test error',
          delayMs: 1000,
        }),
      );

      const consumer = createdConsumers[0] as any;
      const envelope = createEnvelope({
        eventType: EVENT_TYPES.FILE_REPLICATE,
        partitionKey: 'f-exhausted',
        payload: { fileId: 'f-exhausted', targetProvider: 'seaweedfs' },
        correlationId: 'corr-exhausted',
      });

      const mockMsg = createMockMessage({
        topic: topicMap.toPulsar('replication'),
        data: envelope,
        partitionKey: 'f-exhausted',
        redeliveryCount: 2, // attempt 3 of 3 (exhausted)
      });

      consumer.pushMessage(mockMsg);

      await new Promise((r) => setTimeout(r, 40));

      expect(consumer.reconsumeLater).not.toHaveBeenCalled();
      expect(consumer.acknowledge).toHaveBeenCalledWith(mockMsg);

      // Verify DLQ event published
      const dlqMsg = sentMessages.find(
        (m) => m.topic === 'persistent://esma/uploads/dlq',
      );
      expect(dlqMsg).toBeDefined();
      expect(dlqMsg?.message.properties).toMatchObject({
        'x-original-topic': 'replication',
        'x-dlq-reason': 'exhausted-attempts',
        'x-correlation-id': 'corr-exhausted',
      });
    });

    it('routes immediately to DLQ and acknowledges when outcome is dead-letter', async () => {
      await driver.initialize();

      await driver.subscribe(
        'replication',
        { consumerGroup: 'worker-direct-dlq', concurrency: 1, maxAttempts: 5 },
        async () => ({
          kind: 'dead-letter',
          reason: 'unrecoverable-format',
          error: 'Corrupt magic bytes',
        }),
      );

      const consumer = createdConsumers[0] as any;
      const envelope = createEnvelope({
        eventType: EVENT_TYPES.FILE_REPLICATE,
        partitionKey: 'f-poison',
        payload: { fileId: 'f-poison', targetProvider: 'seaweedfs' },
        correlationId: 'corr-poison',
      });

      const mockMsg = createMockMessage({
        topic: topicMap.toPulsar('replication'),
        data: envelope,
        partitionKey: 'f-poison',
        redeliveryCount: 0,
      });

      consumer.pushMessage(mockMsg);

      await new Promise((r) => setTimeout(r, 40));

      expect(consumer.acknowledge).toHaveBeenCalledWith(mockMsg);

      const dlqMsg = sentMessages.find(
        (m) => m.topic === 'persistent://esma/uploads/dlq',
      );
      expect(dlqMsg).toBeDefined();
      expect(dlqMsg?.message.properties).toMatchObject({
        'x-original-topic': 'replication',
        'x-dlq-reason': 'unrecoverable-format',
        'x-dlq-error': 'Corrupt magic bytes',
        'x-correlation-id': 'corr-poison',
      });
    });

    it('routes malformed JSON directly to DLQ to avoid poison pill loops', async () => {
      await driver.initialize();

      await driver.subscribe(
        'replication',
        { consumerGroup: 'worker-malformed', concurrency: 1, maxAttempts: 3 },
        async () => ({ kind: 'ack' }),
      );

      const consumer = createdConsumers[0] as any;
      const mockMsg = createMockMessage({
        topic: topicMap.toPulsar('replication'),
        data: 'this-is-not-valid-json{{{',
        partitionKey: 'f-corrupt',
      });

      consumer.pushMessage(mockMsg);

      await new Promise((r) => setTimeout(r, 40));

      expect(consumer.acknowledge).toHaveBeenCalledWith(mockMsg);

      const dlqMsg = sentMessages.find(
        (m) => m.topic === 'persistent://esma/uploads/dlq',
      );
      expect(dlqMsg).toBeDefined();
      expect(dlqMsg?.message.properties).toMatchObject({
        'x-original-topic': 'replication',
        'x-dlq-reason': 'malformed-json',
      });
    });
  });
});
