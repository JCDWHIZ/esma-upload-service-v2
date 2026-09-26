import { Kysely, PostgresDialect, type Transaction } from 'kysely';
import type { Pool } from 'pg';
import type { Database } from './types.js';

export function createKysely(pool: Pool): Kysely<Database> {
  const dialect = new PostgresDialect({
    pool,
  });

  return new Kysely<Database>({
    dialect,
  });
}

export async function withTransaction<T>(
  db: Kysely<Database>,
  callback: (trx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(callback);
}
