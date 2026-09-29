/**
 * Backoff and jitter calculation for consumer retry loops.
 * ARCH §8.5 & Task P4-05.
 *
 * Defaults:
 * - baseMs: 10,000 (10 seconds)
 * - factor: 3
 * - jitterPercent: ±20%
 * - capMs: 1,800,000 (30 minutes)
 */

export interface BackoffPolicy {
  /** Initial backoff delay in ms. Default: 10,000 (10s) */
  readonly baseMs?: number;
  /** Exponential multiplier per attempt. Default: 3 */
  readonly factor?: number;
  /** Symmetrical jitter percentage [0..1]. Default: 0.20 (±20%) */
  readonly jitterPercent?: number;
  /** Maximum backoff ceiling in ms. Default: 1,800,000 (30m) */
  readonly capMs?: number;
}

export type RngFn = () => number;

export const DEFAULT_BACKOFF_POLICY: Required<BackoffPolicy> = {
  baseMs: 10_000,
  factor: 3,
  jitterPercent: 0.2,
  capMs: 1_800_000,
};

/**
 * Computes backoff delay in milliseconds for a given attempt number (1-indexed).
 *
 * Formula:
 *   nominal = baseMs * (factor ^ (attempt - 1))
 *   jitterRange = nominal * jitterPercent
 *   withJitter = nominal + (rng() * 2 - 1) * jitterRange
 *   delay = min(withJitter, capMs)
 *
 * If error carries a `retryAfterMs` property that is larger than the computed backoff,
 * the error's `retryAfterMs` takes precedence.
 */
export function computeBackoff(
  attempt: number,
  policy?: BackoffPolicy,
  rng: RngFn = Math.random,
  error?: unknown,
): number {
  const baseMs = policy?.baseMs ?? DEFAULT_BACKOFF_POLICY.baseMs;
  const factor = policy?.factor ?? DEFAULT_BACKOFF_POLICY.factor;
  const jitterPercent =
    policy?.jitterPercent ?? DEFAULT_BACKOFF_POLICY.jitterPercent;
  const capMs = policy?.capMs ?? DEFAULT_BACKOFF_POLICY.capMs;

  const safeAttempt = Math.max(1, attempt);
  const nominal = baseMs * Math.pow(factor, safeAttempt - 1);

  // rng() is in [0, 1). Transform to [-1, 1).
  const randomFactor = rng() * 2 - 1;
  const jitter = nominal * jitterPercent * randomFactor;
  const withJitter = Math.max(0, nominal + jitter);

  let delay = Math.min(withJitter, capMs);

  // If error carries a larger retryAfterMs (e.g. from HTTP 429 Retry-After), honor it
  if (
    error &&
    typeof error === 'object' &&
    'retryAfterMs' in error &&
    typeof (error as { retryAfterMs?: unknown }).retryAfterMs === 'number'
  ) {
    const errorRetryAfter = (error as { retryAfterMs: number }).retryAfterMs;
    if (errorRetryAfter > delay) {
      delay = errorRetryAfter;
    }
  }

  return Math.round(delay);
}
