import { Injectable } from '@nestjs/common';
import { AuthzAction, AuthzDecision, AuthzResource } from './matrix-rules.js';

export interface AuditEvent {
  action: AuthzAction;
  decision: AuthzDecision;
  actorId: string;
  actorType: string;
  namespace: string;
  tenantId: string;
  subTenantId?: string;
  resource?: AuthzResource;
  correlationId?: string;
  timestamp: Date;
}

export interface AuditSink {
  record(event: AuditEvent): Promise<void> | void;
}

export const AUDIT_SINK = Symbol('AUDIT_SINK');

/**
 * Default no-op AuditSink implementation.
 * Substituted in tests and replaced by full database audit logger in P6-01.
 */
@Injectable()
export class NoopAuditSink implements AuditSink {
  record(_event: AuditEvent): void {
    void _event;
    // No-op until P6-01 full persistent audit sink is wired
  }
}
