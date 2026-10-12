import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE files ADD COLUMN IF NOT EXISTS claimed boolean NOT NULL DEFAULT false;
  `.execute(db);

  await sql`
    ALTER TABLE files ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
  `.execute(db);

  await sql`
    ALTER TABLE files ADD COLUMN IF NOT EXISTS unclaimed_expires_at timestamptz;
  `.execute(db);

  // Mark all existing rows as claimed = true so pre-existing files are never swept
  await sql`
    UPDATE files SET claimed = true, claimed_at = created_at WHERE claimed = false;
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS idx_files_unclaimed_sweep
      ON files (unclaimed_expires_at)
      WHERE claimed = false;
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS idx_files_unclaimed_user
      ON files (tenant_id, uploaded_by)
      WHERE claimed = false;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP INDEX IF EXISTS idx_files_unclaimed_sweep;
  `.execute(db);

  await sql`
    DROP INDEX IF EXISTS idx_files_unclaimed_user;
  `.execute(db);

  await sql`
    ALTER TABLE files DROP COLUMN IF EXISTS unclaimed_expires_at;
  `.execute(db);

  await sql`
    ALTER TABLE files DROP COLUMN IF EXISTS claimed_at;
  `.execute(db);

  await sql`
    ALTER TABLE files DROP COLUMN IF EXISTS claimed;
  `.execute(db);
}
