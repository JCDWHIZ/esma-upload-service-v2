import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DlqWorker } from '../../src/workers/dlq.worker.js';
import type { AppConfigService } from '../../src/config/config.service.js';
import type { DeadLetterService } from '../../src/events/dead-letter.service.js';
import type {
  IMessageBroker,
  Subscription,
  DeliveryMeta,
  MessageHandler,
} from '../../src/events/broker.interface.js';
import { createEnvelope, type EventEnvelope } from '../../src/events/envelope.js';

describe('DlqWorker (P5-06)', () => {
  let worker: DlqWorker;
  let mockConfigService: Partial<AppConfigService>;
  let mockDeadLetterService: Partial<DeadLetterService>;
  let mockBroker: Partial<IMessageBroker>;
  let mockCloseSubscription: () => Promise<void>;
  let mockSubscription: Subscription;
  let registeredHandler: MessageHandler<unknown> | null = null;

  beforeEach(() => {
    mockConfigService = {};
    mockDeadLetterService = {
      recordDeadLetter: vi.fn().mockResolvedValue({ id: 'dlq-1' } as any),
    };

    mockCloseSubscription = vi.fn(() => Promise.resolve());
    mockSubscription = {
      close: mockCloseSubscription,
    };

    mockBroker = {
      subscribe: vi
        .fn()
        .mockImplementation(
          (_topic, _opts, handler: MessageHandler<unknown>) => {
            registeredHandler = handler;
            return Promise.resolve(mockSubscription);
          },
        ),
    };

    worker = new DlqWorker(
      mockConfigService as AppConfigService,
      mockDeadLetterService as DeadLetterService,
      mockBroker as IMessageBroker,
    );
  });

  it('subscribes to logical topic "dlq" on start', async () => {
    await worker.start();

    expect(vi.mocked(mockBroker.subscribe!)).toHaveBeenCalledWith(
      'dlq',
      expect.objectContaining({
        consumerGroup: 'esma-dlq-workers',
        concurrency: 1,
        maxAttempts: 1,
      }),
      expect.any(Function),
    );
    expect(worker.isRunning()).toBe(true);
  });

  it('unsubscribes and cleans up on stop', async () => {
    await worker.start();
    await worker.stop();

    expect(mockCloseSubscription).toHaveBeenCalledTimes(1);
    expect(worker.isRunning()).toBe(false);
  });

  it('processes incoming dead-letter message and records it in DeadLetterService', async () => {
    await worker.start();
    expect(registeredHandler).not.toBeNull();

    const envelope: EventEnvelope<Record<string, unknown>> = createEnvelope({
      eventType: 'file.replicate',
      partitionKey: 'f-123',
      eventId: 'evt-poison-1',
      timestamp: '2026-10-01T12:00:00Z',
      correlationId: 'corr-123',
      namespace: 'esma-tenant',
      tenantId: 'school-1',
      payload: { fileId: 'f-123' },
    });

    const meta: DeliveryMeta = {
      topic: 'dlq',
      partitionKey: 'f-123',
      attempt: 5,
      timestamp: '2026-10-01T12:00:00Z',
      headers: {
        'x-original-topic': 'replication',
        'x-error': 'Connection reset after 5 attempts',
        'x-attempts': '5',
        'x-event-type': 'file.replicate',
      },
    };

    const handler = registeredHandler!;
    const outcome = await handler(envelope, meta);

    expect(outcome).toEqual({ kind: 'ack' });
    expect(mockDeadLetterService.recordDeadLetter).toHaveBeenCalledWith({
      originalTopic: 'replication',
      eventType: 'file.replicate',
      eventId: 'evt-poison-1',
      envelope,
      error: 'Connection reset after 5 attempts',
      attempts: 5,
    });
    expect(worker.metrics.persisted).toBe(1);
  });

  it('handles service recording error gracefully with ack and increments error count', async () => {
    vi.mocked(mockDeadLetterService.recordDeadLetter!).mockRejectedValueOnce(
      new Error('DB connection lost'),
    );

    await worker.start();

    const envelope: EventEnvelope<Record<string, unknown>> = createEnvelope({
      eventType: 'file.replicate',
      partitionKey: 'f-fail',
      eventId: 'evt-fail',
      timestamp: '2026-10-01T12:00:00Z',
      correlationId: 'corr-fail',
      namespace: 'esma-tenant',
      tenantId: 'school-1',
      payload: {},
    });

    const meta: DeliveryMeta = {
      topic: 'dlq',
      partitionKey: 'f-fail',
      attempt: 1,
      timestamp: '2026-10-01T12:00:00Z',
    };

    const handler = registeredHandler!;
    const outcome = await handler(envelope, meta);

    expect(outcome).toEqual({ kind: 'ack' });
    expect(worker.metrics.errors).toBe(1);
  });
});
