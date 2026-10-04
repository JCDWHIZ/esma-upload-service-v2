import { z } from 'zod';
import { PermanentError } from '../core/errors/app-error.js';
import type { EventEnvelope } from './envelope.js';

export const EVENT_TYPES = {
  FILE_REPLICATE: 'file.replicate',
  FILE_PURGE: 'file.purge',
  FILE_SCAN: 'file.scan',
  FILE_PROCESS: 'file.process',
  FILE_UPLOADED: 'file.uploaded',
  FILE_REPLICATED: 'file.replicated',
  FILE_REPLICATION_FAILED: 'file.replication_failed',
  FILE_DELETED: 'file.deleted',
  FILE_ERASED: 'file.erased',
  FILE_SCANNED: 'file.scanned',
  FILE_PROCESSED: 'file.processed',
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

export type EventKind = 'command' | 'event';

export type LogicalTopic = 'replication' | 'processing' | 'audit' | 'dlq';

export interface EventMetadata {
  readonly type: EventType;
  readonly kind: EventKind;
  readonly defaultTopic: LogicalTopic;
}

export const EVENT_CATALOG: Record<EventType, EventMetadata> = {
  [EVENT_TYPES.FILE_REPLICATE]: {
    type: EVENT_TYPES.FILE_REPLICATE,
    kind: 'command',
    defaultTopic: 'replication',
  },
  [EVENT_TYPES.FILE_PURGE]: {
    type: EVENT_TYPES.FILE_PURGE,
    kind: 'command',
    defaultTopic: 'replication',
  },
  [EVENT_TYPES.FILE_SCAN]: {
    type: EVENT_TYPES.FILE_SCAN,
    kind: 'command',
    defaultTopic: 'processing',
  },
  [EVENT_TYPES.FILE_PROCESS]: {
    type: EVENT_TYPES.FILE_PROCESS,
    kind: 'command',
    defaultTopic: 'processing',
  },
  [EVENT_TYPES.FILE_UPLOADED]: {
    type: EVENT_TYPES.FILE_UPLOADED,
    kind: 'event',
    defaultTopic: 'audit',
  },
  [EVENT_TYPES.FILE_REPLICATED]: {
    type: EVENT_TYPES.FILE_REPLICATED,
    kind: 'event',
    defaultTopic: 'audit',
  },
  [EVENT_TYPES.FILE_REPLICATION_FAILED]: {
    type: EVENT_TYPES.FILE_REPLICATION_FAILED,
    kind: 'event',
    defaultTopic: 'audit',
  },
  [EVENT_TYPES.FILE_DELETED]: {
    type: EVENT_TYPES.FILE_DELETED,
    kind: 'event',
    defaultTopic: 'audit',
  },
  [EVENT_TYPES.FILE_ERASED]: {
    type: EVENT_TYPES.FILE_ERASED,
    kind: 'event',
    defaultTopic: 'audit',
  },
  [EVENT_TYPES.FILE_SCANNED]: {
    type: EVENT_TYPES.FILE_SCANNED,
    kind: 'event',
    defaultTopic: 'audit',
  },
  [EVENT_TYPES.FILE_PROCESSED]: {
    type: EVENT_TYPES.FILE_PROCESSED,
    kind: 'event',
    defaultTopic: 'audit',
  },
};

// Zod schemas per ARCH §8.2
export const FileReplicatePayloadSchema = z.object({
  fileId: z.string().min(1),
  targetProvider: z.string().min(1),
});
export type FileReplicatePayload = z.infer<typeof FileReplicatePayloadSchema>;

export const FilePurgePayloadSchema = z.object({
  fileId: z.string().min(1),
});
export type FilePurgePayload = z.infer<typeof FilePurgePayloadSchema>;

export const FileScanPayloadSchema = z.object({
  fileId: z.string().min(1),
});
export type FileScanPayload = z.infer<typeof FileScanPayloadSchema>;

export const FileProcessPayloadSchema = z.object({
  fileId: z.string().min(1),
  operations: z.array(z.string().min(1)).min(1),
});
export type FileProcessPayload = z.infer<typeof FileProcessPayloadSchema>;

export const FileUploadedPayloadSchema = z.object({
  fileId: z.string().min(1),
  size: z.number().int().nonnegative(),
  mimetype: z.string().min(1),
  primaryProvider: z.string().min(1),
});
export type FileUploadedPayload = z.infer<typeof FileUploadedPayloadSchema>;

export const FileReplicatedPayloadSchema = z.object({
  fileId: z.string().min(1),
  provider: z.string().min(1),
});
export type FileReplicatedPayload = z.infer<typeof FileReplicatedPayloadSchema>;

export const FileReplicationFailedPayloadSchema = z.object({
  fileId: z.string().min(1),
  provider: z.string().min(1),
  error: z.string().min(1),
});
export type FileReplicationFailedPayload = z.infer<
  typeof FileReplicationFailedPayloadSchema
>;

export const FileDeletedPayloadSchema = z.object({
  fileId: z.string().min(1),
});
export type FileDeletedPayload = z.infer<typeof FileDeletedPayloadSchema>;

export const FileErasedPayloadSchema = z.object({
  fileId: z.string().min(1),
  tenantId: z.string().min(1),
  namespace: z.string().min(1),
  operator: z.string().min(1),
  reason: z.string().min(1),
  erasedAt: z.string().min(1),
});
export type FileErasedPayload = z.infer<typeof FileErasedPayloadSchema>;

export const FileScannedPayloadSchema = z.object({
  fileId: z.string().min(1),
  result: z.string().min(1),
  threat: z.string().optional(),
});
export type FileScannedPayload = z.infer<typeof FileScannedPayloadSchema>;

export const FileProcessedPayloadSchema = z.object({
  fileId: z.string().min(1),
  derivatives: z.array(z.unknown()),
});
export type FileProcessedPayload = z.infer<typeof FileProcessedPayloadSchema>;

export const EVENT_PAYLOAD_SCHEMAS = {
  [EVENT_TYPES.FILE_REPLICATE]: FileReplicatePayloadSchema,
  [EVENT_TYPES.FILE_PURGE]: FilePurgePayloadSchema,
  [EVENT_TYPES.FILE_SCAN]: FileScanPayloadSchema,
  [EVENT_TYPES.FILE_PROCESS]: FileProcessPayloadSchema,
  [EVENT_TYPES.FILE_UPLOADED]: FileUploadedPayloadSchema,
  [EVENT_TYPES.FILE_REPLICATED]: FileReplicatedPayloadSchema,
  [EVENT_TYPES.FILE_REPLICATION_FAILED]: FileReplicationFailedPayloadSchema,
  [EVENT_TYPES.FILE_DELETED]: FileDeletedPayloadSchema,
  [EVENT_TYPES.FILE_ERASED]: FileErasedPayloadSchema,
  [EVENT_TYPES.FILE_SCANNED]: FileScannedPayloadSchema,
  [EVENT_TYPES.FILE_PROCESSED]: FileProcessedPayloadSchema,
} as const;

export type EventPayloadMap = {
  [EVENT_TYPES.FILE_REPLICATE]: FileReplicatePayload;
  [EVENT_TYPES.FILE_PURGE]: FilePurgePayload;
  [EVENT_TYPES.FILE_SCAN]: FileScanPayload;
  [EVENT_TYPES.FILE_PROCESS]: FileProcessPayload;
  [EVENT_TYPES.FILE_UPLOADED]: FileUploadedPayload;
  [EVENT_TYPES.FILE_REPLICATED]: FileReplicatedPayload;
  [EVENT_TYPES.FILE_REPLICATION_FAILED]: FileReplicationFailedPayload;
  [EVENT_TYPES.FILE_DELETED]: FileDeletedPayload;
  [EVENT_TYPES.FILE_ERASED]: FileErasedPayload;
  [EVENT_TYPES.FILE_SCANNED]: FileScannedPayload;
  [EVENT_TYPES.FILE_PROCESSED]: FileProcessedPayload;
};

export const SUPPORTED_SCHEMA_VERSIONS = new Set<number>([1]);

/**
 * Validates and parses the payload for a given event type.
 * Throws PermanentError on unsupported schemaVersion or zod parse failure.
 */
export function parseEventPayload<K extends EventType>(
  eventType: K,
  payload: unknown,
  schemaVersion = 1,
): EventPayloadMap[K] {
  if (!SUPPORTED_SCHEMA_VERSIONS.has(schemaVersion)) {
    throw new PermanentError(
      `Unsupported schema version: ${schemaVersion} for event type ${eventType}`,
    );
  }

  const schema = EVENT_PAYLOAD_SCHEMAS[eventType];
  if (!schema) {
    throw new PermanentError(`Unknown event type: ${eventType}`);
  }

  const parseResult = schema.safeParse(payload);
  if (!parseResult.success) {
    throw new PermanentError(
      `Schema validation failed for event type "${eventType}": ${parseResult.error.message}`,
      { errors: parseResult.error.issues },
    );
  }

  return parseResult.data as EventPayloadMap[K];
}

const EnvelopeBaseSchema = z.object({
  eventId: z.string().min(1),
  eventType: z.string().min(1),
  schemaVersion: z.number().int().positive(),
  timestamp: z.string().min(1),
  correlationId: z.string().min(1),
  causationId: z.string().min(1).optional(),
  namespace: z.string().min(1),
  tenantId: z.string().min(1),
  partitionKey: z.string().min(1),
  attempt: z.number().int().nonnegative(),
  payload: z.unknown(),
});

/**
 * Parses a raw event envelope object (e.g. deserialized from JSON or broker message).
 * Validates envelope structure and payload against catalog schemas.
 * Throws PermanentError on any structural, version, or payload violation.
 */
export function parseEventEnvelope<T = unknown>(
  raw: unknown,
): EventEnvelope<T> {
  const envelopeResult = EnvelopeBaseSchema.safeParse(raw);
  if (!envelopeResult.success) {
    throw new PermanentError(
      `Invalid event envelope structure: ${envelopeResult.error.message}`,
      { errors: envelopeResult.error.issues },
    );
  }

  const data = envelopeResult.data;
  if (!SUPPORTED_SCHEMA_VERSIONS.has(data.schemaVersion)) {
    throw new PermanentError(
      `Unsupported schema version ${data.schemaVersion} for eventId ${data.eventId}`,
    );
  }

  const eventType = data.eventType as EventType;
  if (!EVENT_PAYLOAD_SCHEMAS[eventType]) {
    throw new PermanentError(
      `Unknown event type "${data.eventType}" for eventId ${data.eventId}`,
    );
  }

  const validatedPayload = parseEventPayload(
    eventType,
    data.payload,
    data.schemaVersion,
  );

  return {
    eventId: data.eventId,
    eventType: data.eventType,
    schemaVersion: data.schemaVersion,
    timestamp: data.timestamp,
    correlationId: data.correlationId,
    causationId: data.causationId,
    namespace: data.namespace,
    tenantId: data.tenantId,
    partitionKey: data.partitionKey,
    attempt: data.attempt,
    payload: validatedPayload as unknown as T,
  };
}
