/* eslint-disable @typescript-eslint/unbound-method */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OutboxRetentionService } from '../../src/events/outbox-retention.service.js';
import type { AppConfigService } from '../../src/config/config.service.js';
import type { DatabaseService } from '../../src/db/database.service.js';
import type { OutboxRepository } from '../../src/db/repositories/outbox.repository.js';

describe('OutboxRetentionService', () => {
  let service: OutboxRetentionService;
  let outboxRepo: OutboxRepository;
  let configService: AppConfigService;
  let databaseService: DatabaseService;

  beforeEach(() => {
    outboxRepo = {
      deletePublishedOlderThan: vi.fn().mockResolvedValue(3),
    } as unknown as OutboxRepository;

    configService = {
      outboxRetentionHours: 72,
    } as unknown as AppConfigService;

    databaseService = {
      getDb: vi.fn().mockReturnValue({}),
    } as unknown as DatabaseService;

    service = new OutboxRetentionService(
      configService,
      databaseService,
      outboxRepo,
    );
  });

  afterEach(() => {
    service.stop();
  });

  it('calls deletePublishedOlderThan with correct cutoff', async () => {
    const before = Date.now();
    const deleted = await service.sweep();

    expect(deleted).toBe(3);
    expect(outboxRepo.deletePublishedOlderThan).toHaveBeenCalledOnce();

    const [cutoffArg, limitArg] = (
      outboxRepo.deletePublishedOlderThan as ReturnType<typeof vi.fn>
    ).mock.calls[0] as [Date, number];

    // cutoff should be ~72 hours ago
    const expectedMs = before - 72 * 60 * 60 * 1000;
    expect(cutoffArg.getTime()).toBeGreaterThanOrEqual(expectedMs - 1000);
    expect(cutoffArg.getTime()).toBeLessThanOrEqual(expectedMs + 1000);
    expect(limitArg).toBe(1000);
  });

  it('returns 0 when database is unavailable', async () => {
    (databaseService.getDb as ReturnType<typeof vi.fn>).mockReturnValue(
      undefined,
    );
    const deleted = await service.sweep();
    expect(deleted).toBe(0);
    expect(outboxRepo.deletePublishedOlderThan).not.toHaveBeenCalled();
  });

  it('returns 0 and logs on repository error without throwing', async () => {
    (
      outboxRepo.deletePublishedOlderThan as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error('DB error'));
    const deleted = await service.sweep();
    expect(deleted).toBe(0);
  });

  it('respects configService.outboxRetentionHours', async () => {
    configService = { outboxRetentionHours: 24 } as unknown as AppConfigService;
    service = new OutboxRetentionService(
      configService,
      databaseService,
      outboxRepo,
    );

    const before = Date.now();
    await service.sweep();

    const [cutoffArg] = (
      outboxRepo.deletePublishedOlderThan as ReturnType<typeof vi.fn>
    ).mock.calls[0] as [Date];

    const expected = before - 24 * 60 * 60 * 1000;
    expect(cutoffArg.getTime()).toBeGreaterThanOrEqual(expected - 1000);
    expect(cutoffArg.getTime()).toBeLessThanOrEqual(expected + 1000);
  });
});
