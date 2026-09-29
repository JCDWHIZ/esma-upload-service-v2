import { describe, it, expect } from 'vitest';
import {
  computeBackoff,
  DEFAULT_BACKOFF_POLICY,
  type BackoffPolicy,
} from '../../src/events/backoff.js';

describe('computeBackoff (P4-05)', () => {
  it('computes expected nominal backoff when jitter is centered (rng = 0.5)', () => {
    const fixedRng = () => 0.5; // (0.5 * 2 - 1) = 0 -> zero jitter

    // attempt 1: 10,000 * 3^0 = 10,000 ms
    expect(computeBackoff(1, undefined, fixedRng)).toBe(10_000);

    // attempt 2: 10,000 * 3^1 = 30,000 ms
    expect(computeBackoff(2, undefined, fixedRng)).toBe(30_000);

    // attempt 3: 10,000 * 3^2 = 90,000 ms
    expect(computeBackoff(3, undefined, fixedRng)).toBe(90_000);

    // attempt 4: 10,000 * 3^3 = 270,000 ms
    expect(computeBackoff(4, undefined, fixedRng)).toBe(270_000);

    // attempt 5: 10,000 * 3^4 = 810,000 ms
    expect(computeBackoff(5, undefined, fixedRng)).toBe(810_000);
  });

  it('caps at policy capMs (default 30 minutes)', () => {
    const fixedRng = () => 0.5;

    // attempt 6: 10,000 * 3^5 = 2,430,000 ms -> should cap at 1,800,000 ms
    expect(computeBackoff(6, undefined, fixedRng)).toBe(
      DEFAULT_BACKOFF_POLICY.capMs,
    );
    expect(computeBackoff(10, undefined, fixedRng)).toBe(
      DEFAULT_BACKOFF_POLICY.capMs,
    );
  });

  it('strictly respects ±20% jitter bounds across the full RNG range [0, 1]', () => {
    const policy: BackoffPolicy = {
      baseMs: 10_000,
      factor: 3,
      jitterPercent: 0.2,
      capMs: 1_800_000,
    };

    // attempt 1 nominal = 10,000. Jitter bounds: [8,000, 12,000]
    const minJitter = computeBackoff(1, policy, () => 0.0);
    const maxJitter = computeBackoff(1, policy, () => 1.0);
    expect(minJitter).toBe(8_000);
    expect(maxJitter).toBe(12_000);

    // attempt 2 nominal = 30,000. Jitter bounds: [24,000, 36,000]
    expect(computeBackoff(2, policy, () => 0.0)).toBe(24_000);
    expect(computeBackoff(2, policy, () => 1.0)).toBe(36_000);

    // Randomized checks inside bounds
    for (let i = 0; i < 50; i++) {
      const val = computeBackoff(1, policy);
      expect(val).toBeGreaterThanOrEqual(8_000);
      expect(val).toBeLessThanOrEqual(12_000);
    }
  });

  it('honors error.retryAfterMs when larger than computed backoff', () => {
    const fixedRng = () => 0.5;
    const computedAttempt1 = computeBackoff(1, undefined, fixedRng); // 10,000 ms

    // If error carries 45,000 ms (e.g. from HTTP 429), honor it
    const errorWithHigherRetry = { retryAfterMs: 45_000 };
    expect(computeBackoff(1, undefined, fixedRng, errorWithHigherRetry)).toBe(
      45_000,
    );

    // If error carries 5,000 ms (smaller than computed 10,000), keep computed
    const errorWithLowerRetry = { retryAfterMs: 5_000 };
    expect(computeBackoff(1, undefined, fixedRng, errorWithLowerRetry)).toBe(
      computedAttempt1,
    );
  });

  it('respects custom backoff policy overrides', () => {
    const customPolicy: BackoffPolicy = {
      baseMs: 500,
      factor: 2,
      jitterPercent: 0.1,
      capMs: 5_000,
    };
    const fixedRng = () => 0.5;

    // attempt 1: 500 * 2^0 = 500
    expect(computeBackoff(1, customPolicy, fixedRng)).toBe(500);
    // attempt 2: 500 * 2^1 = 1,000
    expect(computeBackoff(2, customPolicy, fixedRng)).toBe(1_000);
    // attempt 3: 500 * 2^2 = 2,000
    expect(computeBackoff(3, customPolicy, fixedRng)).toBe(2_000);
    // attempt 4: 500 * 2^3 = 4,000
    expect(computeBackoff(4, customPolicy, fixedRng)).toBe(4_000);
    // attempt 5: 500 * 2^4 = 8,000 -> capped at 5,000
    expect(computeBackoff(5, customPolicy, fixedRng)).toBe(5_000);
  });
});
