/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  KafkaBrokerDriver,
  type KafkaBrokerConfig,
} from '../../src/events/kafka-broker.driver.js';
import { TopicMap } from '../../src/events/topic-map.js';
import { createEnvelope } from '../../src/events/envelope.js';
import { EVENT_TYPES } from '../../src/events/catalog.js';
import type { MessageHandler } from '../../src/events/broker.interface.js';

const { mockProducer, mockConsumer, mockAdmin, MockKafka } = vi.hoisted(() => {
  const mockProducer = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(),
  };
  const mockConsumer = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    subscribe: vi.fn(),
    run: vi.fn(),
    stop: vi.fn(),
    commitOffsets: vi.fn(),
  };
  const mockAdmin = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    listTopics: vi.fn(),
    createTopics: vi.fn(),
  };
  const MockKafka = vi.fn().mockImplementation(function (
    this: any,
    ...args: any[]
  ) {
    return {
      producer: vi.fn().mockReturnValue(mockProducer),
      consumer: vi.fn().mockReturnValue(mockConsumer),
      admin: vi.fn().mockReturnValue(mockAdmin),
    };
  });

  return { mockProducer, mockConsumer, mockAdmin, MockKafka };
});

vi.mock('@confluentinc/kafka-javascript', () => ({
  KafkaJS: {
    Kafka: MockKafka,
  },
}));

describe('KafkaBrokerDriver [P5-02]', () => {
  let driver: KafkaBrokerDriver;
  let topicMap: TopicMap;
  let config: KafkaBrokerConfig;

  beforeEach(() => {
    vi.clearAllMocks();

    mockProducer.connect.mockResolvedValue(undefined);
    mockProducer.disconnect.mockResolvedValue(undefined);
    mockProducer.send.mockResolvedValue(undefined);

    mockConsumer.connect.mockResolvedValue(undefined);
    mockConsumer.disconnect.mockResolvedValue(undefined);
    mockConsumer.subscribe.mockResolvedValue(undefined);
    mockConsumer.run.mockResolvedValue(undefined);
    mockConsumer.stop.mockResolvedValue(undefined);
    mockConsumer.commitOffsets.mockResolvedValue(undefined);

    mockAdmin.connect.mockResolvedValue(undefined);
    mockAdmin.disconnect.mockResolvedValue(undefined);
    mockAdmin.listTopics.mockResolvedValue([]);
    mockAdmin.createTopics.mockResolvedValue(true);

    topicMap = new TopicMap({ kafkaPrefix: 'test.files' });
    config = {
      brokers: 'localhost:9092,localhost:9093',
      clientId: 'test-esma-service',
      topicMap,
      topicPrefix: 'test.files',
      topicPartitions: 3,
      topicReplicationFactor: 1,
      ssl: false,
      ensureTopics: false,
    };

    driver = new KafkaBrokerDriver(config);
  });

  afterEach(async () => {
    await driver.disconnect();
  });

  describe('Configuration & Initialization', () => {
    it('has driver name "kafka"', () => {
      expect(driver.name).toBe('kafka');
    });

    it('initializes Kafka with SASL options when provided', async () => {
      const saslConfig: KafkaBrokerConfig = {
        ...config,
        ssl: true,
        saslMechanism: 'scram-sha-256',
        saslUsername: 'test-user',
        saslPassword: 'secret-password',
      };
      const saslDriver = new KafkaBrokerDriver(saslConfig);
      await saslDriver.initialize();
      await saslDriver.disconnect();

      expect(MockKafka).toHaveBeenCalledWith({
        kafkaJS: {
          brokers: ['localhost:9092', 'localhost:9093'],
          clientId: 'test-esma-service',
          ssl: true,
          sasl: {
            mechanism: 'scram-sha-256',
            username: 'test-user',
            password: 'secret-password',
          },
        },
      });
    });

    it('initializes producer and admin on initialize()', async () => {
      await driver.initialize();

      expect(mockProducer.connect).toHaveBeenCalledOnce();
      expect(mockAdmin.connect).toHaveBeenCalledOnce();
    });

    it('creates topics when ensureTopics is true and topics do not exist', async () => {
      mockAdmin.listTopics.mockResolvedValue(['test.files.audit']);

      const ensureDriver = new KafkaBrokerDriver({
        ...config,
        ensureTopics: true,
      });

      await ensureDriver.initialize();

      expect(mockAdmin.listTopics).toHaveBeenCalled();
      expect(mockAdmin.createTopics).toHaveBeenCalledOnce();
      const callArgs = mockAdmin.createTopics.mock.calls[0][0];
      expect(callArgs.topics.length).toBeGreaterThan(0);
      // Ensure 'test.files.audit' was not in created list since it already existed
      const createdNames = callArgs.topics.map((t: any) => t.topic);
      expect(createdNames).not.toContain('test.files.audit');
      expect(createdNames).toContain('test.files.replication');
      expect(createdNames).toContain('test.files.replication.retry.10s');
    });

    it('does not create topics when ensureTopics is true and all topics exist', async () => {
      mockAdmin.listTopics.mockResolvedValue([
        'test.files.replication',
        'test.files.processing',
        'test.files.audit',
        'test.files.dlq',
        'test.files.replication.retry.10s',
        'test.files.replication.retry.1m',
        'test.files.replication.retry.10m',
        'test.files.processing.retry.10s',
        'test.files.processing.retry.1m',
        'test.files.processing.retry.10m',
      ]);

      const ensureDriver = new KafkaBrokerDriver({
        ...config,
        ensureTopics: true,
      });

      await ensureDriver.initialize();

      expect(mockAdmin.listTopics).toHaveBeenCalled();
      expect(mockAdmin.createTopics).not.toHaveBeenCalled();
    });
  });

  describe('HealthCheck & Lifecycle', () => {
    it('returns false before initialization', async () => {
      expect(await driver.healthCheck()).toBe(false);
    });

    it('returns true after initialization when listTopics succeeds', async () => {
      await driver.initialize();
      expect(await driver.healthCheck()).toBe(true);
      expect(mockAdmin.listTopics).toHaveBeenCalledWith({ timeout: 5000 });
    });

    it('returns false if listTopics throws during healthCheck', async () => {
      await driver.initialize();
      mockAdmin.listTopics.mockRejectedValueOnce(
        new Error('Broker unreachable'),
      );
      expect(await driver.healthCheck()).toBe(false);
    });

    it('disconnects producer, admin, and active consumers', async () => {
      await driver.initialize();

      await driver.subscribe(
        'replication',
        { consumerGroup: 'test-grp', concurrency: 1, maxAttempts: 3 },
        async () => ({ kind: 'ack' }),
      );

      await driver.disconnect();

      expect(mockConsumer.stop).toHaveBeenCalled();
      expect(mockConsumer.disconnect).toHaveBeenCalled();
      expect(mockProducer.disconnect).toHaveBeenCalled();
      expect(mockAdmin.disconnect).toHaveBeenCalled();
      expect(await driver.healthCheck()).toBe(false);
    });
  });

  describe('Publish', () => {
    it('throws error if publish is called before initialize', async () => {
      const envelope = createEnvelope({
        eventType: EVENT_TYPES.FILE_PURGE,
        partitionKey: 'f-1',
        payload: { fileId: 'f-1' },
      });

      await expect(
        driver.publish('replication', 'f-1', envelope),
      ).rejects.toThrow(/producer not initialized/);
    });

    it('publishes event to mapped physical topic with envelope headers', async () => {
      await driver.initialize();

      const envelope = createEnvelope({
        eventType: EVENT_TYPES.FILE_REPLICATE,
        partitionKey: 'f-100',
        payload: { fileId: 'f-100', targetProvider: 'seaweedfs' },
        correlationId: 'corr-xyz',
        causationId: 'caus-abc',
      });

      await driver.publish('replication', 'f-100', envelope, {
        headers: { 'custom-header': 'custom-value' },
      });

      expect(mockProducer.send).toHaveBeenCalledOnce();
      const sendArgs = mockProducer.send.mock.calls[0][0];
      expect(sendArgs.topic).toBe('test.files.replication');
      expect(sendArgs.messages).toHaveLength(1);

      const msg = sendArgs.messages[0];
      expect(msg.key).toBe('f-100');
      expect(JSON.parse(msg.value)).toEqual(envelope);
      expect(msg.headers).toMatchObject({
        'x-correlation-id': 'corr-xyz',
        'x-causation-id': 'caus-abc',
        'x-event-type': EVENT_TYPES.FILE_REPLICATE,
        'x-schema-version': '1',
        'custom-header': 'custom-value',
      });
      expect(msg.headers['x-not-before']).toBeUndefined();
    });

    it('sets x-not-before header when deliverAfterMs is provided', async () => {
      await driver.initialize();

      const envelope = createEnvelope({
        eventType: EVENT_TYPES.FILE_PURGE,
        partitionKey: 'f-200',
        payload: { fileId: 'f-200' },
      });

      const before = Date.now();
      await driver.publish('replication', 'f-200', envelope, {
        deliverAfterMs: 15_000,
      });

      const sendArgs = mockProducer.send.mock.calls[0][0];
      const notBefore = parseInt(
        sendArgs.messages[0].headers['x-not-before'],
        10,
      );
      expect(notBefore).toBeGreaterThanOrEqual(before + 15_000);
    });
  });

  describe('Subscribe & Outcome Processing', () => {
    let capturedEachMessage: (payload: {
      topic: string;
      partition: number;
      message: any;
      pause: () => () => void;
    }) => Promise<void>;

    beforeEach(async () => {
      await driver.initialize();
      mockConsumer.run.mockImplementation(async (opts: any) => {
        capturedEachMessage = opts.eachMessage;
      });
    });

    it('subscribes with correct groupId and autoCommit false', async () => {
      const handler: MessageHandler<unknown> = vi
        .fn()
        .mockResolvedValue({ kind: 'ack' });

      const sub = await driver.subscribe(
        'replication',
        { consumerGroup: 'rep-workers', concurrency: 4, maxAttempts: 3 },
        handler,
      );

      expect(mockConsumer.connect).toHaveBeenCalled();
      expect(mockConsumer.subscribe).toHaveBeenCalledWith({
        topics: ['test.files.replication'],
      });
      expect(mockConsumer.run).toHaveBeenCalledWith(
        expect.objectContaining({
          partitionsConsumedConcurrently: 4,
          eachMessage: expect.any(Function),
        }),
      );

      await sub.close();
      expect(mockConsumer.stop).toHaveBeenCalled();
      expect(mockConsumer.disconnect).toHaveBeenCalled();
    });

    it('handles message, executes handler, and commits offset on ack', async () => {
      const envelope = createEnvelope({
        eventType: EVENT_TYPES.FILE_REPLICATE,
        partitionKey: 'f-1',
        payload: { fileId: 'f-1', targetProvider: 'seaweedfs' },
      });

      const handler = vi.fn().mockResolvedValue({ kind: 'ack' });

      await driver.subscribe(
        'replication',
        { consumerGroup: 'rep-workers', concurrency: 1, maxAttempts: 3 },
        handler,
      );

      const fakeMessage = {
        key: Buffer.from('f-1'),
        value: Buffer.from(JSON.stringify(envelope)),
        offset: '42',
        timestamp: '1690000000000',
        headers: { 'x-correlation-id': Buffer.from('corr-1') },
      };

      await capturedEachMessage({
        topic: 'test.files.replication',
        partition: 0,
        message: fakeMessage,
        pause: vi.fn(),
      });

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(
        envelope,
        expect.objectContaining({
          topic: 'replication',
          partitionKey: 'f-1',
          attempt: 0,
          headers: expect.objectContaining({ 'x-correlation-id': 'corr-1' }),
        }),
      );

      expect(mockConsumer.commitOffsets).toHaveBeenCalledWith([
        {
          topic: 'test.files.replication',
          partition: 0,
          offset: '43', // 42 + 1
        },
      ]);
    });

    it('routes to 10s retry tier topic when delay <= 30s', async () => {
      const envelope = createEnvelope({
        eventType: EVENT_TYPES.FILE_REPLICATE,
        partitionKey: 'f-1',
        payload: { fileId: 'f-1', targetProvider: 'seaweedfs' },
      });

      const handler = vi.fn().mockResolvedValue({
        kind: 'retry',
        reason: 'Temporary network failure',
        delayMs: 10_000,
      });

      await driver.subscribe(
        'replication',
        { consumerGroup: 'rep-workers', concurrency: 1, maxAttempts: 3 },
        handler,
      );

      const fakeMessage = {
        key: Buffer.from('f-1'),
        value: Buffer.from(JSON.stringify(envelope)),
        offset: '10',
        headers: {},
      };

      await capturedEachMessage({
        topic: 'test.files.replication',
        partition: 1,
        message: fakeMessage,
        pause: vi.fn(),
      });

      // Original offset committed
      expect(mockConsumer.commitOffsets).toHaveBeenCalledWith([
        { topic: 'test.files.replication', partition: 1, offset: '11' },
      ]);

      // Published to 10s retry topic
      expect(mockProducer.send).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: 'test.files.replication.retry.10s',
          messages: [
            expect.objectContaining({
              key: 'f-1',
              headers: expect.objectContaining({
                'x-original-topic': 'replication',
                'x-attempts': '1',
              }),
            }),
          ],
        }),
      );
    });

    it('routes to 1m retry tier topic when delay <= 300s', async () => {
      const envelope = createEnvelope({
        eventType: EVENT_TYPES.FILE_REPLICATE,
        partitionKey: 'f-1',
        payload: { fileId: 'f-1', targetProvider: 'seaweedfs' },
      });

      const handler = vi.fn().mockResolvedValue({
        kind: 'retry',
        reason: 'Rate limit hit',
        delayMs: 60_000,
      });

      await driver.subscribe(
        'replication',
        { consumerGroup: 'rep-workers', concurrency: 1, maxAttempts: 3 },
        handler,
      );

      await capturedEachMessage({
        topic: 'test.files.replication',
        partition: 0,
        message: {
          key: Buffer.from('f-1'),
          value: Buffer.from(JSON.stringify(envelope)),
          offset: '5',
          headers: {},
        },
        pause: vi.fn(),
      });

      expect(mockProducer.send).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: 'test.files.replication.retry.1m',
        }),
      );
    });

    it('routes to 10m retry tier topic when delay > 300s', async () => {
      const envelope = createEnvelope({
        eventType: EVENT_TYPES.FILE_REPLICATE,
        partitionKey: 'f-1',
        payload: { fileId: 'f-1', targetProvider: 'seaweedfs' },
      });

      const handler = vi.fn().mockResolvedValue({
        kind: 'retry',
        reason: 'Extended backoff',
        delayMs: 600_000,
      });

      await driver.subscribe(
        'replication',
        { consumerGroup: 'rep-workers', concurrency: 1, maxAttempts: 3 },
        handler,
      );

      await capturedEachMessage({
        topic: 'test.files.replication',
        partition: 0,
        message: {
          key: Buffer.from('f-1'),
          value: Buffer.from(JSON.stringify(envelope)),
          offset: '5',
          headers: {},
        },
        pause: vi.fn(),
      });

      expect(mockProducer.send).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: 'test.files.replication.retry.10m',
        }),
      );
    });

    it('routes to DLQ when maxAttempts is reached', async () => {
      const envelope = {
        ...createEnvelope({
          eventType: EVENT_TYPES.FILE_REPLICATE,
          partitionKey: 'f-1',
          payload: { fileId: 'f-1', targetProvider: 'seaweedfs' },
        }),
        attempt: 2, // Next attempt will be 3, which equals maxAttempts: 3
      };

      const handler = vi.fn().mockResolvedValue({
        kind: 'retry',
        reason: 'Downstream still down',
      });

      await driver.subscribe(
        'replication',
        { consumerGroup: 'rep-workers', concurrency: 1, maxAttempts: 3 },
        handler,
      );

      await capturedEachMessage({
        topic: 'test.files.replication',
        partition: 0,
        message: {
          key: Buffer.from('f-1'),
          value: Buffer.from(JSON.stringify(envelope)),
          offset: '12',
          headers: { 'x-first-failed-at': Buffer.from('2026-10-01T00:00:00Z') },
        },
        pause: vi.fn(),
      });

      expect(mockProducer.send).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: 'test.files.dlq',
          messages: [
            expect.objectContaining({
              headers: expect.objectContaining({
                'x-original-topic': 'replication',
                'x-attempts': '3',
                'x-error': expect.stringContaining('Exceeded max attempts (3)'),
                'x-first-failed-at': '2026-10-01T00:00:00Z',
              }),
            }),
          ],
        }),
      );

      expect(mockConsumer.commitOffsets).toHaveBeenCalledWith([
        { topic: 'test.files.replication', partition: 0, offset: '13' },
      ]);
    });

    it('routes to DLQ immediately when handler returns dead-letter', async () => {
      const envelope = createEnvelope({
        eventType: EVENT_TYPES.FILE_REPLICATE,
        partitionKey: 'f-1',
        payload: { fileId: 'f-1', targetProvider: 'seaweedfs' },
      });

      const handler = vi.fn().mockResolvedValue({
        kind: 'dead-letter',
        reason: 'Corrupted payload schema',
      });

      await driver.subscribe(
        'replication',
        { consumerGroup: 'rep-workers', concurrency: 1, maxAttempts: 3 },
        handler,
      );

      await capturedEachMessage({
        topic: 'test.files.replication',
        partition: 0,
        message: {
          key: Buffer.from('f-1'),
          value: Buffer.from(JSON.stringify(envelope)),
          offset: '20',
          headers: {},
        },
        pause: vi.fn(),
      });

      expect(mockProducer.send).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: 'test.files.dlq',
          messages: [
            expect.objectContaining({
              headers: expect.objectContaining({
                'x-original-topic': 'replication',
                'x-error': 'Corrupted payload schema',
              }),
            }),
          ],
        }),
      );

      expect(mockConsumer.commitOffsets).toHaveBeenCalledWith([
        { topic: 'test.files.replication', partition: 0, offset: '21' },
      ]);
    });

    it('treats uncaught exception from handler as retry outcome', async () => {
      const envelope = createEnvelope({
        eventType: EVENT_TYPES.FILE_PURGE,
        partitionKey: 'f-9',
        payload: { fileId: 'f-9' },
      });

      const handler = vi.fn().mockRejectedValue(new Error('Unexpected crash'));

      await driver.subscribe(
        'replication',
        { consumerGroup: 'rep-workers', concurrency: 1, maxAttempts: 3 },
        handler,
      );

      await capturedEachMessage({
        topic: 'test.files.replication',
        partition: 0,
        message: {
          key: Buffer.from('f-9'),
          value: Buffer.from(JSON.stringify(envelope)),
          offset: '30',
          headers: {},
        },
        pause: vi.fn(),
      });

      // Retried to 10s tier
      expect(mockProducer.send).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: 'test.files.replication.retry.10s',
        }),
      );
      expect(mockConsumer.commitOffsets).toHaveBeenCalledWith([
        { topic: 'test.files.replication', partition: 0, offset: '31' },
      ]);
    });

    it('routes unparseable messages to DLQ with raw bytes and commits offset', async () => {
      const handler = vi.fn();

      await driver.subscribe(
        'replication',
        { consumerGroup: 'rep-workers', concurrency: 1, maxAttempts: 3 },
        handler,
      );

      const invalidJson = Buffer.from('not valid json {[[[');
      await capturedEachMessage({
        topic: 'test.files.replication',
        partition: 0,
        message: {
          key: Buffer.from('bad-key'),
          value: invalidJson,
          offset: '99',
          headers: {},
        },
        pause: vi.fn(),
      });

      expect(handler).not.toHaveBeenCalled();
      expect(mockProducer.send).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: 'test.files.dlq',
          messages: [
            expect.objectContaining({
              key: 'bad-key',
              value: invalidJson,
              headers: expect.objectContaining({
                'x-original-topic': 'replication',
                'x-error': 'Unparseable message body',
              }),
            }),
          ],
        }),
      );

      expect(mockConsumer.commitOffsets).toHaveBeenCalledWith([
        { topic: 'test.files.replication', partition: 0, offset: '100' },
      ]);
    });

    it('pauses partition when x-not-before is in the future', async () => {
      const resumeFn = vi.fn();
      const pauseFn = vi.fn().mockReturnValue(resumeFn);

      const handler = vi.fn();

      await driver.subscribe(
        'replication',
        { consumerGroup: 'rep-workers', concurrency: 1, maxAttempts: 3 },
        handler,
      );

      // x-not-before is 20ms in the future
      const futureNotBefore = Date.now() + 20;

      await capturedEachMessage({
        topic: 'test.files.replication',
        partition: 2,
        message: {
          key: Buffer.from('f-1'),
          value: Buffer.from('{}'),
          offset: '50',
          headers: {
            'x-not-before': Buffer.from(String(futureNotBefore)),
          },
        },
        pause: pauseFn,
      });

      expect(pauseFn).toHaveBeenCalledOnce();
      expect(resumeFn).toHaveBeenCalledOnce();
      expect(handler).not.toHaveBeenCalled();
      // Original offset was NOT committed because message wasn't processed yet
      expect(mockConsumer.commitOffsets).not.toHaveBeenCalled();
    });
  });
});
