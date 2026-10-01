/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { IMessageBroker } from '../../src/events/broker.interface.js';
import { createEnvelope } from '../../src/events/envelope.js';
import { EVENT_TYPES } from '../../src/events/catalog.js';

export interface BrokerContractOptions {
  orderingMessageCount?: number;
  orderingKeyCount?: number;
  retryDelayMs?: number;
  cleanup?: (broker: IMessageBroker) => Promise<void> | void;
}

/**
 * Reusable contract test suite that all IMessageBroker implementations must pass.
 * Parameterized over: MemoryBroker, KafkaBrokerDriver, PulsarBrokerDriver.
 *
 * Verifies core contract behaviors defined in ARCH §8, ADR-08, and BACKEND_TASKS.md (P5-05):
 * 1. Lifecycle and health probes
 * 2. Publish and consume with envelope, payload, and headers intact
 * 3. Consumer group fanout and competing consumers load sharing
 * 4. Per-key sequential ordering under concurrency
 * 5. Retry outcome with attempt increment and delay handling
 * 6. DLQ routing on exhausted retries and immediate dead-letter
 * 7. Graceful disconnect and in-flight handler draining
 */
export function runBrokerContract(
  name: string,
  factory: () => Promise<IMessageBroker> | IMessageBroker,
  options?: BrokerContractOptions,
): void {
  const orderingMessageCount = options?.orderingMessageCount ?? 60;
  const orderingKeyCount = options?.orderingKeyCount ?? 6;
  const retryDelayMs = options?.retryDelayMs ?? 25;

  describe(`Broker Contract: ${name}`, () => {
    let broker: IMessageBroker;

    beforeEach(async () => {
      broker = await factory();
      if (!(await broker.healthCheck())) {
        await broker.initialize();
      }
    });

    afterEach(async () => {
      try {
        if (await broker.healthCheck()) {
          await broker.disconnect();
        }
      } catch {
        // ignore disconnect errors during teardown
      }
      if (options?.cleanup) {
        await options.cleanup(broker);
      }
    });

    // ─── 1. Lifecycle & Health ──────────────────────────────────────────────────

    describe('Lifecycle & Health', () => {
      it('reports healthCheck = true when initialized', async () => {
        expect(await broker.healthCheck()).toBe(true);
      });

      it('reports healthCheck = false after disconnect', async () => {
        await broker.disconnect();
        expect(await broker.healthCheck()).toBe(false);
      });
    });

    // ─── 2. Publish & Consume Semantics ─────────────────────────────────────────

    describe('Publish & Consume Semantics', () => {
      it('delivers published event with envelope, payload, and headers intact', async () => {
        const delivered: Array<{ event: any; meta: any }> = [];

        const sub = await broker.subscribe(
          'replication',
          {
            consumerGroup: 'contract-rep-group',
            concurrency: 1,
            maxAttempts: 3,
          },
          async (event, meta) => {
            delivered.push({ event, meta });
            return { kind: 'ack' };
          },
        );

        const envelope = createEnvelope({
          eventType: EVENT_TYPES.FILE_REPLICATE,
          partitionKey: 'file-contract-1',
          payload: { fileId: 'file-contract-1', targetProvider: 'seaweedfs' },
          correlationId: 'corr-contract-999',
          causationId: 'caus-contract-888',
        });

        await broker.publish('replication', 'file-contract-1', envelope, {
          headers: {
            'x-custom-tenant': 'tenant-acme',
            'x-trace-id': 'trace-12345',
          },
        });

        // Wait for delivery
        await waitFor(() => delivered.length >= 1, 2000);

        expect(delivered).toHaveLength(1);
        const { event, meta } = delivered[0];
        expect(event.eventId).toBe(envelope.eventId);
        expect(event.eventType).toBe(EVENT_TYPES.FILE_REPLICATE);
        expect(event.payload).toEqual({
          fileId: 'file-contract-1',
          targetProvider: 'seaweedfs',
        });
        expect(event.correlationId).toBe('corr-contract-999');
        expect(event.causationId).toBe('caus-contract-888');

        expect(meta.topic).toBe('replication');
        expect(meta.partitionKey).toBe('file-contract-1');
        expect(meta.attempt).toBe(0);
        expect(meta.headers).toMatchObject({
          'x-custom-tenant': 'tenant-acme',
          'x-trace-id': 'trace-12345',
        });

        await sub.close();
      });

      it('stops further message deliveries after subscription.close()', async () => {
        let count = 0;
        const sub = await broker.subscribe(
          'audit',
          {
            consumerGroup: 'contract-audit-close',
            concurrency: 1,
            maxAttempts: 3,
          },
          async () => {
            count++;
            return { kind: 'ack' };
          },
        );

        const env1 = createEnvelope({
          eventType: EVENT_TYPES.FILE_DELETED,
          partitionKey: 'f-close-1',
          payload: { fileId: 'f-close-1' },
        });
        await broker.publish('audit', 'f-close-1', env1);
        await waitFor(() => count === 1, 2000);
        expect(count).toBe(1);

        await sub.close();

        const env2 = createEnvelope({
          eventType: EVENT_TYPES.FILE_DELETED,
          partitionKey: 'f-close-2',
          payload: { fileId: 'f-close-2' },
        });
        await broker.publish('audit', 'f-close-2', env2);

        // Allow time to ensure no delivery occurred
        await sleep(50);
        expect(count).toBe(1);
      });
    });

    // ─── 3. Consumer Groups & Competing Consumers ───────────────────────────────

    describe('Consumer Groups & Fan-out', () => {
      it('fans out message to multiple distinct consumer groups', async () => {
        const groupADelivered: string[] = [];
        const groupBDelivered: string[] = [];

        const subA = await broker.subscribe(
          'processing',
          { consumerGroup: 'group-a', concurrency: 1, maxAttempts: 3 },
          async (event) => {
            groupADelivered.push(event.eventId);
            return { kind: 'ack' };
          },
        );

        const subB = await broker.subscribe(
          'processing',
          { consumerGroup: 'group-b', concurrency: 1, maxAttempts: 3 },
          async (event) => {
            groupBDelivered.push(event.eventId);
            return { kind: 'ack' };
          },
        );

        const envelope = createEnvelope({
          eventType: EVENT_TYPES.FILE_UPLOADED,
          partitionKey: 'f-fanout-1',
          payload: { fileId: 'f-fanout-1', primaryProvider: 'local' },
        });

        await broker.publish('processing', 'f-fanout-1', envelope);

        await waitFor(
          () => groupADelivered.length >= 1 && groupBDelivered.length >= 1,
          2000,
        );

        expect(groupADelivered).toEqual([envelope.eventId]);
        expect(groupBDelivered).toEqual([envelope.eventId]);

        await subA.close();
        await subB.close();
      });

      it('splits messages across competing consumers in the same group without duplicates', async () => {
        const worker1: string[] = [];
        const worker2: string[] = [];

        const sub1 = await broker.subscribe(
          'replication',
          {
            consumerGroup: 'competing-rep-workers',
            concurrency: 1,
            maxAttempts: 3,
          },
          async (event) => {
            worker1.push(event.eventId);
            return { kind: 'ack' };
          },
        );

        const sub2 = await broker.subscribe(
          'replication',
          {
            consumerGroup: 'competing-rep-workers',
            concurrency: 1,
            maxAttempts: 3,
          },
          async (event) => {
            worker2.push(event.eventId);
            return { kind: 'ack' };
          },
        );

        const envelopes = Array.from({ length: 12 }, (_, i) =>
          createEnvelope({
            eventType: EVENT_TYPES.FILE_REPLICATE,
            partitionKey: `key-${i % 4}`,
            payload: { fileId: `key-${i % 4}`, targetProvider: 'seaweedfs' },
          }),
        );

        for (const env of envelopes) {
          await broker.publish('replication', env.partitionKey, env);
        }

        await waitFor(
          () => worker1.length + worker2.length === envelopes.length,
          3000,
        );

        // Every message handled exactly once across the group
        const allReceived = [...worker1, ...worker2];
        expect(allReceived).toHaveLength(envelopes.length);
        const unique = new Set(allReceived);
        expect(unique.size).toBe(envelopes.length);

        // Verify that neither consumer was starved
        expect(worker1.length).toBeGreaterThan(0);
        expect(worker2.length).toBeGreaterThan(0);

        await sub1.close();
        await sub2.close();
      });
    });

    // ─── 4. Per-Key Sequential Ordering ─────────────────────────────────────────

    describe('Per-Key Ordering', () => {
      it(`preserves strict per-key FIFO ordering over ${orderingMessageCount} messages across ${orderingKeyCount} keys`, async () => {
        const perKeyDelivered = new Map<string, number[]>();
        for (let k = 0; k < orderingKeyCount; k++) {
          perKeyDelivered.set(`key-${k}`, []);
        }

        const sub = await broker.subscribe(
          'replication',
          { consumerGroup: 'ordering-group', concurrency: 3, maxAttempts: 3 },
          async (event) => {
            const seq = (event.payload as { seq: number }).seq;
            const key = event.partitionKey;
            perKeyDelivered.get(key)!.push(seq);
            return { kind: 'ack' };
          },
        );

        // Publish interleaved messages across keys
        for (let i = 0; i < orderingMessageCount; i++) {
          const key = `key-${i % orderingKeyCount}`;
          const envelope = createEnvelope({
            eventType: EVENT_TYPES.FILE_REPLICATE,
            partitionKey: key,
            payload: { fileId: key, seq: i },
          });
          await broker.publish('replication', key, envelope);
        }

        await waitFor(() => {
          let total = 0;
          for (const list of perKeyDelivered.values()) total += list.length;
          return total === orderingMessageCount;
        }, 5000);

        // For every key, sequences must be strictly increasing
        for (const [key, seqs] of perKeyDelivered.entries()) {
          expect(seqs.length).toBeGreaterThan(0);
          for (let idx = 1; idx < seqs.length; idx++) {
            expect(seqs[idx]).toBeGreaterThan(seqs[idx - 1]);
          }
        }

        await sub.close();
      });
    });

    // ─── 5. Retry Semantics ─────────────────────────────────────────────────────

    describe('Retry Semantics', () => {
      it('redelivers message with incremented attempt on { kind: "retry" }', async () => {
        const attemptsSeen: number[] = [];

        const sub = await broker.subscribe(
          'replication',
          {
            consumerGroup: 'contract-retry-group',
            concurrency: 1,
            maxAttempts: 3,
          },
          async (event, meta) => {
            attemptsSeen.push(meta.attempt);
            if (meta.attempt === 0) {
              return {
                kind: 'retry',
                reason: 'Simulated transient failure',
                delayMs: retryDelayMs,
              };
            }
            return { kind: 'ack' };
          },
        );

        const envelope = createEnvelope({
          eventType: EVENT_TYPES.FILE_REPLICATE,
          partitionKey: 'f-retry-1',
          payload: { fileId: 'f-retry-1', targetProvider: 'seaweedfs' },
        });

        await broker.publish('replication', 'f-retry-1', envelope);

        await waitFor(() => attemptsSeen.length >= 2, 3000);

        expect(attemptsSeen[0]).toBe(0);
        expect(attemptsSeen[1]).toBe(1);

        await sub.close();
      });

      it('treats uncaught exception from handler as retry outcome', async () => {
        let calls = 0;

        const sub = await broker.subscribe(
          'replication',
          {
            consumerGroup: 'contract-crash-retry',
            concurrency: 1,
            maxAttempts: 3,
          },
          async (_event, meta) => {
            calls++;
            if (meta.attempt === 0) {
              throw new Error('Uncaught unexpected error in handler');
            }
            return { kind: 'ack' };
          },
        );

        const envelope = createEnvelope({
          eventType: EVENT_TYPES.FILE_PURGE,
          partitionKey: 'f-crash-1',
          payload: { fileId: 'f-crash-1' },
        });

        await broker.publish('replication', 'f-crash-1', envelope);

        await waitFor(() => calls >= 2, 3000);
        expect(calls).toBeGreaterThanOrEqual(2);

        await sub.close();
      });
    });

    // ─── 6. DLQ Routing ─────────────────────────────────────────────────────────

    describe('DLQ Routing', () => {
      it('routes message to DLQ topic when maxAttempts is reached', async () => {
        const dlqReceived: Array<{ event: any; meta: any }> = [];

        // Subscribe to DLQ topic
        const dlqSub = await broker.subscribe(
          'dlq',
          { consumerGroup: 'dlq-monitor', concurrency: 1, maxAttempts: 5 },
          async (event, meta) => {
            dlqReceived.push({ event, meta });
            return { kind: 'ack' };
          },
        );

        // Worker that always fails
        const workerSub = await broker.subscribe(
          'replication',
          {
            consumerGroup: 'always-failing-worker',
            concurrency: 1,
            maxAttempts: 2,
          },
          async () => {
            return {
              kind: 'retry',
              reason: 'Permanent resource unreachability',
              delayMs: retryDelayMs,
            };
          },
        );

        const envelope = createEnvelope({
          eventType: EVENT_TYPES.FILE_REPLICATE,
          partitionKey: 'f-dlq-exhaust',
          payload: { fileId: 'f-dlq-exhaust', targetProvider: 'seaweedfs' },
        });

        await broker.publish('replication', 'f-dlq-exhaust', envelope);

        await waitFor(() => dlqReceived.length >= 1, 4000);

        expect(dlqReceived).toHaveLength(1);
        const item = dlqReceived[0];
        expect(item.event.eventId).toBe(envelope.eventId);
        expect(item.meta.headers).toMatchObject({
          'x-original-topic': 'replication',
          'x-error': expect.stringContaining('Exceeded max attempts (2)'),
        });

        await workerSub.close();
        await dlqSub.close();
      });

      it('routes immediately to DLQ topic on { kind: "dead-letter" }', async () => {
        const dlqReceived: Array<{ event: any; meta: any }> = [];

        const dlqSub = await broker.subscribe(
          'dlq',
          {
            consumerGroup: 'dlq-immediate-monitor',
            concurrency: 1,
            maxAttempts: 5,
          },
          async (event, meta) => {
            dlqReceived.push({ event, meta });
            return { kind: 'ack' };
          },
        );

        const workerSub = await broker.subscribe(
          'replication',
          {
            consumerGroup: 'dead-lettering-worker',
            concurrency: 1,
            maxAttempts: 3,
          },
          async () => {
            return {
              kind: 'dead-letter',
              reason: 'Invalid payload schema: corrupted byte sequence',
            };
          },
        );

        const envelope = createEnvelope({
          eventType: EVENT_TYPES.FILE_REPLICATE,
          partitionKey: 'f-dead-letter-now',
          payload: { fileId: 'f-dead-letter-now', targetProvider: 'seaweedfs' },
        });

        await broker.publish('replication', 'f-dead-letter-now', envelope);

        await waitFor(() => dlqReceived.length >= 1, 3000);

        expect(dlqReceived).toHaveLength(1);
        const item = dlqReceived[0];
        expect(item.event.eventId).toBe(envelope.eventId);
        expect(item.meta.headers).toMatchObject({
          'x-original-topic': 'replication',
          'x-error': 'Invalid payload schema: corrupted byte sequence',
        });

        await workerSub.close();
        await dlqSub.close();
      });
    });

    // ─── 7. Graceful Disconnect & Drain ─────────────────────────────────────────

    describe('Graceful Disconnect & Drain', () => {
      it('drains in-flight handlers before completing disconnect', async () => {
        let handlerStarted = false;
        let handlerFinished = false;

        await broker.subscribe(
          'audit',
          {
            consumerGroup: 'contract-drain-group',
            concurrency: 1,
            maxAttempts: 3,
          },
          async () => {
            handlerStarted = true;
            await sleep(40);
            handlerFinished = true;
            return { kind: 'ack' };
          },
        );

        const envelope = createEnvelope({
          eventType: EVENT_TYPES.FILE_DELETED,
          partitionKey: 'f-drain-1',
          payload: { fileId: 'f-drain-1' },
        });

        await broker.publish('audit', 'f-drain-1', envelope);

        // Wait for handler to pick up message
        await waitFor(() => handlerStarted, 1000);

        // Trigger broker disconnect while handler is active
        await broker.disconnect();

        // Handler must have finished cleanly before disconnect finished
        expect(handlerFinished).toBe(true);
      });
    });
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs = 15,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await sleep(intervalMs);
  }
}
