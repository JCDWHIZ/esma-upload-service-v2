import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. Quota table (UR-13)
  await sql`
    CREATE TABLE IF NOT EXISTS tenant_quota (
      tenant_id text PRIMARY KEY,
      plan_quota_bytes bigint,
      override_quota_bytes bigint,
      override_reason text,
      override_expires_at timestamptz,
      is_suspended boolean NOT NULL DEFAULT false,
      suspended_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `.execute(db);

  // 2. Retention and Legal Hold columns on files table (UR-14)
  await sql`
    ALTER TABLE files ADD COLUMN IF NOT EXISTS retain_until timestamptz;
  `.execute(db);

  await sql`
    ALTER TABLE files ADD COLUMN IF NOT EXISTS held boolean NOT NULL DEFAULT false;
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS files_retention_idx ON files (retain_until)
    WHERE retain_until IS NOT NULL AND status = 'ACTIVE' AND held = false;
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS files_held_idx ON files (tenant_id, held)
    WHERE held = true;
  `.execute(db);

  // 3. Correlation & Support Access audit columns (UR-09.4, UR-17)
  await sql`
    ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS trace_id text;
  `.execute(db);

  await sql`
    ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS act_sub text;
  `.execute(db);

  await sql`
    ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS support_grant_id text;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS tenant_quota;`.execute(db);
  await sql`DROP INDEX IF EXISTS files_retention_idx;`.execute(db);
  await sql`DROP INDEX IF EXISTS files_held_idx;`.execute(db);
  await sql`ALTER TABLE files DROP COLUMN IF EXISTS retain_until;`.execute(db);
  await sql`ALTER TABLE files DROP COLUMN IF EXISTS held;`.execute(db);
  await sql`ALTER TABLE audit_log DROP COLUMN IF EXISTS trace_id;`.execute(db);
  await sql`ALTER TABLE audit_log DROP COLUMN IF EXISTS act_sub;`.execute(db);
  await sql`ALTER TABLE audit_log DROP COLUMN IF EXISTS support_grant_id;`.execute(db);
}
