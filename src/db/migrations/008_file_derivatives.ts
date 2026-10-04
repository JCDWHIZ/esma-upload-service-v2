import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE files
    ADD COLUMN derivatives jsonb NOT NULL DEFAULT '{}'::jsonb;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE files
    DROP COLUMN IF EXISTS derivatives;
  `.execute(db);
}
