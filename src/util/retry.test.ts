/**
 * Unit tests for src/util/retry.ts
 *
 * All tests are synchronous / near-instant: sleep is injected as a no-op.
 * No network calls are made.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry, parseRetryAfter, RetryableError } from './retry.ts';

// No-op sleep so tests don't actually wait.
const FAST_SLEEP = async (_ms: number) => {};

// ---------------------------------------------------------------------------
// parseRetryAfter
// ---------------------------------------------------------------------------

describe('parseRetryAfter', () => {
  function fakeHeaders(value: string | null): { get(name: string): string | null } {
    return { get: (name: string) => (name.toLowerCase() === 'retry-after' ? value : null) };
  }

  it('returns null when header is absent', () => {
    assert.equal(parseRetryAfter(fakeHeaders(null)), null);
  });

  it('converts seconds to ms', () => {
    assert.equal(parseRetryAfter(fakeHeaders('10')), 10_000);
  });

  it('caps at 30_000 ms', () => {
    assert.equal(parseRetryAfter(fakeHeaders('60')), 30_000);
  });

  it('returns null for non-numeric value', () => {
    assert.equal(parseRetryAfter(fakeHeaders('now')), null);
  });

  it('returns null for negative value', () => {
    assert.equal(parseRetryAfter(fakeHeaders('-5')), null);
  });
});

// ---------------------------------------------------------------------------
// withRetry — success paths
// ---------------------------------------------------------------------------

describe('withRetry — success on first attempt', () => {
  it('returns the value immediately', async () => {
    const result = await withRetry(async () => 42, { sleep: FAST_SLEEP });
    assert.equal(result, 42);
  });

  it('only calls fn once on immediate success', async () => {
    let calls = 0;
    await withRetry(async () => { calls++; return 'ok'; }, { sleep: FAST_SLEEP });
    assert.equal(calls, 1);
  });
});

describe('withRetry — retry on 429 then succeed', () => {
  it('retries a 429 and returns on the second attempt', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls === 1) throw new RetryableError('rate limited', 429);
        return 'success';
      },
      { sleep: FAST_SLEEP, maxAttempts: 6, baseMs: 10 },
    );
    assert.equal(result, 'success');
    assert.equal(calls, 2);
  });

  it('retries a 503 and returns on the second attempt', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls === 1) throw new RetryableError('server error', 503);
        return 'success';
      },
      { sleep: FAST_SLEEP, maxAttempts: 6, baseMs: 10 },
    );
    assert.equal(result, 'success');
    assert.equal(calls, 2);
  });
});

// ---------------------------------------------------------------------------
// withRetry — fail-fast on non-retryable errors
// ---------------------------------------------------------------------------

describe('withRetry — fail-fast on 4xx (non-429)', () => {
  it('throws immediately on 401 without retrying', async () => {
    let calls = 0;
    await assert.rejects(
      () => withRetry(
        async () => { calls++; throw new RetryableError('unauthorized', 401); },
        { sleep: FAST_SLEEP, maxAttempts: 6 },
      ),
      (err: RetryableError) => {
        assert.equal(err.status, 401);
        return true;
      },
    );
    assert.equal(calls, 1, 'should only call fn once for 401');
  });

  it('throws immediately on 403', async () => {
    let calls = 0;
    await assert.rejects(
      () => withRetry(
        async () => { calls++; throw new RetryableError('forbidden', 403); },
        { sleep: FAST_SLEEP, maxAttempts: 6 },
      ),
    );
    assert.equal(calls, 1);
  });

  it('throws immediately on non-HTTP errors', async () => {
    let calls = 0;
    await assert.rejects(
      () => withRetry(
        async () => { calls++; throw new Error('network error'); },
        { sleep: FAST_SLEEP, maxAttempts: 6 },
      ),
      /network error/,
    );
    assert.equal(calls, 1);
  });
});

// ---------------------------------------------------------------------------
// withRetry — exhaust retries
// ---------------------------------------------------------------------------

describe('withRetry — exhaust all attempts', () => {
  it('tries exactly maxAttempts times before throwing', async () => {
    let calls = 0;
    await assert.rejects(
      () => withRetry(
        async () => { calls++; throw new RetryableError('always 429', 429); },
        { sleep: FAST_SLEEP, maxAttempts: 4, baseMs: 10 },
      ),
      (err: RetryableError) => {
        assert.equal(err.status, 429);
        return true;
      },
    );
    assert.equal(calls, 4);
  });
});

// ---------------------------------------------------------------------------
// withRetry — Retry-After header is respected
// ---------------------------------------------------------------------------

describe('withRetry — Retry-After header', () => {
  it('passes the Retry-After ms to sleep', async () => {
    const sleepArgs: number[] = [];
    const fakeSleep = async (ms: number) => { sleepArgs.push(ms); };
    let calls = 0;

    const headers = { get: (n: string) => n.toLowerCase() === 'retry-after' ? '5' : null };

    await withRetry(
      async () => {
        calls++;
        if (calls === 1) throw new RetryableError('rate limited', 429, headers);
        return 'ok';
      },
      { sleep: fakeSleep, maxAttempts: 6, baseMs: 2000 },
    );

    assert.equal(sleepArgs.length, 1);
    // 5 seconds = 5000 ms
    assert.equal(sleepArgs[0], 5000);
  });
});

// ---------------------------------------------------------------------------
// GH_MODELS_TEST_NOWAIT env hook
// ---------------------------------------------------------------------------

describe('GH_MODELS_TEST_NOWAIT env hook', () => {
  it('collapses waits to 0 when set', async () => {
    process.env['GH_MODELS_TEST_NOWAIT'] = '1';
    const start = Date.now();
    let calls = 0;
    await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new RetryableError('429', 429);
        return 'done';
      },
      // No sleep injected — relies on env hook
      { maxAttempts: 6, baseMs: 5000 },
    );
    const elapsed = Date.now() - start;
    delete process.env['GH_MODELS_TEST_NOWAIT'];
    // With real 5000ms base and 3 attempts, without the env hook this would
    // take 5s+. With the hook it should complete in <500ms.
    assert.ok(elapsed < 500, `elapsed ${elapsed}ms — env hook not working`);
    assert.equal(calls, 3);
  });
});
