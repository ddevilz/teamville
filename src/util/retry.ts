/**
 * Shared retry-with-backoff helper for HTTP clients hitting free-tier rate limits.
 *
 * Strategy:
 *  - Retries on HTTP 429 (rate limit) and 5xx (transient server errors).
 *  - Respects the `Retry-After` response header (seconds) when present.
 *  - Otherwise uses exponential backoff: base * 2^attempt + jitter, capped at maxWaitMs.
 *  - Up to `maxAttempts` total attempts (first call + retries).
 *  - On 4xx other than 429: throws immediately without retrying.
 *  - After exhausting retries: re-throws the last error.
 *
 * Test hook: set GH_MODELS_TEST_NOWAIT=1 to collapse all waits to 0 ms.
 */

export interface RetryOpts {
  /** Total attempts including the first call. Default 6. */
  maxAttempts?: number;
  /** Base backoff in ms for exponential strategy. Default 2000. */
  baseMs?: number;
  /** Maximum per-attempt wait in ms. Default 30_000. */
  maxWaitMs?: number;
  /**
   * Optional sleep override (for tests). When GH_MODELS_TEST_NOWAIT=1 the
   * helper automatically uses a no-op sleep, so callers don't need to inject it.
   */
  sleep?: (ms: number) => Promise<void>;
}

/** Return the number of ms to wait from a Retry-After header value, or null. */
export function parseRetryAfter(headers: { get(name: string): string | null }): number | null {
  const raw = headers.get('Retry-After');
  if (!raw) return null;
  const secs = parseFloat(raw);
  if (!Number.isFinite(secs) || secs < 0) return null;
  return Math.min(secs * 1000, 30_000);
}

const DEFAULT_SLEEP = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

const NOOP_SLEEP = (_ms: number): Promise<void> => Promise.resolve();

function isTestNoWait(): boolean {
  return process.env['GH_MODELS_TEST_NOWAIT'] === '1';
}

/**
 * Execute `fn` up to `maxAttempts` times, retrying on 429/5xx HTTP errors.
 *
 * `fn` must either:
 *   - return a result value, or
 *   - throw an error that has an optional `status` number property and an
 *     optional `headers` property (a Headers-like object) for Retry-After.
 *
 * For convenience, this module exports `RetryableError` which carries those fields.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOpts = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 6;
  const baseMs = opts.baseMs ?? 2_000;
  const maxWaitMs = opts.maxWaitMs ?? 30_000;
  const sleep = opts.sleep ?? (isTestNoWait() ? NOOP_SLEEP : DEFAULT_SLEEP);

  let lastErr: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastErr = err;

      const status = (err as RetryableError | null)?.status;
      const isRetryable =
        status === 429 || (typeof status === 'number' && status >= 500 && status < 600);

      if (!isRetryable) {
        // 4xx (non-429) or non-HTTP errors — fail fast.
        throw err;
      }

      if (attempt === maxAttempts - 1) {
        // No more attempts left.
        break;
      }

      // Compute wait duration.
      const headers = (err as RetryableError | null)?.headers;
      let waitMs: number;
      if (headers) {
        const fromHeader = parseRetryAfter(headers);
        waitMs = fromHeader ?? backoffMs(attempt, baseMs, maxWaitMs);
      } else {
        waitMs = backoffMs(attempt, baseMs, maxWaitMs);
      }

      await sleep(waitMs);
    }
  }

  throw lastErr;
}

function backoffMs(attempt: number, baseMs: number, maxWaitMs: number): number {
  // Exponential: base * 2^attempt, plus up to 20% random jitter.
  const exp = baseMs * Math.pow(2, attempt);
  const jitter = exp * 0.2 * Math.random();
  return Math.min(exp + jitter, maxWaitMs);
}

/**
 * Error subclass that carries an HTTP status and optional response headers,
 * so `withRetry` can inspect them.
 */
export class RetryableError extends Error {
  readonly status: number;
  readonly headers?: { get(name: string): string | null };

  constructor(
    message: string,
    status: number,
    headers?: { get(name: string): string | null },
  ) {
    super(message);
    this.name = 'RetryableError';
    this.status = status;
    this.headers = headers;
  }
}
