import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE audit_log (
      id             uuid        PRIMARY KEY,
      occurred_at    timestamptz NOT NULL DEFAULT now(),
      action         text        NOT NULL,
      outcome        text        NOT NULL CHECK (outcome IN ('SUCCESS', 'DENIED', 'FAILURE')),
      actor_id       text        NOT NULL,
      actor_type     text        NOT NULL,
      roles          text[]      NOT NULL DEFAULT '{}',
      namespace      text        NOT NULL,
      tenant_id      text,
      file_id        uuid,
      ip_address     inet,
      user_agent     text,
      correlation_id text        NOT NULL,
      details        jsonb       NOT NULL DEFAULT '{}'::jsonb
    );
  `.execute(db);

  await sql`
    CREATE INDEX audit_tenant_time_idx ON audit_log (namespace, tenant_id, occurred_at DESC);
  `.execute(db);

  await sql`
    CREATE INDEX audit_file_idx ON audit_log (file_id, occurred_at DESC)
    WHERE file_id IS NOT NULL;
  `.execute(db);

  // If DB_APP_ROLE is set, enforce append-only security (INSERT, SELECT only; no UPDATE, DELETE, TRUNCATE)
  const appRole = process.env.DB_APP_ROLE?.trim();
  if (appRole && /^[a-zA-Z0-9_]+$/.test(appRole)) {
    await sql
      .raw(`REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM "${appRole}"`)
      .execute(db);
    await sql
      .raw(`GRANT INSERT, SELECT ON audit_log TO "${appRole}"`)
      .execute(db);
  }
}
