import type { ColumnType, Generated } from 'kysely';

export type Timestamp = ColumnType<
  Date,
  Date | string | undefined,
  Date | string
>;

export type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;

export interface FilesTable {
  id: string; // uuid
  namespace: string;
  tenant_id: string;
  sub_tenant_id: string | null;
  folder: Generated<string>;
  storage_key: string;
  original_filename: string;
  mimetype: string;
  declared_mimetype: string | null;
  size_bytes: number | string; // bigint
  sha256: string | null;
  visibility: 'private' | 'tenant' | 'public';
  status: Generated<'ACTIVE' | 'QUARANTINED' | 'DELETING' | 'DELETED'>;
  scan_status: Generated<
    'NOT_REQUIRED' | 'PENDING' | 'CLEAN' | 'INFECTED' | 'ERROR'
  >;
  replication_status: Generated<
    'NOT_REQUIRED' | 'QUEUED' | 'IN_PROGRESS' | 'SYNCED' | 'PARTIAL' | 'FAILED'
  >;
  primary_provider: 'local' | 'seaweedfs' | 'cloudinary';
  uploaded_by: string;
  tags: Generated<string[]>;
  attributes: Generated<Record<string, unknown>>;
  legacy_public_id: string | null;
  idempotency_key: string | null;
  correlation_id: string;
  version: Generated<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
  deleted_at: NullableTimestamp;
}

export interface FileReplicasTable {
  file_id: string;
  provider: 'local' | 'seaweedfs' | 'cloudinary';
  role: 'primary' | 'secondary';
  status:
    'QUEUED' | 'IN_PROGRESS' | 'AVAILABLE' | 'FAILED' | 'DELETING' | 'DELETED';
  provider_key: string;
  provider_meta: Generated<Record<string, unknown>>;
  url: string | null;
  etag: string | null;
  attempts: Generated<number>;
  last_error: string | null;
  synced_at: NullableTimestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface OutboxEventsTable {
  id: string;
  topic: string;
  partition_key: string;
  event_type: string;
  envelope: Record<string, unknown>;
  created_at: Timestamp;
  available_at: Timestamp;
  published_at: NullableTimestamp;
  attempts: Generated<number>;
  last_error: string | null;
}

export interface ProcessedEventsTable {
  consumer: string;
  event_id: string;
  processed_at: Timestamp;
}

export interface AuditLogTable {
  id: string;
  occurred_at: Timestamp;
  action: string;
  outcome: 'SUCCESS' | 'DENIED' | 'FAILURE';
  actor_id: string;
  actor_type: string;
  roles: Generated<string[]>;
  namespace: string;
  tenant_id: string | null;
  file_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  correlation_id: string;
  details: Generated<Record<string, unknown>>;
}

export interface ApiClientsTable {
  id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  namespace: string;
  tenant_ids: Generated<string[]>;
  allow_any_tenant: Generated<boolean>;
  scopes: string[];
  status: Generated<'ACTIVE' | 'REVOKED'>;
  expires_at: NullableTimestamp;
  last_used_at: NullableTimestamp;
  created_at: Timestamp;
  revoked_at: NullableTimestamp;
}

export interface TenantUsageTable {
  namespace: string;
  tenant_id: string;
  bytes_used: Generated<number | string>;
  file_count: Generated<number | string>;
  max_bytes: number | string | null;
  max_files: number | string | null;
  updated_at: Timestamp;
}

export interface Database {
  files: FilesTable;
  file_replicas: FileReplicasTable;
  outbox_events: OutboxEventsTable;
  processed_events: ProcessedEventsTable;
  audit_log: AuditLogTable;
  api_clients: ApiClientsTable;
  tenant_usage: TenantUsageTable;
}
