import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. Drop existing files_scan_status_check constraint if it exists
  await sql`
    ALTER TABLE files DROP CONSTRAINT IF EXISTS files_scan_status_check;
  `.execute(db);

  // 2. Migrate existing NOT_REQUIRED to SKIPPED
  await sql`
    UPDATE files SET scan_status = 'SKIPPED' WHERE scan_status = 'NOT_REQUIRED';
  `.execute(db);

  // 3. Set default to SKIPPED
  await sql`
    ALTER TABLE files ALTER COLUMN scan_status SET DEFAULT 'SKIPPED';
  `.execute(db);

  // 4. Add updated check constraint allowing both SKIPPED and canonical values
  await sql`
    ALTER TABLE files ADD CONSTRAINT files_scan_status_check
      CHECK (scan_status IN ('SKIPPED', 'NOT_REQUIRED', 'PENDING', 'CLEAN', 'INFECTED', 'ERROR'));
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE files DROP CONSTRAINT IF EXISTS files_scan_status_check;
  `.execute(db);

  await sql`
    UPDATE files SET scan_status = 'NOT_REQUIRED' WHERE scan_status = 'SKIPPED';
  `.execute(db);

  await sql`
    ALTER TABLE files ALTER COLUMN scan_status SET DEFAULT 'NOT_REQUIRED';
  `.execute(db);

  await sql`
    ALTER TABLE files ADD CONSTRAINT files_scan_status_check
      CHECK (scan_status IN ('NOT_REQUIRED', 'PENDING', 'CLEAN', 'INFECTED', 'ERROR'));
  `.execute(db);
}
