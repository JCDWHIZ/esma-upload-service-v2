import { randomBytes } from 'node:crypto';

export interface TraceContext {
  traceId: string;
  spanId: string;
  sampled: boolean;
}

/**
 * Generates a standard W3C traceparent string: 00-{traceId}-{spanId}-01
 */
export function generateTraceparent(): string {
  const traceId = randomBytes(16).toString('hex');
  const spanId = randomBytes(8).toString('hex');
  return `00-${traceId}-${spanId}-01`;
}

/**
 * Parses a W3C traceparent header string.
 */
export function parseTraceparent(traceparent?: string): TraceContext | null {
  if (!traceparent || typeof traceparent !== 'string') {
    return null;
  }

  const parts = traceparent.trim().split('-');
  if (parts.length < 4 || parts[0] !== '00') {
    return null;
  }

  const traceId = parts[1];
  const spanId = parts[2];
  const flags = parts[3];

  if (traceId.length !== 32 || spanId.length !== 16) {
    return null;
  }

  return {
    traceId,
    spanId,
    sampled: flags === '01',
  };
}
