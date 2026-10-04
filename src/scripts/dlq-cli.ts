import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { DeadLetterService } from '../events/dead-letter.service.js';
import type { DeadLetterFilter, DeadLetterStatus } from '../core/types.js';

export interface DlqCliArgs {
  command: string;
  id?: string;
  status?: DeadLetterStatus;
  topic?: string;
  event?: string;
  limit?: number;
  cursor?: string;
  reason?: string;
  direct?: boolean;
}

export function parseDlqArgs(argv: string[]): DlqCliArgs {
  const args = argv.slice(2);
  const command = args[0] ?? 'help';
  const result: DlqCliArgs = { command };

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--id' && args[i + 1]) {
      result.id = args[++i];
    } else if (arg.startsWith('--id=')) {
      result.id = arg.split('=')[1];
    } else if (arg === '--status' && args[i + 1]) {
      result.status = args[++i].toUpperCase() as DeadLetterStatus;
    } else if (arg.startsWith('--status=')) {
      result.status = arg.split('=')[1].toUpperCase() as DeadLetterStatus;
    } else if (arg === '--topic' && args[i + 1]) {
      result.topic = args[++i];
    } else if (arg.startsWith('--topic=')) {
      result.topic = arg.split('=')[1];
    } else if (arg === '--event' && args[i + 1]) {
      result.event = args[++i];
    } else if (arg.startsWith('--event=')) {
      result.event = arg.split('=')[1];
    } else if (arg === '--limit' && args[i + 1]) {
      result.limit = parseInt(args[++i], 10);
    } else if (arg.startsWith('--limit=')) {
      result.limit = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--cursor' && args[i + 1]) {
      result.cursor = args[++i];
    } else if (arg === '--reason' && args[i + 1]) {
      result.reason = args[++i];
    } else if (arg.startsWith('--reason=')) {
      result.reason = arg.split('=')[1];
    } else if (arg === '--direct') {
      result.direct = true;
    } else if (!result.id && !arg.startsWith('-')) {
      // Positional ID
      result.id = arg;
    }
  }

  return result;
}

export async function executeDlqCli(
  app: { get: <T>(type: any) => T },
  args: DlqCliArgs,
): Promise<unknown> {
  const dlqService = app.get<DeadLetterService>(DeadLetterService);

  switch (args.command) {
    case 'list': {
      const filter: DeadLetterFilter = {
        status: args.status,
        originalTopic: args.topic,
        eventType: args.event,
      };
      const result = await dlqService.list(
        filter,
        args.cursor,
        args.limit ?? 20,
      );
      process.stdout.write(
        `Found ${result.items.length} dead letters (total open: ${result.totalOpen}):\n`,
      );
      for (const item of result.items) {
        process.stdout.write(
          `- [${item.status}] ID: ${item.id} | Topic: ${item.originalTopic} | Event: ${item.eventType} | Attempts: ${item.attempts} | Error: ${item.error}\n`,
        );
      }
      if (result.nextCursor) {
        process.stdout.write(`Next cursor: ${result.nextCursor}\n`);
      }
      return result;
    }

    case 'redrive': {
      if (!args.id) {
        throw new Error(
          'Dead letter ID is required for redrive. Usage: dlq:redrive <id> [--direct]',
        );
      }
      const redriven = await dlqService.redrive(args.id, 'cli:admin', {
        directPublish: args.direct,
      });
      process.stdout.write(
        `Dead letter ${redriven.id} (${redriven.eventType}) successfully REDRIVEN to ${redriven.originalTopic}\n`,
      );
      return redriven;
    }

    case 'discard': {
      if (!args.id) {
        throw new Error(
          'Dead letter ID is required for discard. Usage: dlq:discard <id> [--reason <reason>]',
        );
      }
      const discarded = await dlqService.discard(
        args.id,
        'cli:admin',
        args.reason ?? 'Discarded via CLI',
      );
      process.stdout.write(
        `Dead letter ${discarded.id} (${discarded.eventType}) successfully DISCARDED\n`,
      );
      return discarded;
    }

    case 'stats': {
      const depth = await dlqService.getDlqDepth();
      process.stdout.write(
        `DLQ Depth (metric gus_dlq_depth): ${depth} OPEN dead letters\n`,
      );
      return { gus_dlq_depth: depth };
    }

    case 'help':
    default: {
      process.stdout.write(`
DLQ Operations Tooling CLI

Usage:
  npm run dlq:list [--status OPEN|REDRIVEN|DISCARDED] [--topic <topic>] [--limit <n>]
  npm run dlq:redrive <id> [--direct]
  npm run dlq:discard <id> [--reason <reason>]
  npm run dlq:stats
`);
      return { help: true };
    }
  }
}

// Standalone runner
const isDirectCli =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('dlq-cli.ts') ||
    process.argv[1].endsWith('dlq-cli.js'));

if (isDirectCli) {
  void (async () => {
    try {
      const app = await NestFactory.createApplicationContext(AppModule, {
        logger: ['error', 'warn'],
      });
      const parsed = parseDlqArgs(process.argv);
      await executeDlqCli(app, parsed);
      await app.close();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`CLI Error: ${msg}\n`);
      process.exitCode = 1;
    }
  })();
}
