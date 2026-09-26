import type { Selectable } from 'kysely';
import type {
  FilesTable,
  FileReplicasTable,
  OutboxEventsTable,
  ProcessedEventsTable,
  AuditLogTable,
  ApiClientsTable,
  TenantUsageTable,
} from './types.js';
import type {
  FileRecord,
  FileReplica,
  OutboxEvent,
  ProcessedEvent,
  AuditLogEntry,
  ApiClient,
  TenantUsage,
  KeysetCursor,
} from '../core/types.js';

function toDate(val: Date | string): Date {
  return val instanceof Date ? val : new Date(val);
}

function toNullableDate(val: Date | string | null): Date | null {
  if (val === null || val === undefined) return null;
  return toDate(val);
}

function toBigInt(val: number | string | bigint): bigint {
  return typeof val === 'bigint' ? val : BigInt(val);
}

function toNullableBigInt(val: number | string | bigint | null): bigint | null {
  if (val === null || val === undefined) return null;
  return toBigInt(val);
}

export function mapFileRow(row: Selectable<FilesTable>): FileRecord {
  return {
    id: row.id,
    namespace: row.namespace,
    tenantId: row.tenant_id,
    subTenantId: row.sub_tenant_id,
    folder: row.folder,
    storageKey: row.storage_key,
    originalFilename: row.original_filename,
    mimetype: row.mimetype,
    declaredMimetype: row.declared_mimetype,
    sizeBytes: toBigInt(row.size_bytes),
    sha256: row.sha256,
    visibility: row.visibility,
    status: row.status,
    scanStatus: row.scan_status,
    replicationStatus: row.replication_status,
    primaryProvider: row.primary_provider,
    uploadedBy: row.uploaded_by,
    tags: Array.isArray(row.tags) ? row.tags : [],
    attributes: row.attributes ?? {},
    legacyPublicId: row.legacy_public_id,
    idempotencyKey: row.idempotency_key,
    correlationId: row.correlation_id,
    version: row.version,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
    deletedAt: toNullableDate(row.deleted_at),
  };
}

export function mapReplicaRow(row: Selectable<FileReplicasTable>): FileReplica {
  return {
    fileId: row.file_id,
    provider: row.provider,
    role: row.role,
    status: row.status,
    providerKey: row.provider_key,
    providerMeta: row.provider_meta ?? {},
    url: row.url,
    etag: row.etag,
    attempts: row.attempts,
    lastError: row.last_error,
    syncedAt: toNullableDate(row.synced_at),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

export function mapOutboxRow(row: Selectable<OutboxEventsTable>): OutboxEvent {
  return {
    id: row.id,
    topic: row.topic,
    partitionKey: row.partition_key,
    eventType: row.event_type,
    envelope: row.envelope ?? {},
    createdAt: toDate(row.created_at),
    availableAt: toDate(row.available_at),
    publishedAt: toNullableDate(row.published_at),
    attempts: row.attempts,
    lastError: row.last_error,
  };
}

export function mapProcessedEventRow(
  row: Selectable<ProcessedEventsTable>,
): ProcessedEvent {
  return {
    consumer: row.consumer,
    eventId: row.event_id,
    processedAt: toDate(row.processed_at),
  };
}

export function mapAuditRow(row: Selectable<AuditLogTable>): AuditLogEntry {
  return {
    id: row.id,
    occurredAt: toDate(row.occurred_at),
    action: row.action,
    outcome: row.outcome,
    actorId: row.actor_id,
    actorType: row.actor_type,
    roles: Array.isArray(row.roles) ? row.roles : [],
    namespace: row.namespace,
    tenantId: row.tenant_id,
    fileId: row.file_id,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    correlationId: row.correlation_id,
    details: row.details ?? {},
  };
}

export function mapApiClientRow(row: Selectable<ApiClientsTable>): ApiClient {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    keyHash: row.key_hash,
    namespace: row.namespace,
    tenantIds: Array.isArray(row.tenant_ids) ? row.tenant_ids : [],
    allowAnyTenant: row.allow_any_tenant,
    scopes: Array.isArray(row.scopes) ? row.scopes : [],
    status: row.status,
    expiresAt: toNullableDate(row.expires_at),
    lastUsedAt: toNullableDate(row.last_used_at),
    createdAt: toDate(row.created_at),
    revokedAt: toNullableDate(row.revoked_at),
  };
}

export function mapTenantUsageRow(
  row: Selectable<TenantUsageTable>,
): TenantUsage {
  return {
    namespace: row.namespace,
    tenantId: row.tenant_id,
    bytesUsed: toBigInt(row.bytes_used),
    fileCount: toBigInt(row.file_count),
    maxBytes: toNullableBigInt(row.max_bytes),
    maxFiles: toNullableBigInt(row.max_files),
    updatedAt: toDate(row.updated_at),
  };
}

export function encodeCursor(cursor: KeysetCursor): string {
  const payload = JSON.stringify({
    createdAt: cursor.createdAt.toISOString(),
    id: cursor.id,
  });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

export function decodeCursor(cursorStr: string): KeysetCursor | null {
  try {
    const raw = Buffer.from(cursorStr, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.createdAt !== 'string' || typeof obj.id !== 'string') {
      return null;
    }
    const createdAt = new Date(obj.createdAt);
    if (Number.isNaN(createdAt.getTime())) {
      return null;
    }
    return {
      createdAt,
      id: obj.id,
    };
  } catch {
    return null;
  }
}
