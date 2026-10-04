import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DeadLetterService } from '../../src/events/dead-letter.service.js';
import type { DeadLetterRepository } from '../../src/db/repositories/dead-letter.repository.js';
import type { OutboxWriter } from '../../src/events/outbox-writer.js';
import type { AuditRepository } from '../../src/db/repositories/audit.repository.js';
import type { DatabaseService } from '../../src/db/database.service.js';
import type { IMessageBroker } from '../../src/events/broker.interface.js';
import type {
  DeadLetterRecord,
  DeadLetterStatus,
  NewDeadLetterRecord,
} from '../../src/core/types.js';
import {
  NotFoundError,
  ValidationError,
} from '../../src/core/errors/app-error.js';

describe('DeadLetterService (P5-06)', () => {
  let service: DeadLetterService;
  let mockDeadLetterRepo: Partial<DeadLetterRepository>;
  let mockOutboxWriter: Partial<OutboxWriter>;
  let mockAuditRepo: Partial<AuditRepository>;
  let mockDbService: Partial<DatabaseService>;
  let mockBroker: Partial<IMessageBroker>;

  const sampleDeadLetter: DeadLetterRecord = {
    id: 'dlq-111',
    receivedAt: new Date('2026-10-01T12:00:00Z'),
    originalTopic: 'replication',
    eventType: 'file.replicate',
    eventId: 'evt-111',
    envelope: {
      eventId: 'evt-111',
      eventType: 'file.replicate',
      partitionKey: 'file-abc',
      payload: { fileId: 'file-abc', targetProvider: 'cloudinary' },
      attempt: 5,
    },
    error: 'Exceeded max attempts (5): Network timeout',
    attempts: 5,
    status: 'OPEN',
    resolvedAt: null,
    resolvedBy: null,
  };

  beforeEach(() => {
    mockDeadLetterRepo = {
      findByEventId: vi.fn().mockResolvedValue(null),
      findById: vi.fn().mockResolvedValue(sampleDeadLetter),
      insert: vi.fn().mockImplementation((data: NewDeadLetterRecord) =>
        Promise.resolve({
          ...data,
          id: data.id ?? 'dlq-new',
          receivedAt: data.receivedAt ?? new Date(),
          attempts: data.attempts ?? 1,
          status: data.status ?? 'OPEN',
          resolvedAt: null,
          resolvedBy: null,
        } as DeadLetterRecord),
      ),
      query: vi.fn().mockResolvedValue({
        items: [sampleDeadLetter],
        nextCursor: null,
        hasMore: false,
      }),
      countOpen: vi.fn().mockResolvedValue(1),
      updateStatus: vi
        .fn()
        .mockImplementation(
          (id: string, status: DeadLetterStatus, resolvedBy?: string | null) =>
            Promise.resolve({
              ...sampleDeadLetter,
              id,
              status,
              resolvedBy: resolvedBy ?? null,
              resolvedAt: new Date(),
            } as DeadLetterRecord),
        ),
    };

    mockOutboxWriter = {
      enqueue: vi.fn().mockResolvedValue(undefined),
    };

    mockAuditRepo = {
      insert: vi.fn().mockResolvedValue({} as any),
    };

    mockDbService = {
      getDb: vi.fn().mockReturnValue(null), // hermetic / direct mode without postgres pool
    };

    mockBroker = {
      publish: vi.fn().mockResolvedValue(undefined),
    };

    service = new DeadLetterService(
      mockDeadLetterRepo as DeadLetterRepository,
      mockOutboxWriter as OutboxWriter,
      mockAuditRepo as AuditRepository,
      mockDbService as DatabaseService,
      mockBroker as IMessageBroker,
    );
  });

  describe('recordDeadLetter', () => {
    it('persists a new dead letter if not seen before', async () => {
      const res = await service.recordDeadLetter({
        originalTopic: 'replication',
        eventType: 'file.replicate',
        eventId: 'evt-fresh',
        envelope: { eventId: 'evt-fresh' },
        error: 'Fatal connection error',
        attempts: 3,
      });

      expect(mockDeadLetterRepo.insert).toHaveBeenCalledTimes(1);
      expect(res.eventId).toBe('evt-fresh');
      expect(res.status).toBe('OPEN');
    });

    it('returns existing record idempotently if already in OPEN state', async () => {
      vi.mocked(mockDeadLetterRepo.findByEventId!).mockResolvedValueOnce(
        sampleDeadLetter,
      );

      const res = await service.recordDeadLetter({
        originalTopic: 'replication',
        eventType: 'file.replicate',
        eventId: 'evt-111',
        envelope: { eventId: 'evt-111' },
        error: 'Duplicate error',
        attempts: 3,
      });

      expect(mockDeadLetterRepo.insert).not.toHaveBeenCalled();
      expect(res.id).toBe('dlq-111');
      expect(res.status).toBe('OPEN');
    });
  });

  describe('list and getById', () => {
    it('lists dead letters with totalOpen count', async () => {
      const result = await service.list({ status: 'OPEN' }, undefined, 10);
      expect(mockDeadLetterRepo.query).toHaveBeenCalledWith(
        { status: 'OPEN' },
        undefined,
        10,
      );
      expect(result.items).toHaveLength(1);
      expect(result.totalOpen).toBe(1);
    });

    it('gets a dead letter by ID', async () => {
      const item = await service.getById('dlq-111');
      expect(item.id).toBe('dlq-111');
    });

    it('throws NotFoundError when ID does not exist', async () => {
      vi.mocked(mockDeadLetterRepo.findById!).mockResolvedValueOnce(null);
      await expect(service.getById('non-existent')).rejects.toThrow(
        NotFoundError,
      );
    });
  });

  describe('redrive', () => {
    it('redrives an OPEN dead letter: resets attempts to 0, audits, and sets status to REDRIVEN', async () => {
      const redriven = await service.redrive('dlq-111', 'operator-1', {
        directPublish: true,
      });

      expect(redriven.status).toBe('REDRIVEN');
      expect(redriven.resolvedBy).toBe('operator-1');
      expect(mockDeadLetterRepo.updateStatus).toHaveBeenCalledWith(
        'dlq-111',
        'REDRIVEN',
        'operator-1',
      );
      expect(mockAuditRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'dlq.redrive',
          outcome: 'SUCCESS',
          actorId: 'operator-1',
        }),
      );
      expect(mockBroker.publish).toHaveBeenCalledWith(
        'replication',
        'file-abc',
        expect.objectContaining({
          attempt: 0,
        }),
      );
    });

    it('rejects redriving when dead letter is already REDRIVEN or DISCARDED', async () => {
      vi.mocked(mockDeadLetterRepo.findById!).mockResolvedValueOnce({
        ...sampleDeadLetter,
        status: 'REDRIVEN',
      });

      await expect(service.redrive('dlq-111', 'operator-1')).rejects.toThrow(
        ValidationError,
      );
    });
  });

  describe('discard', () => {
    it('discards an OPEN dead letter: sets status to DISCARDED and records audit trail', async () => {
      const discarded = await service.discard(
        'dlq-111',
        'operator-1',
        'Invalid poison pill',
      );

      expect(discarded.status).toBe('DISCARDED');
      expect(discarded.resolvedBy).toBe('operator-1');
      expect(mockDeadLetterRepo.updateStatus).toHaveBeenCalledWith(
        'dlq-111',
        'DISCARDED',
        'operator-1',
      );
      expect(mockAuditRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'dlq.discard',
          outcome: 'SUCCESS',
          actorId: 'operator-1',
          details: expect.objectContaining({
            reason: 'Invalid poison pill',
          }) as unknown as Record<string, unknown>,
        }),
      );
    });

    it('rejects discarding when dead letter is already DISCARDED', async () => {
      vi.mocked(mockDeadLetterRepo.findById!).mockResolvedValueOnce({
        ...sampleDeadLetter,
        status: 'DISCARDED',
      });

      await expect(
        service.discard('dlq-111', 'operator-1', 'Duplicate resolve'),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe('metrics: gus_dlq_depth', () => {
    it('returns depth of OPEN dead letters', async () => {
      vi.mocked(mockDeadLetterRepo.countOpen!).mockResolvedValueOnce(42);
      const depth = await service.getDlqDepth();
      expect(depth).toBe(42);
    });
  });
});
