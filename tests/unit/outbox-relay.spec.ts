/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/require-await */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OutboxRelay } from '../../src/events/outbox-relay.js';
import { EVENT_TYPES, type LogicalTopic } from '../../src/events/catalog.js';
import { createEnvelope } from '../../src/events/envelope.js';
import type { IMessageBroker } from '../../src/events/broker.interface.js';
import type { AppConfigService } from '../../src/config/config.service.js';
import type { DatabaseService } from '../../src/db/database.service.js';
import type { OutboxRepository } from '../../src/db/repositories/outbox.repository.js';
import type { OutboxEvent } from '../../src/core/types.js';

// ─── helpers ────────────────────────────────────────────────────────────────

function makeOutboxRow(overrides: Partial<OutboxEvent> = {}): OutboxEvent {
  const envelope = createEnvelope({
    eventType: EVENT_TYPES.FILE_UPLOADED,
    partitionKey: overrides.partitionKey ?? 'file-001',
    payload: {
      fileId: overrides.partitionKey ?? 'file-001',
      size: 100,
      mimetype: 'text/plain',
      primaryProvider: 'local',
    },
  });
  return {
    id: 'row-1',
    topic: 'audit',
    partitionKey: 'file-001',
    eventType: EVENT_TYPES.FILE_UPLOADED,
    envelope: envelope as unknown as Record<string, unknown>,
    createdAt: new Date(),
    availableAt: new Date(),
    publishedAt: null,
    attempts: 0,
    lastError: null,
    ...overrides,
  };
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe('OutboxRelay', () => {
  let relay: OutboxRelay;
  let outboxRepo: OutboxRepository;
  let broker: IMessageBroker;
  let configService: AppConfigService;
  let databaseService: DatabaseService;

  const publishedRows: string[] = [];
  const failedRows: string[] = [];

  const buildRelay = (rows: OutboxEvent[], brokerFail = false) => {
    publishedRows.length = 0;
    failedRows.length = 0;

    outboxRepo = {
      claimBatch: vi
        .fn()
        .mockImplementationOnce(async () => rows)
        .mockResolvedValue([]),
      markPublished: vi.fn().mockImplementation(async (id: string) => {
        publishedRows.push(id);
      }),
      markFailed: vi.fn().mockImplementation(async (id: string) => {
        failedRows.push(id);
      }),
    } as unknown as OutboxRepository;

    broker = {
      name: 'memory',
      initialize: vi.fn(),
      publish: brokerFail
        ? vi.fn().mockRejectedValue(new Error('broker down'))
        : vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue(true),
      disconnect: vi.fn(),
    } as unknown as IMessageBroker;

    databaseService = {
      getDb: vi.fn().mockReturnValue({
        transaction: () => ({
          execute: async <T>(fn: (trx: unknown) => Promise<T>): Promise<T> =>
            fn({}),
        }),
      }),
    } as unknown as DatabaseService;

    configService = {} as unknown as AppConfigService;

    relay = new OutboxRelay(
      configService,
      databaseService,
      outboxRepo,
      broker,
      {
        pollMinMs: 50,
        pollMaxMs: 200,
        batchSize: 10,
        backoffBaseSeconds: 0.01,
        backoffFactor: 2,
        backoffCapSeconds: 0.1,
      },
    );
  };

  beforeEach(() => {
    publishedRows.length = 0;
    failedRows.length = 0;
  });

  afterEach(() => {
    relay?.stop();
  });

  it('publishes a row and marks it published', async () => {
    const row = makeOutboxRow({ id: 'row-1', partitionKey: 'file-A' });
    buildRelay([row]);

    await relay['processBatch']();

    expect(broker.publish).toHaveBeenCalledOnce();
    const [topic, key] = (broker.publish as ReturnType<typeof vi.fn>).mock
      .calls[0] as [LogicalTopic, string];
    expect(topic).toBe('audit');
    expect(key).toBe('file-A');
    expect(publishedRows).toContain('row-1');
    expect(failedRows).toHaveLength(0);
  });

  it('marks row failed and sets next available_at on broker error', async () => {
    const row = makeOutboxRow({ id: 'row-fail', partitionKey: 'file-B' });
    buildRelay([row], true);

    await relay['processBatch']();

    expect(failedRows).toContain('row-fail');
    expect(publishedRows).toHaveLength(0);

    // markFailed should receive a future Date
    const markFailedCall = (outboxRepo.markFailed as ReturnType<typeof vi.fn>)
      .mock.calls[0];
    const nextAvailableAt = markFailedCall[2] as Date;
    expect(nextAvailableAt.getTime()).toBeGreaterThan(Date.now() - 100);
  });

  it('blocks later rows with same partition key when earlier row fails', async () => {
    // Two rows sharing the same partitionKey; broker fails on first
    const rowA = makeOutboxRow({ id: 'row-A', partitionKey: 'file-X' });
    const rowB = makeOutboxRow({ id: 'row-B', partitionKey: 'file-X' });

    outboxRepo = {
      claimBatch: vi
        .fn()
        .mockResolvedValueOnce([rowA, rowB])
        .mockResolvedValue([]),
      markPublished: vi.fn().mockImplementation(async (id: string) => {
        publishedRows.push(id);
      }),
      markFailed: vi.fn().mockImplementation(async (id: string) => {
        failedRows.push(id);
      }),
    } as unknown as OutboxRepository;

    broker = {
      name: 'memory',
      publish: vi.fn().mockRejectedValue(new Error('broker error')),
      disconnect: vi.fn(),
    } as unknown as IMessageBroker;

    databaseService = {
      getDb: vi.fn().mockReturnValue({
        transaction: () => ({
          execute: async <T>(fn: (trx: unknown) => Promise<T>): Promise<T> =>
            fn({}),
        }),
      }),
    } as unknown as DatabaseService;

    relay = new OutboxRelay(
      {} as unknown as AppConfigService,
      databaseService,
      outboxRepo,
      broker,
      { pollMinMs: 50, pollMaxMs: 200, backoffBaseSeconds: 0.01 },
    );

    await relay['processBatch']();

    // row-A fails; row-B is skipped (blocked) – only row-A in failedRows, broker called once
    expect(broker.publish).toHaveBeenCalledTimes(1);
    expect(failedRows).toEqual(['row-A']);
    expect(publishedRows).toHaveLength(0);
  });

  it('publishes rows with different partition keys independently even when first fails', async () => {
    const rowA = makeOutboxRow({ id: 'row-A', partitionKey: 'file-X' });
    const rowC = makeOutboxRow({ id: 'row-C', partitionKey: 'file-Y' });

    let call = 0;
    outboxRepo = {
      claimBatch: vi
        .fn()
        .mockResolvedValueOnce([rowA, rowC])
        .mockResolvedValue([]),
      markPublished: vi.fn().mockImplementation(async (id: string) => {
        publishedRows.push(id);
      }),
      markFailed: vi.fn().mockImplementation(async (id: string) => {
        failedRows.push(id);
      }),
    } as unknown as OutboxRepository;

    broker = {
      name: 'memory',
      // First call (file-X) fails; second call (file-Y) succeeds
      publish: vi.fn().mockImplementation(async () => {
        if (call++ === 0) throw new Error('broker error');
      }),
      disconnect: vi.fn(),
    } as unknown as IMessageBroker;

    databaseService = {
      getDb: vi.fn().mockReturnValue({
        transaction: () => ({
          execute: async <T>(fn: (trx: unknown) => Promise<T>): Promise<T> =>
            fn({}),
        }),
      }),
    } as unknown as DatabaseService;

    relay = new OutboxRelay(
      {} as unknown as AppConfigService,
      databaseService,
      outboxRepo,
      broker,
      { pollMinMs: 50, pollMaxMs: 200, backoffBaseSeconds: 0.01 },
    );

    await relay['processBatch']();

    expect(failedRows).toContain('row-A');
    expect(publishedRows).toContain('row-C');
  });

  it('returns 0 when database is unavailable', async () => {
    buildRelay([]);
    (databaseService.getDb as ReturnType<typeof vi.fn>).mockReturnValue(
      undefined,
    );

    const count = await relay['processBatch']();
    expect(count).toBe(0);
    expect(broker.publish).not.toHaveBeenCalled();
  });
});
