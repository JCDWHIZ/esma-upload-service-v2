export type Provider = 'local' | 'seaweedfs' | 'cloudinary';

export type FileVisibility = 'private' | 'tenant' | 'public';

export type FileStatus = 'ACTIVE' | 'QUARANTINED' | 'DELETING' | 'DELETED';

export type ScanStatus =
  'NOT_REQUIRED' | 'PENDING' | 'CLEAN' | 'INFECTED' | 'ERROR';

export type ReplicationStatus =
  'NOT_REQUIRED' | 'QUEUED' | 'IN_PROGRESS' | 'SYNCED' | 'PARTIAL' | 'FAILED';

export type ReplicaRole = 'primary' | 'secondary';

export type ReplicaStatus =
  'QUEUED' | 'IN_PROGRESS' | 'AVAILABLE' | 'FAILED' | 'DELETING' | 'DELETED';

export type AuditOutcome = 'SUCCESS' | 'DENIED' | 'FAILURE';

export type ApiClientStatus = 'ACTIVE' | 'REVOKED';

export interface FileRecord {
  id: string;
  namespace: string;
  tenantId: string;
  subTenantId: string | null;
  folder: string;
  storageKey: string;
  originalFilename: string;
  mimetype: string;
  declaredMimetype: string | null;
  sizeBytes: bigint;
  sha256: string | null;
  visibility: FileVisibility;
  status: FileStatus;
  scanStatus: ScanStatus;
  replicationStatus: ReplicationStatus;
  primaryProvider: Provider;
  uploadedBy: string;
  tags: string[];
  attributes: Record<string, unknown>;
  legacyPublicId: string | null;
  idempotencyKey: string | null;
  correlationId: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface NewFileRecord {
  id?: string;
  namespace: string;
  tenantId: string;
  subTenantId?: string | null;
  folder?: string;
  storageKey: string;
  originalFilename: string;
  mimetype: string;
  declaredMimetype?: string | null;
  sizeBytes: bigint | number | string;
  sha256?: string | null;
  visibility: FileVisibility;
  status?: FileStatus;
  scanStatus?: ScanStatus;
  replicationStatus?: ReplicationStatus;
  primaryProvider: Provider;
  uploadedBy: string;
  tags?: string[];
  attributes?: Record<string, unknown>;
  legacyPublicId?: string | null;
  idempotencyKey?: string | null;
  correlationId: string;
}

export interface FileListFilter {
  namespace: string;
  tenantId: string;
  subTenantId?: string | null;
  folder?: string;
  status?: FileStatus;
  visibility?: FileVisibility;
  tags?: string[];
}

export interface KeysetCursor {
  createdAt: Date;
  id: string;
}

export interface PaginatedResult<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface FileStatusUpdate {
  status?: FileStatus;
  scanStatus?: ScanStatus;
  replicationStatus?: ReplicationStatus;
  sha256?: string | null;
  attributes?: Record<string, unknown>;
}

export interface FileReplica {
  fileId: string;
  provider: Provider;
  role: ReplicaRole;
  status: ReplicaStatus;
  providerKey: string;
  providerMeta: Record<string, unknown>;
  url: string | null;
  etag: string | null;
  attempts: number;
  lastError: string | null;
  syncedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewFileReplica {
  fileId: string;
  provider: Provider;
  role: ReplicaRole;
  status?: ReplicaStatus;
  providerKey: string;
  providerMeta?: Record<string, unknown>;
  url?: string | null;
  etag?: string | null;
  attempts?: number;
  lastError?: string | null;
  syncedAt?: Date | null;
}

export interface ReplicaAvailableMeta {
  url?: string | null;
  etag?: string | null;
  providerMeta?: Record<string, unknown>;
}

export interface OutboxEvent {
  id: string;
  topic: string;
  partitionKey: string;
  eventType: string;
  envelope: Record<string, unknown>;
  createdAt: Date;
  availableAt: Date;
  publishedAt: Date | null;
  attempts: number;
  lastError: string | null;
}

export interface NewOutboxEvent {
  id?: string;
  topic: string;
  partitionKey: string;
  eventType: string;
  envelope: Record<string, unknown>;
  availableAt?: Date;
}

export interface ProcessedEvent {
  consumer: string;
  eventId: string;
  processedAt: Date;
}

export interface AuditLogEntry {
  id: string;
  occurredAt: Date;
  action: string;
  outcome: AuditOutcome;
  actorId: string;
  actorType: string;
  roles: string[];
  namespace: string;
  tenantId: string | null;
  fileId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  correlationId: string;
  details: Record<string, unknown>;
}

export interface NewAuditLogEntry {
  id?: string;
  occurredAt?: Date;
  action: string;
  outcome: AuditOutcome;
  actorId: string;
  actorType: string;
  roles?: string[];
  namespace: string;
  tenantId?: string | null;
  fileId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  correlationId: string;
  details?: Record<string, unknown>;
}

export interface AuditFilter {
  namespace?: string;
  tenantId?: string;
  actorId?: string;
  fileId?: string;
  action?: string;
  outcome?: AuditOutcome;
  from?: Date;
  to?: Date;
}

export interface ApiClient {
  id: string;
  name: string;
  keyPrefix: string;
  keyHash: string;
  namespace: string;
  tenantIds: string[];
  allowAnyTenant: boolean;
  scopes: string[];
  status: ApiClientStatus;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface NewApiClient {
  id?: string;
  name: string;
  keyPrefix: string;
  keyHash: string;
  namespace: string;
  tenantIds?: string[];
  allowAnyTenant?: boolean;
  scopes: string[];
  status?: ApiClientStatus;
  expiresAt?: Date | null;
}

export interface TenantUsage {
  namespace: string;
  tenantId: string;
  bytesUsed: bigint;
  fileCount: bigint;
  maxBytes: bigint | null;
  maxFiles: bigint | null;
  updatedAt: Date;
}
