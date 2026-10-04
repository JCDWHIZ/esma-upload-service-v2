import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { DeadLetterRepository } from '../db/repositories/dead-letter.repository.js';
import { OutboxWriter } from './outbox-writer.js';
import { AuditRepository } from '../db/repositories/audit.repository.js';
import { DatabaseService } from '../db/database.service.js';
import { MESSAGE_BROKER, type IMessageBroker } from './broker.interface.js';
import type { LogicalTopic } from './catalog.js';
import type {
  DeadLetterFilter,
  DeadLetterRecord,
  PaginatedResult,
} from '../core/types.js';
import { NotFoundError, ValidationError } from '../core/errors/app-error.js';
import type { EventEnvelope } from './envelope.js';

export interface RecordDeadLetterParams {
  readonly originalTopic: string;
  readonly eventType: string;
  readonly eventId: string;
  readonly envelope: Record<string, unknown>;
  readonly error: string;
  readonly attempts?: number;
}

export interface RedriveOptions {
  readonly directPublish?: boolean;
}

@Injectable()
export class DeadLetterService {
  private readonly logger = new Logger(DeadLetterService.name);

  constructor(
    private readonly deadLetterRepo: DeadLetterRepository,
    private readonly outboxWriter: OutboxWriter,
    private readonly auditRepo: AuditRepository,
    private readonly databaseService: DatabaseService,
    @Optional()
    @Inject(MESSAGE_BROKER)
    private readonly broker?: IMessageBroker,
  ) {}

  /**
   * Persists a dead-letter message from the DLQ topic. Idempotent on eventId.
   */
  async recordDeadLetter(
    params: RecordDeadLetterParams,
  ): Promise<DeadLetterRecord> {
    const existing = await this.deadLetterRepo.findByEventId(params.eventId);
    if (existing) {
      if (existing.status === 'OPEN') {
        this.logger.debug(
          `Dead-letter for event ${params.eventId} already exists in OPEN state (id=${existing.id})`,
        );
        return existing;
      }
      this.logger.warn(
        `Dead-letter for event ${params.eventId} was already resolved (${existing.status}); recording fresh occurrence`,
      );
    }

    const created = await this.deadLetterRepo.insert({
      id: uuidv7(),
      receivedAt: new Date(),
      originalTopic: params.originalTopic,
      eventType: params.eventType,
      eventId: params.eventId,
      envelope: params.envelope,
      error: params.error,
      attempts: params.attempts ?? 1,
      status: 'OPEN',
      resolvedAt: null,
      resolvedBy: null,
    });

    this.logger.warn(
      `Persisted dead letter id=${created.id} (topic=${created.originalTopic}, event=${created.eventType}, eventId=${created.eventId})`,
    );

    return created;
  }

  /**
   * Lists dead letters matching the filter with keyset pagination.
   */
  async list(
    filter: DeadLetterFilter = {},
    cursor?: string | null,
    limit = 50,
  ): Promise<PaginatedResult<DeadLetterRecord> & { totalOpen: number }> {
    const result = await this.deadLetterRepo.query(filter, cursor, limit);
    const totalOpen = await this.deadLetterRepo.countOpen();
    return {
      ...result,
      totalOpen,
    };
  }

  /**
   * Retrieves a single dead letter by its primary key ID.
   */
  async getById(id: string): Promise<DeadLetterRecord> {
    const record = await this.deadLetterRepo.findById(id);
    if (!record) {
      throw new NotFoundError(`Dead letter record "${id}" not found`);
    }
    return record;
  }

  /**
   * Redrives a dead letter by republishing it to its original topic through the outbox,
   * resetting delivery attempts and setting status to REDRIVEN.
   */
  async redrive(
    id: string,
    resolvedBy: string,
    options?: RedriveOptions,
  ): Promise<DeadLetterRecord> {
    const record = await this.getById(id);

    if (record.status !== 'OPEN') {
      throw new ValidationError(
        `Cannot redrive dead letter in ${record.status} status. Only OPEN dead letters can be redriven.`,
      );
    }

    // Reset attempt counter in envelope
    const rawEnvelope = record.envelope;
    const redrivenEnvelope: Record<string, unknown> = {
      ...rawEnvelope,
      attempt: 0,
      redriveCount: (Number(rawEnvelope.redriveCount) || 0) + 1,
      redrivenAt: new Date().toISOString(),
      redrivenBy: resolvedBy,
    };

    const targetTopic = (record.originalTopic || 'replication') as LogicalTopic;
    const partitionKey =
      (rawEnvelope.partitionKey as string) ||
      (rawEnvelope.fileId as string) ||
      record.eventId;

    const db = this.databaseService.getDb();
    let updatedRecord: DeadLetterRecord | null = null;

    if (db) {
      updatedRecord = await db.transaction().execute(async (trx) => {
        // Enqueue into outbox table
        await this.outboxWriter.enqueue(
          trx,
          redrivenEnvelope as unknown as EventEnvelope<unknown>,
          targetTopic,
        );

        // Transition dead letter status
        const updated = await this.deadLetterRepo.updateStatus(
          id,
          'REDRIVEN',
          resolvedBy,
          trx,
        );

        // Audit log action
        await this.auditRepo.insert(
          {
            id: uuidv7(),
            action: 'dlq.redrive',
            outcome: 'SUCCESS',
            actorId: resolvedBy,
            actorType: 'admin',
            roles: ['admin'],
            namespace: (rawEnvelope.namespace as string) ?? 'system',
            tenantId: (rawEnvelope.tenantId as string) ?? null,
            fileId: partitionKey,
            correlationId: (rawEnvelope.correlationId as string) ?? uuidv7(),
            details: {
              deadLetterId: id,
              originalTopic: record.originalTopic,
              eventType: record.eventType,
              eventId: record.eventId,
              previousAttempts: record.attempts,
            },
          },
          trx,
        );

        return updated;
      });
    } else {
      // Direct update when database transaction is mocked or direct mode requested
      await this.outboxWriter.enqueue(
        null,
        redrivenEnvelope as unknown as EventEnvelope<unknown>,
        targetTopic,
      );
      updatedRecord = await this.deadLetterRepo.updateStatus(
        id,
        'REDRIVEN',
        resolvedBy,
      );
      await this.auditRepo.insert({
        id: uuidv7(),
        action: 'dlq.redrive',
        outcome: 'SUCCESS',
        actorId: resolvedBy,
        actorType: 'admin',
        roles: ['admin'],
        namespace: (rawEnvelope.namespace as string) ?? 'system',
        tenantId: (rawEnvelope.tenantId as string) ?? null,
        fileId: partitionKey,
        correlationId: (rawEnvelope.correlationId as string) ?? uuidv7(),
        details: {
          deadLetterId: id,
          originalTopic: record.originalTopic,
          eventType: record.eventType,
          eventId: record.eventId,
        },
      });
    }

    // Direct broker publish when requested (useful for immediate test loops or non-relay environments)
    if (options?.directPublish && this.broker) {
      await this.broker.publish(
        targetTopic,
        partitionKey,
        redrivenEnvelope as unknown as EventEnvelope<unknown>,
      );
      this.logger.log(
        `Directly published redriven event ${record.eventId} to ${targetTopic}`,
      );
    }

    this.logger.log(
      `Dead letter ${id} (${record.eventType}) marked REDRIVEN by ${resolvedBy}`,
    );

    return updatedRecord ?? (await this.getById(id));
  }

  /**
   * Discards a dead letter, transitioning its status to DISCARDED and recording an audit trail.
   */
  async discard(
    id: string,
    resolvedBy: string,
    reason?: string,
  ): Promise<DeadLetterRecord> {
    const record = await this.getById(id);

    if (record.status !== 'OPEN') {
      throw new ValidationError(
        `Cannot discard dead letter in ${record.status} status. Only OPEN dead letters can be discarded.`,
      );
    }

    const rawEnvelope = record.envelope;
    const db = this.databaseService.getDb();
    let updatedRecord: DeadLetterRecord | null = null;

    if (db) {
      updatedRecord = await db.transaction().execute(async (trx) => {
        const updated = await this.deadLetterRepo.updateStatus(
          id,
          'DISCARDED',
          resolvedBy,
          trx,
        );

        await this.auditRepo.insert(
          {
            id: uuidv7(),
            action: 'dlq.discard',
            outcome: 'SUCCESS',
            actorId: resolvedBy,
            actorType: 'admin',
            roles: ['admin'],
            namespace: (rawEnvelope.namespace as string) ?? 'system',
            tenantId: (rawEnvelope.tenantId as string) ?? null,
            fileId: (rawEnvelope.partitionKey as string) ?? null,
            correlationId: (rawEnvelope.correlationId as string) ?? uuidv7(),
            details: {
              deadLetterId: id,
              originalTopic: record.originalTopic,
              eventType: record.eventType,
              eventId: record.eventId,
              reason: reason ?? 'Discarded by admin',
            },
          },
          trx,
        );

        return updated;
      });
    } else {
      updatedRecord = await this.deadLetterRepo.updateStatus(
        id,
        'DISCARDED',
        resolvedBy,
      );
      await this.auditRepo.insert({
        id: uuidv7(),
        action: 'dlq.discard',
        outcome: 'SUCCESS',
        actorId: resolvedBy,
        actorType: 'admin',
        roles: ['admin'],
        namespace: (rawEnvelope.namespace as string) ?? 'system',
        tenantId: (rawEnvelope.tenantId as string) ?? null,
        fileId: (rawEnvelope.partitionKey as string) ?? null,
        correlationId: (rawEnvelope.correlationId as string) ?? uuidv7(),
        details: {
          deadLetterId: id,
          originalTopic: record.originalTopic,
          eventType: record.eventType,
          eventId: record.eventId,
          reason: reason ?? 'Discarded by admin',
        },
      });
    }

    this.logger.log(
      `Dead letter ${id} (${record.eventType}) marked DISCARDED by ${resolvedBy}: ${reason ?? 'No reason provided'}`,
    );

    return updatedRecord ?? (await this.getById(id));
  }

  /**
   * Returns current count of OPEN dead letters (metric: gus_dlq_depth).
   */
  async getDlqDepth(): Promise<number> {
    return this.deadLetterRepo.countOpen();
  }
}
