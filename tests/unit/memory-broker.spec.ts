import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryBroker } from '../../src/events/memory-broker.js';
import { createEnvelope } from '../../src/events/envelope.js';
import { EVENT_TYPES } from '../../src/events/catalog.js';
import { PermanentError } from '../../src/core/errors/app-error.js';

describe('MemoryBroker Unit & Concurrency Tests (P4-03)', () => {
  let broker: MemoryBroker;

  beforeEach(async () => {
    broker = new MemoryBroker();
    await broker.initialize();
  });

  afterEach(async () => {
    if (await broker.healthCheck()) {
      await broker.disconnect();
    }
  });

  describe('Lifecycle & Environment Guards (ARCH §8.8)', () => {
    it('initializes and reports healthCheck = true', async () => {
      expect(await broker.healthCheck()).toBe(true);
    });

    it('rejects initialization when NODE_ENV=production without ALLOW_MEMORY_BROKER=true', async () => {
      const origNodeEnv = process.env.NODE_ENV;
      const origAllow = process.env.ALLOW_MEMORY_BROKER;

      try {
        process.env.NODE_ENV = 'production';
        delete process.env.ALLOW_MEMORY_BROKER;

        const prodBroker = new MemoryBroker();
        await expect(prodBroker.initialize()).rejects.toThrow(PermanentError);
        await expect(prodBroker.initialize()).rejects.toThrow(
          /cannot be used when NODE_ENV=production/,
        );

        // Allowed when ALLOW_MEMORY_BROKER=true
        process.env.ALLOW_MEMORY_BROKER = 'true';
        const allowedBroker = new MemoryBroker();
        await expect(allowedBroker.initialize()).resolves.toBeUndefined();
        await allowedBroker.disconnect();
      } finally {
        process.env.NODE_ENV = origNodeEnv;
        if (origAllow !== undefined) {
          process.env.ALLOW_MEMORY_BROKER = origAllow;
        } else {
          delete process.env.ALLOW_MEMORY_BROKER;
        }
      }
    });

    it('rejects publish or subscribe after disconnect', async () => {
      await broker.disconnect();

      const event = createEnvelope({
        eventType: EVENT_TYPES.FILE_PURGE,
        partitionKey: 'f-1',
        payload: { fileId: 'f-1' },
      });

      await expect(broker.publish('replication', 'f-1', event)).rejects.toThrow(
        PermanentError,
      );
      await expect(
        broker.subscribe(
          'replication',
          { consumerGroup: 'test-group', concurrency: 1, maxAttempts: 3 },
          async () => {
            await Promise.resolve();
            return { kind: 'ack' };
          },
        ),
      ).rejects.toThrow(PermanentError);
    });
  });

  describe('Publish & Subscribe Basic Semantics', () => {
    it('delivers published event to subscriber with delivery metadata and acks', async () => {
      const delivered: Array<{ event: unknown; meta: unknown }> = [];

      await broker.subscribe(
        'replication',
        { consumerGroup: 'rep-workers', concurrency: 2, maxAttempts: 3 },
        async (event, meta) => {
          await Promise.resolve();
          delivered.push({ event, meta });
          return { kind: 'ack' };
        },
      );

      const envelope = createEnvelope({
        eventType: EVENT_TYPES.FILE_REPLICATE,
        partitionKey: 'file-xyz',
        payload: { fileId: 'file-xyz', targetProvider: 'seaweedfs' },
        correlationId: 'corr-101',
      });

      await broker.publish('replication', 'file-xyz', envelope, {
        headers: { 'x-trace': 'trace-123' },
      });

      // Allow microtasks to execute
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(delivered).toHaveLength(1);
      const first = delivered[0];
      expect((first.event as typeof envelope).eventId).toBe(envelope.eventId);
      expect((first.event as typeof envelope).attempt).toBe(0);
      expect(first.meta).toMatchObject({
        topic: 'replication',
        partitionKey: 'file-xyz',
        attempt: 0,
        headers: { 'x-trace': 'trace-123' },
      });
    });

    it('subscription.close() stops further deliveries', async () => {
      let count = 0;
      const sub = await broker.subscribe(
        'audit',
        { consumerGroup: 'audit-group', concurrency: 1, maxAttempts: 3 },
        async () => {
          await Promise.resolve();
          count++;
          return { kind: 'ack' };
        },
      );

      const event1 = createEnvelope({
        eventType: EVENT_TYPES.FILE_DELETED,
        partitionKey: 'f-del-1',
        payload: { fileId: 'f-del-1' },
      });
      await broker.publish('audit', 'f-del-1', event1);
      await new Promise((r) => setTimeout(r, 20));
      expect(count).toBe(1);

      await sub.close();

      const event2 = createEnvelope({
        eventType: EVENT_TYPES.FILE_DELETED,
        partitionKey: 'f-del-2',
        payload: { fileId: 'f-del-2' },
      });
      await broker.publish('audit', 'f-del-2', event2);
      await new Promise((r) => setTimeout(r, 20));
      expect(count).toBe(1);
    });
  });

  describe('Consumer Groups & Competing Consumers', () => {
    it('fans out message to multiple distinct consumer groups', async () => {
      const group1Delivered: string[] = [];
      const group2Delivered: string[] = [];

      await broker.subscribe(
        'replication',
        { consumerGroup: 'group-one', concurrency: 1, maxAttempts: 3 },
        async (event) => {
          await Promise.resolve();
          group1Delivered.push(event.eventId);
          return { kind: 'ack' };
        },
      );

      await broker.subscribe(
        'replication',
        { consumerGroup: 'group-two', concurrency: 1, maxAttempts: 3 },
        async (event) => {
          await Promise.resolve();
          group2Delivered.push(event.eventId);
          return { kind: 'ack' };
        },
      );

      const envelope = createEnvelope({
        eventType: EVENT_TYPES.FILE_PURGE,
        partitionKey: 'f-group-test',
        payload: { fileId: 'f-group-test' },
      });

      await broker.publish('replication', 'f-group-test', envelope);
      await new Promise((r) => setTimeout(r, 30));

      expect(group1Delivered).toEqual([envelope.eventId]);
      expect(group2Delivered).toEqual([envelope.eventId]);
    });

    it('distributes messages between competing consumers in the same group without duplication', async () => {
      const worker1: string[] = [];
      const worker2: string[] = [];

      // Subscriber 1 in 'workers' group
      await broker.subscribe(
        'processing',
        { consumerGroup: 'workers', concurrency: 1, maxAttempts: 3 },
        async (event) => {
          await Promise.resolve();
          worker1.push(event.partitionKey);
          return { kind: 'ack' };
        },
      );

      // Subscriber 2 in 'workers' group
      await broker.subscribe(
        'processing',
        { consumerGroup: 'workers', concurrency: 1, maxAttempts: 3 },
        async (event) => {
          await Promise.resolve();
          worker2.push(event.partitionKey);
          return { kind: 'ack' };
        },
      );

      const keys = ['key-1', 'key-2', 'key-3', 'key-4', 'key-5', 'key-6'];
      for (const k of keys) {
        const ev = createEnvelope({
          eventType: EVENT_TYPES.FILE_SCAN,
          partitionKey: k,
          payload: { fileId: k },
        });
        await broker.publish('processing', k, ev);
      }

      await new Promise((r) => setTimeout(r, 60));

      const totalReceived = worker1.length + worker2.length;
      expect(totalReceived).toBe(6);
      // Both workers handled at least some items
      expect(worker1.length).toBeGreaterThan(0);
      expect(worker2.length).toBeGreaterThan(0);

      // No duplicates between worker1 and worker2
      const intersection = worker1.filter((k) => worker2.includes(k));
      expect(intersection).toHaveLength(0);
    });
  });

  describe('Per-Partition-Key Serial Delivery (ARCH §8.5, ADR-07)', () => {
    it('guarantees two messages with the same partition key never execute concurrently', async () => {
      let activeForSameKey = 0;
      let maxActiveForSameKey = 0;
      const executionOrder: string[] = [];

      await broker.subscribe(
        'replication',
        { consumerGroup: 'strict-order-group', concurrency: 4, maxAttempts: 3 },
        async (event) => {
          activeForSameKey++;
          maxActiveForSameKey = Math.max(maxActiveForSameKey, activeForSameKey);

          // Simulate I/O latency
          await new Promise((r) => setTimeout(r, 40));

          executionOrder.push(event.eventId);
          activeForSameKey--;
          return { kind: 'ack' };
        },
      );

      const ev1 = createEnvelope({
        eventType: EVENT_TYPES.FILE_REPLICATE,
        partitionKey: 'shared-file-key',
        payload: { fileId: 'shared-file-key', targetProvider: 'seaweedfs' },
      });
      const ev2 = createEnvelope({
        eventType: EVENT_TYPES.FILE_PURGE,
        partitionKey: 'shared-file-key',
        payload: { fileId: 'shared-file-key' },
      });

      // Publish both for the SAME partitionKey almost simultaneously
      await Promise.all([
        broker.publish('replication', 'shared-file-key', ev1),
        broker.publish('replication', 'shared-file-key', ev2),
      ]);

      await new Promise((r) => setTimeout(r, 350));

      expect(executionOrder).toEqual([ev1.eventId, ev2.eventId]);
      expect(maxActiveForSameKey).toBe(1);
    });

    it('allows messages with different partition keys to execute concurrently up to concurrency limit', async () => {
      let activeConcurrentAcrossKeys = 0;
      let maxConcurrentRecorded = 0;

      await broker.subscribe(
        'processing',
        { consumerGroup: 'parallel-group', concurrency: 3, maxAttempts: 3 },
        async () => {
          activeConcurrentAcrossKeys++;
          maxConcurrentRecorded = Math.max(
            maxConcurrentRecorded,
            activeConcurrentAcrossKeys,
          );

          await new Promise((r) => setTimeout(r, 50));

          activeConcurrentAcrossKeys--;
          return { kind: 'ack' };
        },
      );

      // Publish 3 messages with 3 DIFFERENT partition keys
      await Promise.all([
        broker.publish(
          'processing',
          'key-A',
          createEnvelope({
            eventType: EVENT_TYPES.FILE_SCAN,
            partitionKey: 'key-A',
            payload: { fileId: 'key-A' },
          }),
        ),
        broker.publish(
          'processing',
          'key-B',
          createEnvelope({
            eventType: EVENT_TYPES.FILE_SCAN,
            partitionKey: 'key-B',
            payload: { fileId: 'key-B' },
          }),
        ),
        broker.publish(
          'processing',
          'key-C',
          createEnvelope({
            eventType: EVENT_TYPES.FILE_SCAN,
            partitionKey: 'key-C',
            payload: { fileId: 'key-C' },
          }),
        ),
      ]);

      await new Promise((r) => setTimeout(r, 120));

      // With 3 different partition keys and concurrency 3, they should run concurrently
      expect(maxConcurrentRecorded).toBeGreaterThan(1);
    });
  });

  describe('Delayed Delivery & Retries', () => {
    it('honors deliverAfterMs on publish', async () => {
      let deliveredAt = 0;
      const start = Date.now();

      await broker.subscribe(
        'audit',
        { consumerGroup: 'delayed-sub', concurrency: 1, maxAttempts: 3 },
        async () => {
          await Promise.resolve();
          deliveredAt = Date.now();
          return { kind: 'ack' };
        },
      );

      const ev = createEnvelope({
        eventType: EVENT_TYPES.FILE_UPLOADED,
        partitionKey: 'f-delayed',
        payload: {
          fileId: 'f-delayed',
          size: 500,
          mimetype: 'image/png',
          primaryProvider: 'local',
        },
      });

      await broker.publish('audit', 'f-delayed', ev, { deliverAfterMs: 60 });

      // Before delay elapsed:
      await new Promise((r) => setTimeout(r, 20));
      expect(deliveredAt).toBe(0);

      // After delay elapsed:
      await new Promise((r) => setTimeout(r, 70));
      expect(deliveredAt).toBeGreaterThan(0);
      expect(deliveredAt - start).toBeGreaterThanOrEqual(55);
    });

    it('retries with delay and increments attempt count', async () => {
      const attemptsReceived: number[] = [];

      await broker.subscribe(
        'replication',
        { consumerGroup: 'retry-sub', concurrency: 1, maxAttempts: 3 },
        async (event) => {
          await Promise.resolve();
          attemptsReceived.push(event.attempt);
          if (event.attempt < 2) {
            return {
              kind: 'retry',
              delayMs: 30,
              reason: 'temporary disk lock',
            };
          }
          return { kind: 'ack' };
        },
      );

      const ev = createEnvelope({
        eventType: EVENT_TYPES.FILE_REPLICATE,
        partitionKey: 'f-retry',
        payload: { fileId: 'f-retry', targetProvider: 'seaweedfs' },
      });

      await broker.publish('replication', 'f-retry', ev);
      await new Promise((r) => setTimeout(r, 350));

      expect(attemptsReceived).toEqual([0, 1, 2]);
    });
  });

  describe('Dead-Letter Queue (DLQ) Routing', () => {
    it('routes to DLQ when maxAttempts is exceeded with DLQ headers', async () => {
      await broker.subscribe(
        'replication',
        { consumerGroup: 'failing-sub', concurrency: 1, maxAttempts: 2 },
        async () => {
          await Promise.resolve();
          return { kind: 'retry', delayMs: 10, reason: 'continuous failure' };
        },
      );

      const ev = createEnvelope({
        eventType: EVENT_TYPES.FILE_REPLICATE,
        partitionKey: 'f-exhausted',
        payload: { fileId: 'f-exhausted', targetProvider: 'seaweedfs' },
      });

      await broker.publish('replication', 'f-exhausted', ev);
      await new Promise((r) => setTimeout(r, 80));

      const dlqRecords = broker.getDlqRecords();
      expect(dlqRecords).toHaveLength(1);
      const record = dlqRecords[0];
      expect(record.event.eventId).toBe(ev.eventId);
      expect(record.event.attempt).toBe(2);
      expect(record.headers).toMatchObject({
        'x-original-topic': 'replication',
        'x-attempts': '2',
      });
      expect(record.headers['x-error']).toContain('Exceeded max attempts (2)');
      expect(record.headers['x-first-failed-at']).toBeDefined();
    });

    it('routes immediately to DLQ when handler returns kind="dead-letter"', async () => {
      await broker.subscribe(
        'processing',
        { consumerGroup: 'dlq-direct-sub', concurrency: 1, maxAttempts: 5 },
        async () => {
          await Promise.resolve();
          return {
            kind: 'dead-letter',
            reason: 'Unrecoverable corrupt payload',
          };
        },
      );

      const ev = createEnvelope({
        eventType: EVENT_TYPES.FILE_SCAN,
        partitionKey: 'f-corrupt',
        payload: { fileId: 'f-corrupt' },
      });

      await broker.publish('processing', 'f-corrupt', ev);
      await new Promise((r) => setTimeout(r, 30));

      const dlqRecords = broker.getDlqRecords();
      expect(dlqRecords).toHaveLength(1);
      expect(dlqRecords[0].reason).toBe('Unrecoverable corrupt payload');
      expect(dlqRecords[0].headers['x-original-topic']).toBe('processing');
    });

    it('routes to DLQ immediately when handler throws PermanentError', async () => {
      await broker.subscribe(
        'replication',
        { consumerGroup: 'permanent-err-sub', concurrency: 1, maxAttempts: 5 },
        async () => {
          await Promise.resolve();
          throw new PermanentError('Schema version 99 not supported');
        },
      );

      const ev = createEnvelope({
        eventType: EVENT_TYPES.FILE_PURGE,
        partitionKey: 'f-perm',
        payload: { fileId: 'f-perm' },
      });

      await broker.publish('replication', 'f-perm', ev);
      await new Promise((r) => setTimeout(r, 30));

      const dlqRecords = broker.getDlqRecords();
      expect(dlqRecords).toHaveLength(1);
      expect(dlqRecords[0].reason).toContain('Schema version 99 not supported');
    });
  });

  describe('Graceful Drain on Disconnect', () => {
    it('waits for in-flight handlers to complete before disconnect resolves', async () => {
      let handlerFinished = false;

      await broker.subscribe(
        'replication',
        { consumerGroup: 'drain-group', concurrency: 1, maxAttempts: 3 },
        async () => {
          await new Promise((r) => setTimeout(r, 60));
          handlerFinished = true;
          return { kind: 'ack' };
        },
      );

      const ev = createEnvelope({
        eventType: EVENT_TYPES.FILE_PURGE,
        partitionKey: 'f-drain',
        payload: { fileId: 'f-drain' },
      });

      await broker.publish('replication', 'f-drain', ev);

      // Allow handler to start
      await new Promise((r) => setTimeout(r, 10));
      expect(handlerFinished).toBe(false);

      // Disconnect must await the running handler
      await broker.disconnect();

      expect(handlerFinished).toBe(true);
      expect(await broker.healthCheck()).toBe(false);
    });
  });
});
