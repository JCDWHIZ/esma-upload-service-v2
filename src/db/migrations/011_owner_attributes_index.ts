import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE INDEX IF NOT EXISTS files_owner_attributes_idx
    ON files (tenant_id, namespace, (attributes->>'ownerType'), (attributes->>'ownerId'));
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP INDEX IF EXISTS files_owner_attributes_idx;
  `.execute(db);
}
