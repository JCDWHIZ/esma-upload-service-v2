import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE api_clients (
      id               uuid        PRIMARY KEY,
      name             text        NOT NULL,
      key_prefix       text        NOT NULL UNIQUE,
      key_hash         text        NOT NULL,
      namespace        text        NOT NULL,
      tenant_ids       text[]      NOT NULL DEFAULT '{}',
      allow_any_tenant boolean     NOT NULL DEFAULT false,
      scopes           text[]      NOT NULL,
      status           text        NOT NULL DEFAULT 'ACTIVE'
                       CHECK (status IN ('ACTIVE', 'REVOKED')),
      expires_at       timestamptz,
      last_used_at     timestamptz,
      created_at       timestamptz NOT NULL DEFAULT now(),
      revoked_at       timestamptz
    );
  `.execute(db);
}
