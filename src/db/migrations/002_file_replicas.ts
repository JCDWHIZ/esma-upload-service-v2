import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE file_replicas (
      file_id       uuid        NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      provider      text        NOT NULL CHECK (provider IN ('local', 'seaweedfs', 'cloudinary')),
      role          text        NOT NULL CHECK (role IN ('primary', 'secondary')),
      status        text        NOT NULL CHECK (status IN ('QUEUED', 'IN_PROGRESS', 'AVAILABLE', 'FAILED', 'DELETING', 'DELETED')),
      provider_key  text        NOT NULL,
      provider_meta jsonb       NOT NULL DEFAULT '{}'::jsonb,
      url           text,
      etag          text,
      attempts      integer     NOT NULL DEFAULT 0,
      last_error    text,
      synced_at     timestamptz,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (file_id, provider)
    );
  `.execute(db);

  await sql`
    CREATE INDEX file_replicas_work_idx ON file_replicas (status, updated_at)
    WHERE status IN ('QUEUED', 'IN_PROGRESS', 'FAILED', 'DELETING');
  `.execute(db);

  await sql`
    CREATE TRIGGER file_replicas_set_updated_at
    BEFORE UPDATE ON file_replicas
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
  `.execute(db);
}
