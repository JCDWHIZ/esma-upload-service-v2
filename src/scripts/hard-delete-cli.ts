/* eslint-disable no-console */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import {
  HardDeleteService,
  HardDeleteOptions,
} from '../files/hard-delete.service.js';

export function parseHardDeleteArgs(argv: string[]): HardDeleteOptions {
  const args = argv.slice(2);
  let fileId: string | undefined;
  let operator: string | undefined;
  let reason: string | undefined;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '--file-id' || arg === '-i') && args[i + 1]) {
      fileId = args[++i];
    } else if (arg.startsWith('--file-id=')) {
      fileId = arg.split('=')[1];
    } else if ((arg === '--operator' || arg === '-o') && args[i + 1]) {
      operator = args[++i];
    } else if (arg.startsWith('--operator=')) {
      operator = arg.split('=')[1];
    } else if ((arg === '--reason' || arg === '-r') && args[i + 1]) {
      reason = args[++i];
    } else if (arg.startsWith('--reason=')) {
      reason = arg.split('=')[1];
    } else if (arg === '--dry-run') {
      dryRun = true;
    }
  }

  if (!fileId) {
    console.error(
      'Usage: npm run file:hard-delete -- --file-id <fileId> [--operator <operator>] [--reason <reason>] [--dry-run]',
    );
    console.error('Error: --file-id <fileId> is required.');
    process.exit(1);
  }

  return {
    fileId,
    operator,
    reason,
    dryRun,
  };
}

async function main() {
  const options = parseHardDeleteArgs(process.argv);
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const hardDeleteService = app.get(HardDeleteService);
    const result = await hardDeleteService.hardDeleteFile(options);
    console.log('\n--- Hard-Delete / Legal Erasure Summary ---');
    console.log(`File ID:                ${result.fileId}`);
    console.log(`Replicas Purged:        ${result.replicasDeleted}`);
    console.log(`DB Records Deleted:     ${result.dbRecordsDeleted}`);
    console.log(`Audit Event Enqueued:   ${result.auditEventEnqueued}`);
  } catch (err) {
    console.error('Hard-delete operation failed:', err);
    process.exit(1);
  } finally {
    await app.close();
  }
}

if (process.env.NODE_ENV !== 'test') {
  void main();
}
