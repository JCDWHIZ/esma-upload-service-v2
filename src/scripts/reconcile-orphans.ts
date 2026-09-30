import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { StorageRegistry } from '../storage/registry.js';
import { DatabaseService } from '../db/database.service.js';
import type { Provider } from '../core/types.js';

export interface OrphanReconcileOptions {
  driver: string;
  prefix: string;
  fix: boolean;
}

export interface OrphanReconcileResult {
  orphansFound: number;
  orphansFixed: number;
  missingDbObjects: number;
}

export function parseReconcileArgs(argv: string[]): OrphanReconcileOptions {
  const args = argv.slice(2);
  const result: OrphanReconcileOptions = {
    driver: 'all',
    prefix: '',
    fix: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '--driver' || arg === '-d') && args[i + 1]) {
      result.driver = args[++i];
    } else if (arg.startsWith('--driver=')) {
      result.driver = arg.split('=')[1];
    } else if ((arg === '--prefix' || arg === '-p') && args[i + 1]) {
      result.prefix = args[++i];
    } else if (arg.startsWith('--prefix=')) {
      result.prefix = arg.split('=')[1];
    } else if (arg === '--fix') {
      result.fix = true;
    }
  }

  return result;
}

export async function executeReconcileOrphans(
  app: { get: <T>(type: any) => T },
  options: OrphanReconcileOptions,
): Promise<OrphanReconcileResult> {
  const storageRegistry = app.get<StorageRegistry>(StorageRegistry);
  const dbService = app.get<DatabaseService>(DatabaseService);

  const db = dbService.getDb();
  if (!db) {
    throw new Error('Database service is unavailable');
  }

  const result: OrphanReconcileResult = {
    orphansFound: 0,
    orphansFixed: 0,
    missingDbObjects: 0,
  };

  const allDrivers: Provider[] = ['local', 'seaweedfs', 'cloudinary'];
  const driversToScan: Provider[] =
    options.driver === 'all' ? allDrivers : [options.driver as Provider];

  const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();

  for (const provider of driversToScan) {
    if (!storageRegistry.has(provider)) {
      continue;
    }

    const driver = storageRegistry.get(provider);
    if (!driver.isConfigured()) {
      continue;
    }

    // 1. Scan driver for orphaned objects (objects on driver without DB replica record)
    if (typeof driver.list === 'function') {
      try {
        const paged = await driver.list(options.prefix, { limit: 500 });
        for (const item of paged.items) {
          // Check if replica row or file record exists in DB
          const replicaRows = await db
            .selectFrom('file_replicas')
            .select(['file_id', 'status'])
            .where('provider', '=', provider)
            .where('provider_key', '=', item.key)
            .execute();

          const fileRows = await db
            .selectFrom('files')
            .select(['id', 'status'])
            .where('storage_key', '=', item.key)
            .execute();

          const hasReplica = replicaRows.length > 0;
          const hasFile = fileRows.length > 0;

          if (!hasReplica && !hasFile) {
            result.orphansFound++;
            const itemAgeMs = item.lastModified
              ? now - item.lastModified.getTime()
              : TWENTY_FOUR_HOURS_MS + 1000;
            const ageHours = Math.round(itemAgeMs / 3600000);

            if (options.fix && itemAgeMs > TWENTY_FOUR_HOURS_MS) {
              try {
                await driver.delete({ provider, key: item.key });
                result.orphansFixed++;
                process.stdout.write(
                  `[FIXED] Deleted orphan object '${item.key}' on '${provider}' (age: ${ageHours}h)\n`,
                );
              } catch (err: unknown) {
                process.stderr.write(
                  `[ERROR] Failed to fix orphan object '${item.key}' on '${provider}': ${String(err)}\n`,
                );
              }
            } else {
              process.stdout.write(
                `[ORPHAN DETECTED] Key '${item.key}' on '${provider}' has no DB record (size: ${item.size}, age: ${ageHours}h${itemAgeMs <= TWENTY_FOUR_HOURS_MS ? ' - spared (<24h)' : ''})\n`,
              );
            }
          }
        }
      } catch (err: unknown) {
        process.stderr.write(
          `[WARN] Could not list objects on driver '${provider}': ${String(err)}\n`,
        );
      }
    }

    // 2. Sampled drift check (DB replicas whose physical object is missing on driver)
    const sampledReplicas = await db
      .selectFrom('file_replicas')
      .selectAll()
      .where('provider', '=', provider)
      .where('status', '=', 'AVAILABLE')
      .limit(100)
      .execute();

    for (const replicaRow of sampledReplicas) {
      try {
        const ref = {
          provider,
          key: replicaRow.provider_key,
          meta: replicaRow.provider_meta ?? {},
        };
        const stat = await driver.stat(ref);
        if (!stat) {
          result.missingDbObjects++;
          process.stdout.write(
            `[DRIFT DETECTED] DB replica '${replicaRow.file_id}' on '${provider}' has key '${replicaRow.provider_key}' but storage stat returned null\n`,
          );
        }
      } catch {
        // Driver I/O error
      }
    }
  }

  return result;
}

async function main(): Promise<void> {
  const options = parseReconcileArgs(process.argv);
  process.stdout.write(
    `ESMA Upload Service v2 - Orphan Storage Reconciler\n` +
      `====================================================\n` +
      `Target Driver: ${options.driver}\n` +
      `Prefix Filter: '${options.prefix}'\n` +
      `Fix Mode: ${options.fix ? 'ENABLED (--fix)' : 'DISABLED (dry-run report only)'}\n\n`,
  );

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });

  try {
    const summary = await executeReconcileOrphans(app, options);
    process.stdout.write(
      `\nReconciliation Summary:\n` +
        `  - Orphans Found: ${summary.orphansFound}\n` +
        `  - Orphans Fixed: ${summary.orphansFixed}\n` +
        `  - Missing DB Objects (Drift): ${summary.missingDbObjects}\n`,
    );
  } finally {
    await app.close();
  }
}

if (
  process.argv[1] &&
  (process.argv[1].endsWith('reconcile-orphans.js') ||
    process.argv[1].endsWith('reconcile-orphans.ts'))
) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `Fatal error during orphan reconciliation: ${String(err)}\n`,
    );
    process.exit(1);
  });
}
