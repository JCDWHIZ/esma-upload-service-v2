/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OutboxWriter } from '../../src/events/outbox-writer.js';
import { EVENT_TYPES } from '../../src/events/catalog.js';
import { createEnvelope } from '../../src/events/envelope.js';
import type { OutboxRepository } from '../../src/db/repositories/outbox.repository.js';

describe('OutboxWriter', () => {
  let outboxRepo: OutboxRepository;
  let writer: OutboxWriter;

  const fakeEnqueued: unknown[] = [];

  beforeEach(() => {
    fakeEnqueued.length = 0;
    outboxRepo = {
      enqueue: vi.fn().mockImplementation((event: unknown) => {
        fakeEnqueued.push(event);
        return Promise.resolve({ id: 'ob-1' });
      }),
    } as unknown as OutboxRepository;
    writer = new OutboxWriter(outboxRepo);
  });

  it('derives topic from EVENT_CATALOG for file.uploaded', async () => {
    const envelope = createEnvelope({
      eventType: EVENT_TYPES.FILE_UPLOADED,
      partitionKey: 'file-001',
      payload: {
        fileId: 'file-001',
        size: 1234,
        mimetype: 'image/png',
        primaryProvider: 'local',
      },
    });

    await writer.enqueue({} as never, envelope);

    expect(outboxRepo.enqueue).toHaveBeenCalledOnce();
    const call = (outboxRepo.enqueue as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(call.topic).toBe('audit');
    expect(call.eventType).toBe(EVENT_TYPES.FILE_UPLOADED);
    expect(call.partitionKey).toBe('file-001');
  });

  it('derives replication topic for file.replicate', async () => {
    const envelope = createEnvelope({
      eventType: EVENT_TYPES.FILE_REPLICATE,
      partitionKey: 'file-002',
      payload: { fileId: 'file-002', targetProvider: 'seaweedfs' },
    });

    await writer.enqueue({} as never, envelope);

    const call = (outboxRepo.enqueue as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(call.topic).toBe('replication');
  });

  it('applies topicOverride when supplied', async () => {
    const envelope = createEnvelope({
      eventType: EVENT_TYPES.FILE_UPLOADED,
      partitionKey: 'file-003',
      payload: {
        fileId: 'file-003',
        size: 1,
        mimetype: 'text/plain',
        primaryProvider: 'local',
      },
    });

    await writer.enqueue({} as never, envelope, 'dlq');

    const call = (outboxRepo.enqueue as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(call.topic).toBe('dlq');
  });

  it('stores the full envelope in the outbox row', async () => {
    const envelope = createEnvelope({
      eventType: EVENT_TYPES.FILE_PURGE,
      partitionKey: 'file-004',
      payload: { fileId: 'file-004' },
    });

    await writer.enqueue({} as never, envelope);

    const call = (outboxRepo.enqueue as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    const stored = call.envelope as Record<string, unknown>;
    expect(stored['eventType']).toBe(EVENT_TYPES.FILE_PURGE);
    expect(stored['partitionKey']).toBe('file-004');
  });
});
