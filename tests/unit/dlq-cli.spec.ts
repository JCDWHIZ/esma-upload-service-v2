import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseDlqArgs, executeDlqCli } from '../../src/scripts/dlq-cli.js';
import { DeadLetterService } from '../../src/events/dead-letter.service.js';

describe('DlqCli (P5-06)', () => {
  let mockDeadLetterService: Partial<DeadLetterService>;
  let mockApp: { get: (token: any) => any };

  beforeEach(() => {
    mockDeadLetterService = {
      list: vi.fn().mockResolvedValue({
        items: [
          {
            id: 'dlq-cli-1',
            status: 'OPEN',
            originalTopic: 'replication',
            eventType: 'file.replicate',
            attempts: 3,
            error: 'Test error',
          },
        ],
        totalOpen: 1,
        nextCursor: null,
      }),
      redrive: vi.fn().mockResolvedValue({
        id: 'dlq-cli-1',
        eventType: 'file.replicate',
        originalTopic: 'replication',
        status: 'REDRIVEN',
      }),
      discard: vi.fn().mockResolvedValue({
        id: 'dlq-cli-1',
        eventType: 'file.replicate',
        status: 'DISCARDED',
      }),
      getDlqDepth: vi.fn().mockResolvedValue(3),
    };

    mockApp = {
      get: vi.fn().mockReturnValue(mockDeadLetterService),
    };
  });

  describe('parseDlqArgs', () => {
    it('parses list command with flags', () => {
      const parsed = parseDlqArgs([
        'node',
        'dlq-cli.ts',
        'list',
        '--status',
        'open',
        '--topic',
        'replication',
        '--limit',
        '25',
      ]);

      expect(parsed.command).toBe('list');
      expect(parsed.status).toBe('OPEN');
      expect(parsed.topic).toBe('replication');
      expect(parsed.limit).toBe(25);
    });

    it('parses redrive command with positional id and --direct flag', () => {
      const parsed = parseDlqArgs([
        'node',
        'dlq-cli.ts',
        'redrive',
        'dlq-uuid-1',
        '--direct',
      ]);

      expect(parsed.command).toBe('redrive');
      expect(parsed.id).toBe('dlq-uuid-1');
      expect(parsed.direct).toBe(true);
    });

    it('parses discard command with --id and --reason flags', () => {
      const parsed = parseDlqArgs([
        'node',
        'dlq-cli.ts',
        'discard',
        '--id',
        'dlq-uuid-2',
        '--reason',
        'Manual operator discard',
      ]);

      expect(parsed.command).toBe('discard');
      expect(parsed.id).toBe('dlq-uuid-2');
      expect(parsed.reason).toBe('Manual operator discard');
    });
  });

  describe('executeDlqCli', () => {
    it('executes list command', async () => {
      const stdoutSpy = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation(() => true);

      const res = (await executeDlqCli(mockApp, {
        command: 'list',
        status: 'OPEN',
      })) as { items: unknown[]; totalOpen: number };

      expect(mockDeadLetterService.list).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'OPEN' }),
        undefined,
        20,
      );
      expect(res.items).toHaveLength(1);
      stdoutSpy.mockRestore();
    });

    it('executes redrive command', async () => {
      const stdoutSpy = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation(() => true);

      const res = (await executeDlqCli(mockApp, {
        command: 'redrive',
        id: 'dlq-cli-1',
      })) as { status: string };

      expect(mockDeadLetterService.redrive).toHaveBeenCalledWith(
        'dlq-cli-1',
        'cli:admin',
        { directPublish: undefined },
      );
      expect(res.status).toBe('REDRIVEN');
      stdoutSpy.mockRestore();
    });

    it('executes discard command', async () => {
      const stdoutSpy = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation(() => true);

      const res = (await executeDlqCli(mockApp, {
        command: 'discard',
        id: 'dlq-cli-1',
        reason: 'Discard reason',
      })) as { status: string };

      expect(mockDeadLetterService.discard).toHaveBeenCalledWith(
        'dlq-cli-1',
        'cli:admin',
        'Discard reason',
      );
      expect(res.status).toBe('DISCARDED');
      stdoutSpy.mockRestore();
    });

    it('executes stats command', async () => {
      const stdoutSpy = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation(() => true);

      const res = (await executeDlqCli(mockApp, {
        command: 'stats',
      })) as { gus_dlq_depth: number };

      expect(mockDeadLetterService.getDlqDepth).toHaveBeenCalled();
      expect(res.gus_dlq_depth).toBe(3);
      stdoutSpy.mockRestore();
    });
  });
});
