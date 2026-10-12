import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. Tenant purge state columns on tenant_quota (UR-18)
  await sql`
    ALTER TABLE tenant_quota ADD COLUMN IF NOT EXISTS is_purging boolean NOT NULL DEFAULT false;
  `.execute(db);

  await sql`
    ALTER TABLE tenant_quota ADD COLUMN IF NOT EXISTS purged_at timestamptz;
  `.execute(db);

  // 2. Daily tenant egress tracking table (UR-23)
  await sql`
    CREATE TABLE IF NOT EXISTS tenant_daily_egress (
      tenant_id text NOT NULL,
      usage_date date NOT NULL,
      bytes_served bigint NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, usage_date)
    );
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS tenant_daily_egress_date_idx ON tenant_daily_egress (usage_date);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE tenant_quota DROP COLUMN IF EXISTS is_purging;`.execute(db);
  await sql`ALTER TABLE tenant_quota DROP COLUMN IF EXISTS purged_at;`.execute(db);
  await sql`DROP TABLE IF EXISTS tenant_daily_egress;`.execute(db);
}
