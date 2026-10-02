import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import type { Transaction, Kysely } from 'kysely';
import { AppConfigService } from '../config/config.service.js';
import { AuditRepository } from '../db/repositories/audit.repository.js';
import { DatabaseService } from '../db/database.service.js';
import type { Database } from '../db/types.js';
import { OutboxWriter } from '../events/outbox-writer.js';
import type { AuditSink, AuditEvent } from '../authz/audit-sink.js';
import type {
  AuditOutcome,
  NewAuditLogEntry,
  AuditLogEntry,
} from '../core/types.js';
import { createEnvelope } from '../events/envelope.js';
import { EVENT_TYPES } from '../events/catalog.js';

export interface AuditRecordOptions {
  readonly occurredAt?: Date;
  readonly action: string;
  readonly outcome: AuditOutcome;
  readonly actorId: string;
  readonly actorType: string;
  readonly roles?: string[];
  readonly namespace: string;
  readonly tenantId?: string | null;
  readonly fileId?: string | null;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
  readonly correlationId?: string;
  readonly details?: Record<string, unknown>;
}

@Injectable()
export class AuditService implements AuditSink, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuditService.name);
  private readonly queue: NewAuditLogEntry[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private isFlushing = false;

  constructor(
    private readonly configService: AppConfigService,
    private readonly auditRepo: AuditRepository,
    @Optional() private readonly db?: DatabaseService,
    @Optional() private readonly outboxWriter?: OutboxWriter,
  ) {}

  onModuleInit(): void {
    // Flush in-memory read audit queue every 500ms
    this.flushTimer = setInterval(() => {
      void this.flushQueue();
    }, 500);

    if (this.flushTimer.unref) {
      this.flushTimer.unref();
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flushQueue();
  }

  /**
   * Implements the AuditSink interface for authorization decision logging.
   */
  async record(event: AuditEvent): Promise<void> {
    const outcome: AuditOutcome = event.decision.allowed ? 'SUCCESS' : 'DENIED';
    const action = event.decision.allowed
      ? `AUTH_${event.action.toUpperCase()}`
      : 'AUTH_DENIED';

    const entry: NewAuditLogEntry = {
      action,
      outcome,
      actorId: event.actorId,
      actorType: event.actorType,
      namespace: event.namespace,
      tenantId: event.tenantId,
      correlationId: event.correlationId ?? uuidv7(),
      details: this.sanitizeDetails({
        requestedAction: event.action,
        reason: event.decision.reason,
        subTenantId: event.subTenantId,
        ...(event.resource ? { resource: event.resource } : {}),
      }),
    };

    if (
      outcome === 'DENIED' ||
      event.action === 'admin' ||
      event.action === 'delete'
    ) {
      await this.recordSync(entry);
    } else {
      this.recordAsync(entry);
    }
  }

  /**
   * Synchronously records a critical mutation or security audit log entry.
   * Can be executed inside an open DB transaction.
   */
  async recordSync(
    opts: AuditRecordOptions | NewAuditLogEntry,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<AuditLogEntry> {
    const entry: NewAuditLogEntry = {
      id: 'id' in opts && opts.id ? opts.id : uuidv7(),
      occurredAt: opts.occurredAt ?? new Date(),
      action: opts.action,
      outcome: opts.outcome,
      actorId: opts.actorId,
      actorType: opts.actorType,
      roles: opts.roles ?? [],
      namespace: opts.namespace,
      tenantId: opts.tenantId ?? null,
      fileId: opts.fileId ?? null,
      ipAddress: opts.ipAddress ?? null,
      userAgent: opts.userAgent ?? null,
      correlationId: opts.correlationId ?? uuidv7(),
      details: this.sanitizeDetails(opts.details ?? {}),
    };

    const saved = await this.auditRepo.insert(entry, trx);

    // Stream to event broker outbox if AUDIT_STREAM=true
    if (this.configService.auditStream && this.outboxWriter) {
      try {
        const envelope = createEnvelope({
          eventType: EVENT_TYPES.FILE_PROCESSED,
          partitionKey: entry.fileId ?? entry.tenantId ?? entry.correlationId,
          correlationId: entry.correlationId,
          namespace: entry.namespace,
          tenantId: entry.tenantId ?? 'system',
          payload: {
            auditId: saved.id,
            action: entry.action,
            outcome: entry.outcome,
            actorId: entry.actorId,
          },
        });
        await this.outboxWriter.enqueue(trx, envelope, 'audit');
      } catch (err: unknown) {
        this.logger.warn(
          `Failed to enqueue audit stream outbox event: ${String(err)}`,
        );
      }
    }

    return saved;
  }

  /**
   * Enqueues a read/list audit event into the in-memory batch queue.
   */
  recordAsync(opts: AuditRecordOptions | NewAuditLogEntry): void {
    const mode = this.configService.auditReads;
    if (mode === 'off') {
      return;
    }

    if (mode === 'sampled') {
      const rate = this.configService.auditSampleRate;
      if (Math.random() > rate) {
        return;
      }
    }

    const entry: NewAuditLogEntry = {
      id: 'id' in opts && opts.id ? opts.id : uuidv7(),
      occurredAt: opts.occurredAt ?? new Date(),
      action: opts.action,
      outcome: opts.outcome,
      actorId: opts.actorId,
      actorType: opts.actorType,
      roles: opts.roles ?? [],
      namespace: opts.namespace,
      tenantId: opts.tenantId ?? null,
      fileId: opts.fileId ?? null,
      ipAddress: opts.ipAddress ?? null,
      userAgent: opts.userAgent ?? null,
      correlationId: opts.correlationId ?? uuidv7(),
      details: this.sanitizeDetails(opts.details ?? {}),
    };

    this.queue.push(entry);

    if (this.queue.length >= 50) {
      void this.flushQueue();
    }
  }

  /**
   * Flushes queued async audit records to PostgreSQL in batch.
   */
  async flushQueue(): Promise<number> {
    if (this.isFlushing || this.queue.length === 0) {
      return 0;
    }

    this.isFlushing = true;
    const batch = this.queue.splice(0, 50);

    try {
      let count = 0;
      for (const entry of batch) {
        try {
          await this.auditRepo.insert(entry);
          count++;
        } catch (insertErr: unknown) {
          this.logger.warn(
            `Failed to insert batch audit record ${entry.id}: ${String(insertErr)}`,
          );
        }
      }
      return count;
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * Redacts authorization headers, secret keys, passwords, and tokens from details metadata.
   */
  private sanitizeDetails(
    details: Record<string, unknown>,
  ): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};
    const sensitivePattern = /(token|secret|password|auth|key|cookie)/i;

    for (const [k, v] of Object.entries(details)) {
      if (sensitivePattern.test(k)) {
        sanitized[k] = '[REDACTED]';
      } else if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        sanitized[k] = this.sanitizeDetails(v as Record<string, unknown>);
      } else {
        sanitized[k] = v;
      }
    }

    return sanitized;
  }
}
