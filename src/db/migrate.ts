import { promises as fs } from 'fs';
import * as path from 'path';
import { type Kysely, sql } from 'kysely';
import {
  FileMigrationProvider,
  Migrator,
  type MigrationInfo,
  type MigrationResult,
} from 'kysely/migration';
import type { Database } from './types.js';
import { closePgPool, createPgPool } from './pool.js';
import { createKysely } from './kysely.js';

// BigInt advisory lock key for GUS migrations (hex 0x4755535F4D494752)
export const MIGRATION_LOCK_ID = '5138122394595213138';

export interface MigrationOptions {
  migrationFolder?: string;
  allowLockWait?: boolean;
}

function getMigrationFolder(): string {
  const distMigrations =
    typeof __dirname !== 'undefined' ? path.join(__dirname, 'migrations') : '';
  if (distMigrations && fsSync.existsSync(distMigrations)) {
    return distMigrations;
  }
  const srcMigrations = path.resolve(process.cwd(), 'src/db/migrations');
  if (fsSync.existsSync(srcMigrations)) {
    return srcMigrations;
  }
  if (distMigrations) {
    fsSync.mkdirSync(distMigrations, { recursive: true });
    return distMigrations;
  }
  fsSync.mkdirSync(srcMigrations, { recursive: true });
  return srcMigrations;
}

export function createMigrator(
  db: Kysely<Database>,
  options?: MigrationOptions,
): Migrator {
  const migrationFolder = options?.migrationFolder ?? getMigrationFolder();

  return new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder,
    }),
  });
}

export async function runMigrations(
  db: Kysely<Database>,
  options?: MigrationOptions,
): Promise<MigrationResult[]> {
  // Acquire PostgreSQL advisory lock to ensure serialized, concurrency-safe runs
  const lockQuery = options?.allowLockWait
    ? sql<{ acquired: boolean }>`
        SELECT pg_advisory_lock(${sql.lit(MIGRATION_LOCK_ID)}::bigint) AS locked, true AS acquired
      `
    : sql<{ acquired: boolean }>`
        SELECT pg_try_advisory_lock(${sql.lit(MIGRATION_LOCK_ID)}::bigint) AS acquired
      `;

  const lockResult = await lockQuery.execute(db);
  const acquired = lockResult.rows[0]?.acquired;

  if (!acquired) {
    throw new Error(
      'Could not acquire migration advisory lock. Another migration runner is currently active.',
    );
  }

  try {
    const migrator = createMigrator(db, options);
    const { error, results } = await migrator.migrateToLatest();

    if (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(JSON.stringify(error));
    }

    return results ?? [];
  } finally {
    // Release advisory lock
    await sql`SELECT pg_advisory_unlock(${sql.lit(MIGRATION_LOCK_ID)}::bigint)`.execute(
      db,
    );
  }
}

export async function getMigrationStatus(
  db: Kysely<Database>,
  options?: MigrationOptions,
): Promise<ReadonlyArray<MigrationInfo>> {
  const migrator = createMigrator(db, options);
  return migrator.getMigrations();
}

import * as fsSync from 'fs';

function loadEnvFile(): void {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fsSync.existsSync(envPath)) {
    const content = fsSync.readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if (!val.startsWith('"') && !val.startsWith("'")) {
          const commentIdx = val.indexOf('#');
          if (commentIdx > 0) val = val.slice(0, commentIdx).trim();
        } else if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
}

// CLI invocation helper
export async function cli(): Promise<void> {
  loadEnvFile();
  const command = process.argv[2] ?? 'status';
  const databaseUrl =
    process.env.DATABASE_URL || 'postgres://gus:gus@localhost:5432/gus';
  const pool = createPgPool({ connectionString: databaseUrl, max: 2 });
  const db = createKysely(pool);

  try {
    if (command === 'migrate') {
      const results = await runMigrations(db, { allowLockWait: true });
      for (const res of results) {
        if (res.status === 'Success') {
          process.stdout.write(
            `Migration "${res.migrationName}" executed successfully\n`,
          );
        } else if (res.status === 'Error') {
          process.stderr.write(`Migration "${res.migrationName}" failed\n`);
        }
      }
      if (results.length === 0) {
        process.stdout.write(
          'Database is already up to date. No migrations executed.\n',
        );
      }
    } else if (command === 'status') {
      const migrations = await getMigrationStatus(db);
      process.stdout.write('Migration Status:\n');
      for (const m of migrations) {
        const executedAt = m.executedAt
          ? m.executedAt.toISOString()
          : 'PENDING';
        process.stdout.write(`- ${m.name}: ${executedAt}\n`);
      }
      if (migrations.length === 0) {
        process.stdout.write('No migrations registered.\n');
      }
    } else {
      process.stderr.write(
        `Unknown command: ${command}. Use "migrate" or "status".\n`,
      );
      process.exitCode = 1;
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Migration error: ${message}\n`);
    process.exitCode = 1;
  } finally {
    await closePgPool(pool);
  }
}

// Execute if run directly from node or ts-node
const isDirectCli =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('migrate.ts') ||
    process.argv[1].endsWith('migrate.js'));

if (isDirectCli) {
  void cli();
}
