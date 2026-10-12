import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { type Kysely, sql } from 'kysely';
import type { Pool } from 'pg';
import { AppConfigService } from '../config/config.service.js';
import { closePgPool, createPgPool } from './pool.js';
import { createKysely } from './kysely.js';
import type { Database } from './types.js';
import { runMigrations, createMigrator } from './migrate.js';

@Injectable()
export class DatabaseService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseService.name);
  private pool?: Pool;
  private db?: Kysely<Database>;

  constructor(private readonly configService: AppConfigService) {}

  async onModuleInit(): Promise<void> {
    const config = this.configService.raw;

    // UR-08: DB_ENABLED is forced true in production
    const dbEnabled = config.DB_ENABLED || config.NODE_ENV === 'production';

    if (dbEnabled) {
      this.initConnection();

      // UR-08: AUTO_MIGRATE defaults to true outside production, false in production
      const autoMigrate =
        config.AUTO_MIGRATE !== undefined
          ? config.AUTO_MIGRATE
          : config.NODE_ENV !== 'production';

      if (autoMigrate) {
        await this.autoMigrate();
      } else {
        await this.checkNoMigrationsPending();
      }
    }
  }

  /**
   * UR-08: In production (AUTO_MIGRATE=false), only verify no migrations are
   * pending. If any are pending, log them and exit non-zero so the pod fails fast.
   */
  private async checkNoMigrationsPending(): Promise<void> {
    if (!this.db) return;
    try {
      this.logger.log(
        'Checking for pending database migrations (AUTO_MIGRATE=false)...',
      );
      const migrator = createMigrator(this.db);
      const migrations = await migrator.getMigrations();
      const pending = migrations.filter(
        (m: { executedAt?: unknown }) => !m.executedAt,
      );
      if (pending.length > 0) {
        const names = pending.map((m: { name: string }) => m.name).join(', ');
        this.logger.error(
          `STARTUP FAILED: ${pending.length} pending migration(s) found. ` +
            `Run the migration Job before starting the application. ` +
            `Pending: ${names}`,
        );
        // Exit non-zero so Kubernetes restarts / prevents traffic
        process.exit(1);
      }
      this.logger.log('Database schema is up to date (no pending migrations).');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Migration check failed: ${message}`);
      throw err;
    }
  }

  /**
   * UR-08: Check if any migrations are pending without exiting.
   * Used by readiness probe (/health/ready).
   */
  async hasPendingMigrations(): Promise<boolean> {
    const config = this.configService.raw;
    const dbEnabled = config.DB_ENABLED || config.NODE_ENV === 'production';
    if (!dbEnabled) {
      return false;
    }
    const db = this.getDb();
    if (!db) {
      return false;
    }
    try {
      const migrator = createMigrator(db);
      const migrations = await migrator.getMigrations();
      return migrations.some(
        (m: { executedAt?: unknown }) => !m.executedAt,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Pending migrations check failed: ${message}`);
      return true;
    }
  }

  private async autoMigrate(): Promise<void> {
    if (!this.db) return;
    try {
      this.logger.log('Checking database migrations on startup...');
      const results = await runMigrations(this.db, { allowLockWait: true });
      const executed = results.filter((r) => r.status === 'Success');
      if (executed.length > 0) {
        this.logger.log(
          `Successfully applied ${executed.length} database migration(s): ${executed.map((e) => e.migrationName).join(', ')}`,
        );
      } else {
        this.logger.log('Database schema is up to date.');
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Automatic database migration failed: ${message}`);
      throw err;
    }
  }

  private initConnection(): void {
    if (this.pool) {
      return;
    }

    const { DATABASE_URL, DATABASE_POOL_MAX } = this.configService.raw;
    this.logger.log('Initializing PostgreSQL connection pool...');

    this.pool = createPgPool({
      connectionString: DATABASE_URL,
      max: DATABASE_POOL_MAX,
    });

    this.db = createKysely(this.pool);
  }

  getPool(): Pool | undefined {
    const config = this.configService.raw;
    const dbEnabled = config.DB_ENABLED || config.NODE_ENV === 'production';
    if (!this.pool && dbEnabled) {
      this.initConnection();
    }
    return this.pool;
  }

  getDb(): Kysely<Database> | undefined {
    const config = this.configService.raw;
    const dbEnabled = config.DB_ENABLED || config.NODE_ENV === 'production';
    if (!this.db && dbEnabled) {
      this.initConnection();
    }
    return this.db;
  }

  async ping(): Promise<boolean> {
    const config = this.configService.raw;
    const dbEnabled = config.DB_ENABLED || config.NODE_ENV === 'production';
    if (!dbEnabled) {
      return true;
    }

    try {
      const db = this.getDb();
      if (!db) {
        return false;
      }
      const result = await sql<{ ok: number }>`SELECT 1 AS ok`.execute(db);
      return result.rows.length > 0 && result.rows[0].ok === 1;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Database health check failed: ${message}`);
      return false;
    }
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    if (this.pool) {
      this.logger.log(
        `Closing PostgreSQL pool on signal: ${signal ?? 'shutdown'}`,
      );
      await closePgPool(this.pool);
      this.pool = undefined;
      this.db = undefined;
    }
  }
}
