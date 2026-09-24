import { Pool, type PoolConfig } from 'pg';
import { Logger } from '@nestjs/common';

const logger = new Logger('PgPool');

export interface CreatePoolOptions {
  connectionString: string;
  max?: number;
  statementTimeoutMs?: number;
  idleTimeoutMs?: number;
  connectionTimeoutMs?: number;
}

export function createPgPool(options: CreatePoolOptions): Pool {
  const poolConfig: PoolConfig = {
    connectionString: options.connectionString,
    max: options.max ?? 10,
    idleTimeoutMillis: options.idleTimeoutMs ?? 30000,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 5000,
    statement_timeout: options.statementTimeoutMs ?? 30000,
  };

  const pool = new Pool(poolConfig);

  // Pool error listener prevents process crashes on idle client socket issues
  pool.on('error', (err: Error) => {
    logger.error(
      `Unexpected idle client error in PostgreSQL pool: ${err.message}`,
      err.stack,
    );
  });

  return pool;
}

export async function closePgPool(pool: Pool): Promise<void> {
  try {
    await pool.end();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`Error while draining PostgreSQL pool: ${message}`);
  }
}
