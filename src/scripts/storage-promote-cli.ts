import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { StoragePromoteService, StoragePromoteOptions } from '../storage/storage-promote.service.js';
import type { Provider } from '../core/types.js';

export function parsePromoteArgs(argv: string[]): StoragePromoteOptions {
  const args = argv.slice(2);
  let toProvider: Provider | undefined;
  let fromProvider: Provider | undefined;
  let namespace: string | undefined;
  let batchSize: number | undefined;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '--to' || arg === '-t') && args[i + 1]) {
      toProvider = args[++i] as Provider;
    } else if (arg.startsWith('--to=')) {
      toProvider = arg.split('=')[1] as Provider;
    } else if ((arg === '--from' || arg === '-f') && args[i + 1]) {
      fromProvider = args[++i] as Provider;
    } else if (arg.startsWith('--from=')) {
      fromProvider = arg.split('=')[1] as Provider;
    } else if ((arg === '--namespace' || arg === '-n') && args[i + 1]) {
      namespace = args[++i];
    } else if (arg.startsWith('--namespace=')) {
      namespace = arg.split('=')[1];
    } else if ((arg === '--batch-size' || arg === '-b') && args[i + 1]) {
      batchSize = parseInt(args[++i], 10);
    } else if (arg.startsWith('--batch-size=')) {
      batchSize = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--dry-run') {
      dryRun = true;
    }
  }

  if (!toProvider) {
    console.error(
      'Usage: npm run storage:promote -- --to <provider> [--from <provider>] [--namespace <ns>] [--batch-size <size>] [--dry-run]',
    );
    console.error('Error: --to <provider> is required.');
    process.exit(1);
  }

  return {
    toProvider,
    fromProvider,
    namespace,
    batchSize: batchSize && !isNaN(batchSize) ? batchSize : 100,
    dryRun,
  };
}

async function main() {
  const options = parsePromoteArgs(process.argv);
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const promoteService = app.get(StoragePromoteService);
    const result = await promoteService.promotePrimary(options);
    console.log('\n--- Storage Promotion Summary ---');
    console.log(`Scanned:                ${result.scanned}`);
    console.log(`Promoted:               ${result.promoted}`);
    console.log(`Skipped (Not Available):${result.skippedNotAvailable}`);
    console.log(`Already Primary:        ${result.alreadyPrimary}`);
    console.log(`Errors:                 ${result.errors}`);
  } catch (err) {
    console.error('Storage promotion failed:', err);
    process.exit(1);
  } finally {
    await app.close();
  }
}

if (process.env.NODE_ENV !== 'test') {
  void main();
}
