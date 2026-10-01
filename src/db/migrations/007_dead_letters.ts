import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE dead_letters (
      id              uuid        PRIMARY KEY,
      received_at     timestamptz NOT NULL DEFAULT now(),
      original_topic  text        NOT NULL,
      event_type      text        NOT NULL,
      event_id        text        NOT NULL,
      envelope        jsonb       NOT NULL,
      error           text        NOT NULL,
      attempts        integer     NOT NULL DEFAULT 1,
      status          text        NOT NULL CHECK (status IN ('OPEN', 'REDRIVEN', 'DISCARDED')) DEFAULT 'OPEN',
      resolved_at     timestamptz,
      resolved_by     text
    );
  `.execute(db);

  await sql`
    CREATE INDEX dead_letters_status_received_at_idx ON dead_letters (status, received_at DESC);
  `.execute(db);

  await sql`
    CREATE INDEX dead_letters_event_id_idx ON dead_letters (event_id);
  `.execute(db);

  await sql`
    CREATE INDEX dead_letters_received_at_id_idx ON dead_letters (received_at DESC, id DESC);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS dead_letters;`.execute(db);
}
