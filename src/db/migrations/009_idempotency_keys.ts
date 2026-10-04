import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE idempotency_keys (
      tenant_id       text        NOT NULL,
      key             text        NOT NULL,
      request_hash    text        NOT NULL,
      status          text        NOT NULL CHECK (status IN ('IN_PROGRESS', 'COMPLETED')),
      response_status integer,
      response_body   jsonb,
      file_id         uuid,
      created_at      timestamptz NOT NULL DEFAULT now(),
      expires_at      timestamptz NOT NULL,
      PRIMARY KEY (tenant_id, key)
    );
  `.execute(db);

  await sql`
    CREATE INDEX idempotency_keys_expires_at_idx ON idempotency_keys (expires_at);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS idempotency_keys;`.execute(db);
}
