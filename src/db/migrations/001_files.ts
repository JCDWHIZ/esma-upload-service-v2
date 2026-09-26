import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // Common trigger function for updated_at
  await sql`
    CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `.execute(db);

  await sql`
    CREATE TABLE files (
      id                 uuid        PRIMARY KEY,
      namespace          text        NOT NULL,
      tenant_id          text        NOT NULL,
      sub_tenant_id      text,
      folder             text        NOT NULL DEFAULT '',
      storage_key        text        NOT NULL,
      original_filename  text        NOT NULL,
      mimetype           text        NOT NULL,
      declared_mimetype  text,
      size_bytes         bigint      NOT NULL CHECK (size_bytes >= 0),
      sha256             char(64),
      visibility         text        NOT NULL CHECK (visibility IN ('private', 'tenant', 'public')),
      status             text        NOT NULL DEFAULT 'ACTIVE'
                         CHECK (status IN ('ACTIVE', 'QUARANTINED', 'DELETING', 'DELETED')),
      scan_status        text        NOT NULL DEFAULT 'NOT_REQUIRED'
                         CHECK (scan_status IN ('NOT_REQUIRED', 'PENDING', 'CLEAN', 'INFECTED', 'ERROR')),
      replication_status text        NOT NULL DEFAULT 'NOT_REQUIRED'
                         CHECK (replication_status IN ('NOT_REQUIRED', 'QUEUED', 'IN_PROGRESS', 'SYNCED', 'PARTIAL', 'FAILED')),
      primary_provider   text        NOT NULL CHECK (primary_provider IN ('local', 'seaweedfs', 'cloudinary')),
      uploaded_by        text        NOT NULL,
      tags               text[]      NOT NULL DEFAULT '{}',
      attributes         jsonb       NOT NULL DEFAULT '{}'::jsonb,
      legacy_public_id   text,
      idempotency_key    text,
      correlation_id     text        NOT NULL,
      version            integer     NOT NULL DEFAULT 1,
      created_at         timestamptz NOT NULL DEFAULT now(),
      updated_at         timestamptz NOT NULL DEFAULT now(),
      deleted_at         timestamptz
    );
  `.execute(db);

  await sql`
    CREATE UNIQUE INDEX files_legacy_public_id_uq ON files (legacy_public_id) WHERE legacy_public_id IS NOT NULL;
  `.execute(db);

  await sql`
    CREATE UNIQUE INDEX files_idem_uq ON files (namespace, tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
  `.execute(db);

  await sql`
    CREATE INDEX files_scope_created_idx ON files (namespace, tenant_id, sub_tenant_id, created_at DESC, id DESC) WHERE status <> 'DELETED';
  `.execute(db);

  await sql`
    CREATE INDEX files_folder_idx ON files (namespace, tenant_id, folder, created_at DESC);
  `.execute(db);

  await sql`
    CREATE INDEX files_sha_idx ON files (sha256) WHERE sha256 IS NOT NULL;
  `.execute(db);

  await sql`
    CREATE INDEX files_repl_pending_idx ON files (updated_at) WHERE replication_status IN ('QUEUED', 'IN_PROGRESS', 'PARTIAL');
  `.execute(db);

  await sql`
    CREATE INDEX files_deleting_idx ON files (updated_at) WHERE status = 'DELETING';
  `.execute(db);

  await sql`
    CREATE TRIGGER files_set_updated_at
    BEFORE UPDATE ON files
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
  `.execute(db);
}
