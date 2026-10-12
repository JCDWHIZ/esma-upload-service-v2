import { Injectable, Logger } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../db/types.js';
import { OutboxWriter } from './outbox-writer.js';
import type { RequestContext } from '../core/request-context.js';
import { getCorrelationId } from '../observability/correlation-context.js';

export const PUBLIC_DOMAIN_TOPIC = 'esma.files.events.v1';

export type PublicDomainEventType =
  | 'file.uploaded.v1'
  | 'file.scanned.v1'
  | 'file.deleted.v1'
  | 'file.claimed.v1'
  | 'file.quota.threshold.v1'
  | 'files.tenant.exported.v1';

export interface DomainEventActor {
  type: 'USER' | 'SERVICE' | 'SYSTEM';
  id: string;
  actingService: string | null;
}

export interface DomainEventEnvelope<T = unknown> {
  eventId: string;
  eventType: PublicDomainEventType;
  occurredAt: string;
  organizationId: string;
  producer: string;
  traceId: string | null;
  correlationId: string | null;
  actor: DomainEventActor;
  data: T;
}

export interface PublishDomainEventParams<T> {
  eventType: PublicDomainEventType;
  organizationId: string;
  data: T;
  context?: RequestContext;
  traceId?: string | null;
  correlationId?: string | null;
  actor?: Partial<DomainEventActor>;
  occurredAt?: Date;
}

@Injectable()
export class DomainEventPublisher {
  private readonly logger = new Logger(DomainEventPublisher.name);

  constructor(private readonly outboxWriter: OutboxWriter) {}

  /**
   * Builds a canonical public domain event adhering strictly to UR-11 & section 4.6
   * and enqueues it to the outbox table under topic `esma.files.events.v1`.
   */
  async publish<T>(
    trx: Transaction<Database> | Kysely<Database> | null | undefined,
    params: PublishDomainEventParams<T>,
  ): Promise<DomainEventEnvelope<T>> {
    const eventId = uuidv7();
    const ctx = params.context;

    // Resolve correlationId and traceId
    const correlationId =
      params.correlationId ??
      ctx?.correlationId ??
      getCorrelationId() ??
      null;

    const traceId = params.traceId ?? null;

    // Resolve actor
    let actorType: 'USER' | 'SERVICE' | 'SYSTEM' = 'SYSTEM';
    let actorId = 'system';
    let actingService: string | null = null;

    if (ctx) {
      actorType = ctx.actor.type === 'service' ? 'SERVICE' : 'USER';
      actorId = ctx.actor.id;
      actingService = ctx.actor.actingService ?? null;
    }

    if (params.actor) {
      if (params.actor.type) actorType = params.actor.type;
      if (params.actor.id) actorId = params.actor.id;
      if (params.actor.actingService !== undefined) {
        actingService = params.actor.actingService;
      }
    }

    const envelope: DomainEventEnvelope<T> = {
      eventId,
      eventType: params.eventType,
      occurredAt: (params.occurredAt ?? new Date()).toISOString(),
      organizationId: params.organizationId,
      producer: 'esma-upload-service',
      traceId,
      correlationId,
      actor: {
        type: actorType,
        id: actorId,
        actingService,
      },
      data: params.data,
    };

    // Enqueue to outbox with topic = esma.files.events.v1, key = organizationId
    await this.outboxWriter.enqueue(
      trx,
      {
        eventId,
        eventType: params.eventType,
        schemaVersion: 1,
        timestamp: envelope.occurredAt,
        correlationId: correlationId ?? uuidv7(),
        namespace: ctx?.namespace ?? 'default',
        tenantId: params.organizationId,
        partitionKey: params.organizationId,
        attempt: 0,
        payload: envelope,
      },
      PUBLIC_DOMAIN_TOPIC as unknown as undefined,
    );

    this.logger.debug(
      `Enqueued domain event ${params.eventType} for org ${params.organizationId} (id=${eventId})`,
    );

    return envelope;
  }
}
