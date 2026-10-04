import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DlqController } from '../../src/admin/dlq.controller.js';
import type { DeadLetterService } from '../../src/events/dead-letter.service.js';
import type { AuthenticatedHttpRequest } from '../../src/auth/context.js';
import type { DeadLetterRecord } from '../../src/core/types.js';

describe('DlqController (P5-06)', () => {
  let controller: DlqController;
  let mockDeadLetterService: Partial<DeadLetterService>;

  const sampleRecord: DeadLetterRecord = {
    id: 'dlq-456',
    receivedAt: new Date('2026-10-01T10:00:00Z'),
    originalTopic: 'replication',
    eventType: 'file.replicate',
    eventId: 'evt-456',
    envelope: { eventId: 'evt-456', attempt: 3 },
    error: 'Max retries exhausted',
    attempts: 3,
    status: 'OPEN',
    resolvedAt: null,
    resolvedBy: null,
  };

  beforeEach(() => {
    mockDeadLetterService = {
      list: vi.fn().mockResolvedValue({
        items: [sampleRecord],
        nextCursor: null,
        hasMore: false,
        totalOpen: 1,
      }),
      getDlqDepth: vi.fn().mockResolvedValue(5),
      getById: vi.fn().mockResolvedValue(sampleRecord),
      redrive: vi.fn().mockResolvedValue({
        ...sampleRecord,
        status: 'REDRIVEN',
        resolvedBy: 'admin-user',
        resolvedAt: new Date(),
      }),
      discard: vi.fn().mockResolvedValue({
        ...sampleRecord,
        status: 'DISCARDED',
        resolvedBy: 'admin-user',
        resolvedAt: new Date(),
      }),
    };

    controller = new DlqController(mockDeadLetterService as DeadLetterService);
  });

  it('GET /api/v1/admin/dlq lists dead letters with filters and pagination', async () => {
    const res = await controller.list({
      status: 'OPEN',
      originalTopic: 'replication',
      limit: 10,
    });

    expect(mockDeadLetterService.list).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'OPEN',
        originalTopic: 'replication',
      }),
      undefined,
      10,
    );
    expect(res.items).toHaveLength(1);
    expect(res.totalOpen).toBe(1);
  });

  it('GET /api/v1/admin/dlq/stats returns gus_dlq_depth metric', async () => {
    const stats = await controller.getStats();

    expect(stats.metric).toBe('gus_dlq_depth');
    expect(stats.openCount).toBe(5);
    expect(stats.timestamp).toBeDefined();
  });

  it('GET /api/v1/admin/dlq/:id returns record details', async () => {
    const res = await controller.getById('dlq-456');

    expect(mockDeadLetterService.getById).toHaveBeenCalledWith('dlq-456');
    expect(res.id).toBe('dlq-456');
  });

  it('POST /api/v1/admin/dlq/:id/redrive triggers redrive with actor context', async () => {
    const req = {
      ctx: {
        actor: { id: 'admin-123' },
      },
    } as AuthenticatedHttpRequest;

    const res = await controller.redrive(
      'dlq-456',
      { directPublish: true },
      req,
    );

    expect(mockDeadLetterService.redrive).toHaveBeenCalledWith(
      'dlq-456',
      'admin-123',
      { directPublish: true },
    );
    expect(res.message).toContain('redriven successfully');
    expect(res.deadLetter.status).toBe('REDRIVEN');
  });

  it('POST /api/v1/admin/dlq/:id/discard triggers discard with actor context', async () => {
    const req = {
      ctx: {
        actor: { id: 'admin-123' },
      },
    } as AuthenticatedHttpRequest;

    const res = await controller.discard(
      'dlq-456',
      { reason: 'Poisonous payload' },
      req,
    );

    expect(mockDeadLetterService.discard).toHaveBeenCalledWith(
      'dlq-456',
      'admin-123',
      'Poisonous payload',
    );
    expect(res.message).toContain('discarded successfully');
    expect(res.deadLetter.status).toBe('DISCARDED');
  });
});
