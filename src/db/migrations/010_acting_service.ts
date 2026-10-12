import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE files ADD COLUMN IF NOT EXISTS acting_service text;
  `.execute(db);

  await sql`
    ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS acting_service text;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE files DROP COLUMN IF EXISTS acting_service;
  `.execute(db);

  await sql`
    ALTER TABLE audit_log DROP COLUMN IF EXISTS acting_service;
  `.execute(db);
}
