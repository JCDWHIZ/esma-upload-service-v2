import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryBroker } from '../../src/events/memory-broker.js';
import { DeadLetterService } from '../../src/events/dead-letter.service.js';
import { DlqWorker } from '../../src/workers/dlq.worker.js';
import { OutboxWriter } from '../../src/events/outbox-writer.js';
import type {
  DeadLetterFilter,
  DeadLetterRecord,
  DeadLetterStatus,
  NewDeadLetterRecord,
} from '../../src/core/types.js';
import type { DeadLetterRepository } from '../../src/db/repositories/dead-letter.repository.js';
import type { OutboxRepository } from '../../src/db/repositories/outbox.repository.js';
import type { AuditRepository } from '../../src/db/repositories/audit.repository.js';
import type { DatabaseService } from '../../src/db/database.service.js';
import type { AppConfigService } from '../../src/config/config.service.js';
import {
  createEnvelope,
  type EventEnvelope,
} from '../../src/events/envelope.js';

interface MockOutboxEntry {
  topic: string;
  partitionKey: string;
  eventType: string;
  envelope: Record<string, unknown>;
}

interface MockAuditLog {
  action: string;
  actorId: string;
  outcome: string;
}

describe('Dead Letter Persistence & Operations End-to-End [P5-06]', () => {
  let broker: MemoryBroker;
  let records: Map<string, DeadLetterRecord>;
  let auditLogs: MockAuditLog[];
  let outboxEntries: MockOutboxEntry[];
  let deadLetterService: DeadLetterService;
  let dlqWorker: DlqWorker;
  let mockRepo: DeadLetterRepository;

  beforeEach(async () => {
    broker = new MemoryBroker();
    await broker.initialize();

    records = new Map<string, DeadLetterRecord>();
    auditLogs = [];
    outboxEntries = [];

    mockRepo = {
      insert: (data: NewDeadLetterRecord) => {
        const id = data.id ?? `dlq-${records.size + 1}`;
        const record: DeadLetterRecord = {
          id,
          receivedAt: data.receivedAt ?? new Date(),
          originalTopic: data.originalTopic,
          eventType: data.eventType,
          eventId: data.eventId,
          envelope: data.envelope,
          error: data.error,
          attempts: data.attempts ?? 1,
          status: data.status ?? 'OPEN',
          resolvedAt: null,
          resolvedBy: null,
        };
        records.set(id, record);
        return Promise.resolve(record);
      },
      findById: (id: string) => Promise.resolve(records.get(id) ?? null),
      findByEventId: (eventId: string) => {
        for (const r of records.values()) {
          if (r.eventId === eventId) return Promise.resolve(r);
        }
        return Promise.resolve(null);
      },
      query: (filter?: DeadLetterFilter) => {
        let list = Array.from(records.values());
        if (filter?.status) {
          list = list.filter((r) => r.status === filter.status);
        }
        if (filter?.originalTopic) {
          list = list.filter((r) => r.originalTopic === filter.originalTopic);
        }
        return Promise.resolve({
          items: list,
          nextCursor: null,
          hasMore: false,
        });
      },
      updateStatus: (
        id: string,
        status: DeadLetterStatus,
        resolvedBy?: string | null,
      ) => {
        const item = records.get(id);
        if (!item) return Promise.resolve(null);
        item.status = status;
        item.resolvedBy = resolvedBy ?? null;
        item.resolvedAt = new Date();
        return Promise.resolve(item);
      },
      countOpen: () => {
        const open = Array.from(records.values()).filter(
          (r) => r.status === 'OPEN',
        ).length;
        return Promise.resolve(open);
      },
    } as unknown as DeadLetterRepository;

    const mockOutboxRepo = {
      enqueue: (entry: MockOutboxEntry) => {
        outboxEntries.push(entry);
        return Promise.resolve();
      },
    } as unknown as OutboxRepository;

    const outboxWriter = new OutboxWriter(mockOutboxRepo);

    const mockAuditRepo = {
      insert: (entry: MockAuditLog) => {
        auditLogs.push(entry);
        return Promise.resolve(entry);
      },
    } as unknown as AuditRepository;

    const mockDbService = {
      getDb: () => null,
    } as unknown as DatabaseService;

    deadLetterService = new DeadLetterService(
      mockRepo,
      outboxWriter,
      mockAuditRepo,
      mockDbService,
      broker,
    );

    dlqWorker = new DlqWorker(
      {
        consumerHandlerTimeoutMs: 1000,
        consumerShutdownTimeoutMs: 1000,
      } as AppConfigService,
      deadLetterService,
      broker,
    );

    await dlqWorker.start();
  });

  it('completes the full dead-letter lifecycle: ingestion → list → redrive → discard', async () => {
    // 1. Poisoned event published to DLQ by broker
    const poisonedEnvelope: EventEnvelope<Record<string, unknown>> =
      createEnvelope({
        eventId: 'evt-poison-999',
        eventType: 'file.replicate',
        timestamp: new Date().toISOString(),
        partitionKey: 'file-poison-999',
        correlationId: 'corr-poison',
        namespace: 'esma-tenant',
        tenantId: 'school-1',
        payload: {
          fileId: 'file-poison-999',
          targetProvider: 'cloudinary',
        },
      });

    await broker.publish('dlq', 'file-poison-999', poisonedEnvelope, {
      headers: {
        'x-original-topic': 'replication',
        'x-error': 'Permanent cloud failure: 403 Forbidden Cloudinary quota',
        'x-attempts': '6',
        'x-event-type': 'file.replicate',
      },
    });

    // Wait briefly for in-memory broker subscriber loop
    await new Promise((r) => setTimeout(r, 50));

    // 2. Dead letter exists in repository and is OPEN
    expect(records.size).toBe(1);
    const [dlqEntry] = Array.from(records.values());
    expect(dlqEntry.eventId).toBe('evt-poison-999');
    expect(dlqEntry.originalTopic).toBe('replication');
    expect(dlqEntry.status).toBe('OPEN');
    expect(dlqEntry.attempts).toBe(6);
    expect(dlqEntry.error).toContain('Permanent cloud failure');

    // 3. Metric gus_dlq_depth reflects 1 OPEN dead letter
    const depthBefore = await deadLetterService.getDlqDepth();
    expect(depthBefore).toBe(1);

    // 4. Redrive republishes to original topic ('replication') with attempt reset to 0
    let redeliveredEnvelope: EventEnvelope<Record<string, unknown>> | null =
      null;
    await broker.subscribe(
      'replication',
      { consumerGroup: 'verification', concurrency: 1, maxAttempts: 1 },
      (env: EventEnvelope<Record<string, unknown>>) => {
        redeliveredEnvelope = env;
        return Promise.resolve({ kind: 'ack' as const });
      },
    );

    const redriven = await deadLetterService.redrive(
      dlqEntry.id,
      'operator-john',
      {
        directPublish: true,
      },
    );

    expect(redriven.status).toBe('REDRIVEN');
    expect(redriven.resolvedBy).toBe('operator-john');
    expect(redriven.resolvedAt).toBeDefined();

    // Verify outbox entry was recorded
    expect(outboxEntries.length).toBeGreaterThan(0);
    expect(outboxEntries[0].topic).toBe('replication');

    // Verify audit log entry
    expect(
      auditLogs.some(
        (a) => a.action === 'dlq.redrive' && a.actorId === 'operator-john',
      ),
    ).toBe(true);

    // Verify redelivered message received with attempt 0
    await new Promise((r) => setTimeout(r, 50));
    expect(redeliveredEnvelope).not.toBeNull();
    const env = redeliveredEnvelope as unknown as {
      attempt: number;
      redriveCount: number;
    };
    expect(env.attempt).toBe(0);
    expect(env.redriveCount).toBe(1);

    // 5. Verify gus_dlq_depth is now 0 OPEN dead letters
    const depthAfter = await deadLetterService.getDlqDepth();
    expect(depthAfter).toBe(0);

    const discardEnvelope: EventEnvelope<Record<string, unknown>> =
      createEnvelope({
        eventId: 'evt-poison-discard',
        eventType: 'file.purge',
        timestamp: new Date().toISOString(),
        partitionKey: 'file-discard',
        correlationId: 'corr-discard',
        namespace: 'esma-tenant',
        tenantId: 'school-1',
        payload: {},
      });

    await broker.publish('dlq', 'file-discard', discardEnvelope, {
      headers: {
        'x-original-topic': 'replication',
        'x-error': 'Unrecoverable corrupted payload',
        'x-attempts': '1',
      },
    });

    await new Promise((r) => setTimeout(r, 50));

    const discardEntry = await mockRepo.findByEventId('evt-poison-discard');
    expect(discardEntry).not.toBeNull();
    const targetEntry = discardEntry as DeadLetterRecord;
    expect(targetEntry.status).toBe('OPEN');

    const discarded = await deadLetterService.discard(
      targetEntry.id,
      'operator-jane',
      'Payload cannot be recovered',
    );

    expect(discarded.status).toBe('DISCARDED');
    expect(discarded.resolvedBy).toBe('operator-jane');
    expect(
      auditLogs.some(
        (a) => a.action === 'dlq.discard' && a.actorId === 'operator-jane',
      ),
    ).toBe(true);

    await dlqWorker.stop();
  });
});
