import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE outbox_events (
      id            uuid        PRIMARY KEY,
      topic         text        NOT NULL,
      partition_key text        NOT NULL,
      event_type    text        NOT NULL,
      envelope      jsonb       NOT NULL,
      created_at    timestamptz NOT NULL DEFAULT now(),
      available_at  timestamptz NOT NULL DEFAULT now(),
      published_at  timestamptz,
      attempts      integer     NOT NULL DEFAULT 0,
      last_error    text
    );
  `.execute(db);

  await sql`
    CREATE INDEX outbox_unpublished_idx ON outbox_events (available_at, created_at)
    WHERE published_at IS NULL;
  `.execute(db);

  await sql`
    CREATE TABLE processed_events (
      consumer      text        NOT NULL,
      event_id      uuid        NOT NULL,
      processed_at  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (consumer, event_id)
    );
  `.execute(db);
}
