import { describe, it, expect } from 'vitest';
import { generateTraceparent, parseTraceparent } from '../../src/observability/tracing.js';

describe('Tracing W3C propagation (P6-04)', () => {
  it('generates valid W3C traceparent format', () => {
    const tp = generateTraceparent();
    expect(tp).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);
  });

  it('parses valid traceparent strings correctly', () => {
    const tp = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    const parsed = parseTraceparent(tp);

    expect(parsed).toEqual({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
      sampled: true,
    });
  });

  it('returns null for invalid traceparent strings', () => {
    expect(parseTraceparent(undefined)).toBeNull();
    expect(parseTraceparent('invalid-traceparent')).toBeNull();
    expect(parseTraceparent('01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')).toBeNull();
  });
});
