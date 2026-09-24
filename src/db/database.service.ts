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

@Injectable()
export class DatabaseService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseService.name);
  private pool?: Pool;
  private db?: Kysely<Database>;

  constructor(private readonly configService: AppConfigService) {}

  onModuleInit(): void {
    if (this.configService.raw.DB_ENABLED) {
      this.initConnection();
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
    if (!this.pool && this.configService.raw.DB_ENABLED) {
      this.initConnection();
    }
    return this.pool;
  }

  getDb(): Kysely<Database> | undefined {
    if (!this.db && this.configService.raw.DB_ENABLED) {
      this.initConnection();
    }
    return this.db;
  }

  async ping(): Promise<boolean> {
    if (!this.configService.raw.DB_ENABLED) {
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
