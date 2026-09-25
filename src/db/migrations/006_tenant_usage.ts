import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE tenant_usage (
      namespace   text        NOT NULL,
      tenant_id   text        NOT NULL,
      bytes_used  bigint      NOT NULL DEFAULT 0,
      file_count  bigint      NOT NULL DEFAULT 0,
      max_bytes   bigint,
      max_files   bigint,
      updated_at  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (namespace, tenant_id)
    );
  `.execute(db);

  await sql`
    CREATE TRIGGER tenant_usage_set_updated_at
    BEFORE UPDATE ON tenant_usage
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
  `.execute(db);
}
