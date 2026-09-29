/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { defineConsumer } from '../../src/events/consumer.js';
import { withIdempotency } from '../../src/events/idempotency.js';
import { MemoryBroker } from '../../src/events/memory-broker.js';
import { EVENT_TYPES } from '../../src/events/catalog.js';
import { createEnvelope } from '../../src/events/envelope.js';
import {
  PermanentError,
  RetryableError,
} from '../../src/core/errors/app-error.js';
import type { ProcessedEventsRepository } from '../../src/db/repositories/processed-events.repository.js';
import type { ConsumerRunnable } from '../../src/events/consumer.interface.js';

describe('Consumer Framework (P4-05)', () => {
  let broker: MemoryBroker;
  let consumer: ConsumerRunnable | null = null;
  let simulatedTime = 1_000_000;
  const timerCallbacks = new Map<number, { cb: () => void; due: number }>();
  let nextTimerId = 1;

  const testClock = {
    now: () => simulatedTime,
    setTimeout: (cb: () => void, ms: number): unknown => {
      const id = nextTimerId++;
      timerCallbacks.set(id, { cb, due: simulatedTime + ms });
      return id;
    },
    clearTimeout: (handle: unknown): void => {
      if (typeof handle === 'number') {
        timerCallbacks.delete(handle);
      }
    },
  };

  const flushTimers = async () => {
    let fired = true;
    while (fired) {
      fired = false;
      const dueList = Array.from(timerCallbacks.entries())
        .filter(([, t]) => t.due <= simulatedTime)
        .sort((a, b) => a[1].due - b[1].due);

      for (const [id, t] of dueList) {
        timerCallbacks.delete(id);
        t.cb();
        // Give multiple ticks for async handler execution to complete
        for (let i = 0; i < 10; i++) {
          await new Promise((r) => setImmediate(r));
        }
        fired = true;
      }
    }
    // Final settling ticks
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setImmediate(r));
    }
  };

  const advanceTimeBy = async (ms: number) => {
    simulatedTime += ms;
    await flushTimers();
  };

  beforeEach(async () => {
    simulatedTime = 1_000_000;
    timerCallbacks.clear();
    broker = new MemoryBroker(testClock);
    await broker.initialize();
  });

  afterEach(async () => {
    if (consumer) {
      await consumer.stop();
      consumer = null;
    }
    await broker.disconnect();
  });

  it('a handler failing 3 times then succeeding is invoked 4 times with increasing delays [AC 1]', async () => {
    const invocations: Array<{ attempt: number; time: number }> = [];
    const fixedRng = () => 0.5; // deterministic 0-jitter

    consumer = defineConsumer({
      name: 'retry-test-consumer',
      topic: 'replication',
      group: 'test-group',
      broker,
      maxAttempts: 5,
      rng: fixedRng,
      handler: async (_event, ctx) => {
        invocations.push({ attempt: ctx.attempt, time: simulatedTime });
        if (invocations.length < 4) {
          throw new RetryableError(`Failure on attempt ${ctx.attempt}`);
        }
      },
    });

    await consumer.start();

    const envelope = createEnvelope({
      eventType: EVENT_TYPES.FILE_REPLICATE,
      partitionKey: 'file-retry-001',
      payload: { fileId: 'file-retry-001', targetProvider: 'seaweedfs' },
    });

    await broker.publish('replication', 'file-retry-001', envelope);
    await flushTimers();

    // Initial delivery should happen immediately
    expect(invocations).toHaveLength(1);
    expect(invocations[0].attempt).toBe(1);

    // Backoff attempt 1 -> nominal 10,000 ms. Advance 9,000 ms -> should NOT run yet
    await advanceTimeBy(9_000);
    expect(invocations).toHaveLength(1);

    // Advance 2,000 ms (total 11,000 ms) -> attempt 2 runs
    await advanceTimeBy(2_000);
    expect(invocations).toHaveLength(2);
    expect(invocations[1].attempt).toBe(2);

    // Backoff attempt 2 -> nominal 30,000 ms. Advance 25,000 ms -> should NOT run yet
    await advanceTimeBy(25_000);
    expect(invocations).toHaveLength(2);

    // Advance 6,000 ms -> attempt 3 runs
    await advanceTimeBy(6_000);
    expect(invocations).toHaveLength(3);
    expect(invocations[2].attempt).toBe(3);

    // Backoff attempt 3 -> nominal 90,000 ms. Advance 91,000 ms -> attempt 4 runs and succeeds
    await advanceTimeBy(91_000);
    expect(invocations).toHaveLength(4);
    expect(invocations[3].attempt).toBe(4);

    expect(consumer.metrics.processed).toBe(1);
    expect(consumer.metrics.retried).toBe(3);
    expect(consumer.metrics.deadLettered).toBe(0);
  });

  it('permanent error -> routes to DLQ with all headers and no retries [AC 2]', async () => {
    let dlqReceived: {
      event: unknown;
      headers?: Record<string, string>;
    } | null = null;

    // Subscribe to DLQ to capture dead-lettered message
    await broker.subscribe(
      'dlq',
      { consumerGroup: 'dlq-monitor', concurrency: 1, maxAttempts: 1 },
      async (event, meta) => {
        dlqReceived = { event, headers: meta.headers };
        return { kind: 'ack' };
      },
    );

    consumer = defineConsumer({
      name: 'dlq-test-consumer',
      topic: 'audit',
      group: 'audit-group',
      broker,
      maxAttempts: 5,
      handler: async () => {
        throw new PermanentError('Unrecoverable database corruption');
      },
    });

    await consumer.start();

    const envelope = createEnvelope({
      eventType: EVENT_TYPES.FILE_UPLOADED,
      partitionKey: 'file-perm-001',
      payload: {
        fileId: 'file-perm-001',
        size: 512,
        mimetype: 'text/plain',
        primaryProvider: 'local',
      },
    });

    await broker.publish('audit', 'file-perm-001', envelope);
    await flushTimers();

    // Verify consumer metrics
    expect(consumer.metrics.processed).toBe(0);
    expect(consumer.metrics.retried).toBe(0);
    expect(consumer.metrics.deadLettered).toBe(1);

    // Verify DLQ message and required headers
    expect(dlqReceived).not.toBeNull();
    const headers = dlqReceived!.headers!;
    expect(headers['x-original-topic']).toBe('audit');
    expect(headers['x-event-type']).toBe(EVENT_TYPES.FILE_UPLOADED);
    expect(headers['x-error']).toBe('Unrecoverable database corruption');
    expect(headers['x-attempts']).toBe('1');
    expect(headers['x-first-failed-at']).toBeDefined();
  });

  it('duplicate delivery of the same event id is a no-op with withIdempotency [AC 3]', async () => {
    const executedEvents: string[] = [];
    const processedSet = new Set<string>();

    const mockRepo = {
      tryMark: vi
        .fn()
        .mockImplementation((_consumer: string, eventId: string) => {
          if (processedSet.has(eventId)) {
            return Promise.resolve(false);
          }
          processedSet.add(eventId);
          return Promise.resolve(true);
        }),
    } as unknown as ProcessedEventsRepository;

    const baseHandler = vi.fn().mockImplementation((event) => {
      executedEvents.push(event.eventId);
      return Promise.resolve({ kind: 'ack' });
    });

    const idempotentHandler = withIdempotency(
      'test-idempotent-worker',
      mockRepo,
      baseHandler,
    );

    consumer = defineConsumer({
      name: 'idempotent-consumer',
      topic: 'replication',
      group: 'idempotent-group',
      broker,
      handler: idempotentHandler,
    });

    await consumer.start();

    const envelope = createEnvelope({
      eventType: EVENT_TYPES.FILE_REPLICATE,
      partitionKey: 'file-idem-001',
      payload: { fileId: 'file-idem-001', targetProvider: 'seaweedfs' },
    });

    // 1st delivery
    await broker.publish('replication', 'file-idem-001', envelope);
    await flushTimers();
    expect(executedEvents).toEqual([envelope.eventId]);
    expect(baseHandler).toHaveBeenCalledTimes(1);
    expect(consumer.metrics.processed).toBe(1);

    // 2nd delivery of identical envelope (duplicate delivery)
    await broker.publish('replication', 'file-idem-001', envelope);
    await flushTimers();
    expect(executedEvents).toEqual([envelope.eventId]); // Still only 1 execution
    expect(baseHandler).toHaveBeenCalledTimes(1); // Not invoked second time
    expect(consumer.metrics.processed).toBe(2); // Both deliveries acknowledged
  });

  it('shutdown with 5 in-flight messages completes them and loses none [AC 4]', async () => {
    let completedCount = 0;
    const releaseFns: Array<() => void> = [];

    consumer = defineConsumer({
      name: 'shutdown-consumer',
      topic: 'processing',
      group: 'shutdown-group',
      concurrency: 5,
      shutdownTimeoutMs: 5_000,
      broker,
      handler: async () => {
        await new Promise<void>((resolve) => {
          releaseFns.push(resolve);
        });
        completedCount++;
      },
    });

    await consumer.start();

    // Publish 5 messages to 5 different partition keys so they run concurrently
    for (let i = 1; i <= 5; i++) {
      const envelope = createEnvelope({
        eventType: EVENT_TYPES.FILE_PURGE,
        partitionKey: `file-purge-00${i}`,
        payload: { fileId: `file-purge-00${i}` },
      });
      await broker.publish('processing', `file-purge-00${i}`, envelope);
    }

    await flushTimers();

    // All 5 messages are now in flight
    expect(releaseFns).toHaveLength(5);
    expect(completedCount).toBe(0);

    // Trigger stop() concurrently while handlers are in-flight
    const stopPromise = consumer.stop();

    // Release all 5 in-flight handlers
    for (const release of releaseFns) {
      release();
    }

    // Await graceful stop
    await stopPromise;

    // Verify all 5 completed cleanly
    expect(completedCount).toBe(5);
    expect(consumer.metrics.processed).toBe(5);
  });

  it('schema validation failure routes immediately to DLQ without invoking handler', async () => {
    const handler = vi.fn();

    consumer = defineConsumer({
      name: 'schema-validator-consumer',
      topic: 'replication',
      group: 'val-group',
      broker,
      handler,
    });

    await consumer.start();

    // Invalid envelope: missing required fields in payload (e.g. targetProvider missing)
    const malformedEnvelope = {
      eventId: 'evt-bad-001',
      eventType: EVENT_TYPES.FILE_REPLICATE,
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      correlationId: 'corr-001',
      partitionKey: 'file-bad',
      attempt: 0,
      payload: { wrongField: 123 }, // missing targetProvider and fileId
    };

    await broker.publish('replication', 'file-bad', malformedEnvelope as never);
    await flushTimers();

    expect(handler).not.toHaveBeenCalled();
    expect(consumer.metrics.deadLettered).toBe(1);
    expect(consumer.metrics.processed).toBe(0);
  });
});
