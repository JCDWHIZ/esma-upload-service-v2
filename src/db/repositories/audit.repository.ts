import { Injectable } from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { BaseRepository } from './base.repository.js';
import type { Database } from '../types.js';
import type {
  AuditFilter,
  AuditLogEntry,
  NewAuditLogEntry,
  PaginatedResult,
} from '../../core/types.js';
import { decodeCursor, encodeCursor, mapAuditRow } from '../mappers.js';

@Injectable()
export class AuditRepository extends BaseRepository {
  async insert(
    entry: NewAuditLogEntry,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<AuditLogEntry> {
    const id = entry.id ?? uuidv7();
    const result = await this.getExecutor(trx)
      .insertInto('audit_log')
      .values({
        id,
        occurred_at: entry.occurredAt ?? sql<Date>`now()`,
        action: entry.action,
        outcome: entry.outcome,
        actor_id: entry.actorId,
        actor_type: entry.actorType,
        roles: entry.roles ?? [],
        namespace: entry.namespace,
        tenant_id: entry.tenantId ?? null,
        file_id: entry.fileId ?? null,
        ip_address: entry.ipAddress ?? null,
        user_agent: entry.userAgent ?? null,
        correlation_id: entry.correlationId,
        details: entry.details ?? {},
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return mapAuditRow(result);
  }

  async query(
    filter: AuditFilter = {},
    cursor?: string | null,
    limit = 50,
    trx?: Transaction<Database> | Kysely<Database>,
  ): Promise<PaginatedResult<AuditLogEntry>> {
    const safeLimit = Math.max(1, Math.min(limit, 200));
    let qb = this.getExecutor(trx).selectFrom('audit_log').selectAll();

    if (filter.namespace) {
      qb = qb.where('namespace', '=', filter.namespace);
    }

    if (filter.tenantId !== undefined) {
      if (filter.tenantId === null) {
        qb = qb.where('tenant_id', 'is', null);
      } else {
        qb = qb.where('tenant_id', '=', filter.tenantId);
      }
    }

    if (filter.actorId) {
      qb = qb.where('actor_id', '=', filter.actorId);
    }

    if (filter.fileId) {
      qb = qb.where('file_id', '=', filter.fileId);
    }

    if (filter.action) {
      qb = qb.where('action', '=', filter.action);
    }

    if (filter.outcome) {
      qb = qb.where('outcome', '=', filter.outcome);
    }

    if (filter.from) {
      qb = qb.where('occurred_at', '>=', filter.from);
    }

    if (filter.to) {
      qb = qb.where('occurred_at', '<=', filter.to);
    }

    if (cursor) {
      const decoded = decodeCursor(cursor);
      if (decoded) {
        qb = qb.where((eb) =>
          eb.or([
            eb('occurred_at', '<', decoded.createdAt),
            eb.and([
              eb('occurred_at', '=', decoded.createdAt),
              eb('id', '<', decoded.id),
            ]),
          ]),
        );
      }
    }

    qb = qb
      .orderBy('occurred_at', 'desc')
      .orderBy('id', 'desc')
      .limit(safeLimit + 1);

    const rows = await qb.execute();
    const hasMore = rows.length > safeLimit;
    const items = hasMore ? rows.slice(0, safeLimit) : rows;
    const mapped = items.map(mapAuditRow);

    let nextCursor: string | null = null;
    if (hasMore && mapped.length > 0) {
      const last = mapped[mapped.length - 1];
      nextCursor = encodeCursor({
        createdAt: last.occurredAt,
        id: last.id,
      });
    }

    return {
      items: mapped,
      nextCursor,
      hasMore,
    };
  }
}
