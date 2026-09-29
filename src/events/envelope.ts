import { v7 as uuidv7 } from 'uuid';
import type { RequestContext } from '../auth/context.js';

/**
 * Standard v2 event envelope adhering strictly to ARCH §8.1.
 */
export interface EventEnvelope<T = unknown> {
  readonly eventId: string; // UUIDv7, used for dedup
  readonly eventType: string; // see catalog
  readonly schemaVersion: number; // starts at 1
  readonly timestamp: string; // ISO 8601
  readonly correlationId: string;
  readonly causationId?: string; // eventId that caused this event
  readonly namespace: string;
  readonly tenantId: string;
  readonly partitionKey: string; // fileId (ADR-07)
  readonly attempt: number; // 0 on first delivery
  readonly payload: T;
}

export interface ContextLike {
  readonly correlationId: string;
  readonly namespace: string;
  readonly tenantId: string;
  readonly causationId?: string;
}

export interface CreateEnvelopeParams<T> {
  readonly eventType: string;
  readonly partitionKey: string;
  readonly payload: T;
  readonly context?: RequestContext | ContextLike;
  readonly eventId?: string;
  readonly schemaVersion?: number;
  readonly timestamp?: string;
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly namespace?: string;
  readonly tenantId?: string;
  readonly attempt?: number;
}

/**
 * Factory helper creating an EventEnvelope filling UUIDv7, ISO timestamps,
 * schemaVersion=1, and attempt=0 defaults from a RequestContext or explicit overrides.
 */
export function createEnvelope<T>(
  params: CreateEnvelopeParams<T>,
): EventEnvelope<T> {
  const ctx = params.context;
  const correlationId = params.correlationId ?? ctx?.correlationId ?? uuidv7();
  const namespace = params.namespace ?? ctx?.namespace ?? 'default';
  const tenantId = params.tenantId ?? ctx?.tenantId ?? 'default';
  const causationId =
    params.causationId ??
    (ctx && 'causationId' in ctx ? ctx.causationId : undefined);

  return {
    eventId: params.eventId ?? uuidv7(),
    eventType: params.eventType,
    schemaVersion: params.schemaVersion ?? 1,
    timestamp: params.timestamp ?? new Date().toISOString(),
    correlationId,
    ...(causationId ? { causationId } : {}),
    namespace,
    tenantId,
    partitionKey: params.partitionKey,
    attempt: params.attempt ?? 0,
    payload: params.payload,
  };
}
