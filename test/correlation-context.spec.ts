import {
  getCorrelationId,
  getCorrelationContext,
  runWithCorrelationContext,
  runWithCorrelationId,
} from '../src/observability/correlation-context.js';
import {
  resolveOrGenerateCorrelationId,
  CORRELATION_ID_REGEX,
} from '../src/observability/correlation-id.interceptor.js';

describe('CorrelationContext & AsyncLocalStorage', () => {
  it('should return undefined when no context is active', () => {
    expect(getCorrelationId()).toBeUndefined();
    expect(getCorrelationContext()).toBeUndefined();
  });

  it('should propagate correlation ID across async boundary', async () => {
    const testId = 'corr-12345678-abcd';

    await runWithCorrelationId(testId, async () => {
      expect(getCorrelationId()).toBe(testId);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(getCorrelationId()).toBe(testId);

      // Nested async promise
      const nested = await Promise.resolve().then(() => getCorrelationId());
      expect(nested).toBe(testId);
    });

    expect(getCorrelationId()).toBeUndefined();
  });

  it('should preserve full correlation context (namespace, tenantId, fileId, actorId)', () => {
    const context = {
      correlationId: 'test-corr-id-999',
      namespace: 'esma-tenant',
      tenantId: 'school-123',
      fileId: '0198f3a2-7c1e-7b40-9d2a-5e6f1a8c3b90',
      actorId: 'user-456',
    };

    runWithCorrelationContext(context, () => {
      const current = getCorrelationContext();
      expect(current).toEqual(context);
      expect(getCorrelationId()).toBe(context.correlationId);
    });

    expect(getCorrelationContext()).toBeUndefined();
  });

  it('should isolate concurrent async contexts', async () => {
    const task1 = runWithCorrelationId('ctx-1-11111111', async () => {
      await new Promise((r) => setTimeout(r, 20));
      return getCorrelationId();
    });

    const task2 = runWithCorrelationId('ctx-2-22222222', async () => {
      await new Promise((r) => setTimeout(r, 10));
      return getCorrelationId();
    });

    const [res1, res2] = await Promise.all([task1, task2]);
    expect(res1).toBe('ctx-1-11111111');
    expect(res2).toBe('ctx-2-22222222');
  });
});

describe('resolveOrGenerateCorrelationId', () => {
  it('should accept valid correlation IDs matching pattern', () => {
    const validIds = [
      '12345678',
      'abc-def-ghi-jkl',
      'corr_id_99999999',
      '0198f3a2-7c1e-7b40-9d2a-5e6f1a8c3b90',
    ];

    for (const id of validIds) {
      expect(resolveOrGenerateCorrelationId(id)).toBe(id);
    }
  });

  it('should generate a valid UUIDv7 when header is missing or malformed', () => {
    const invalidInputs = [
      undefined,
      null,
      '',
      'short', // < 8 chars
      'invalid@character!',
      'with spaces in id',
      'a'.repeat(65), // > 64 chars
    ];

    for (const invalid of invalidInputs) {
      const generated = resolveOrGenerateCorrelationId(invalid);
      expect(typeof generated).toBe('string');
      expect(CORRELATION_ID_REGEX.test(generated)).toBe(true);
      expect(generated.length).toBeGreaterThanOrEqual(8);
      // Valid UUID format check: 8-4-4-4-12 hex chars
      expect(generated).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    }
  });
});
