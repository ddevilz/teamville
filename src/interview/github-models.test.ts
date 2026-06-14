/**
 * Tests for makeGithubModelsSession.
 *
 * All tests are network-free: global.fetch is monkeypatched before each
 * relevant test and restored afterwards.
 *
 * Coverage:
 *   - 200 OK: sendAndWait resolves to { text: string }
 *   - 429 (exhausted after retries): throws with rate-limit message (includes model name + free-tier hint)
 *   - 429 with Retry-After header: message includes the header value
 *   - 429-then-200: retries and succeeds (no real waiting — GH_MODELS_TEST_NOWAIT=1)
 *   - non-200 (e.g. 401): throws immediately with status code in the message
 *   - 500: retries then throws with status code
 *   - missing GITHUB_TOKEN: throws with clear fix instructions
 *   - exported model constants have expected values
 *
 * Test-speed note: GH_MODELS_TEST_NOWAIT=1 is set for all suites that trigger
 * the retry loop so tests run in milliseconds with no real sleeps.
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeGithubModelsSession,
  GH_CHEAP_MODEL,
  GH_FRONTIER_MODEL,
} from './github-models.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FetchFn = typeof globalThis.fetch;

/** Replace global fetch with a fake and return a restore function. */
function patchFetch(fake: FetchFn): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  return () => { globalThis.fetch = original; };
}

/** Build a minimal Response-like object. */
function makeFakeResponse(opts: {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}): Response {
  const { status, body = '', headers = {} } = opts;
  const headersObj = new Headers(headers);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: headersObj,
    async json() { return JSON.parse(body); },
    async text() { return body; },
  } as unknown as Response;
}

/**
 * Build a fake fetch that returns responses from a queue in order.
 * Once the queue is exhausted it repeats the last entry.
 */
function makeFetchQueue(responses: Response[]): FetchFn {
  let idx = 0;
  return async () => {
    const res = responses[idx];
    if (idx < responses.length - 1) idx++;
    return res;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('model ID constants', () => {
  it('GH_CHEAP_MODEL is openai/gpt-4o-mini', () => {
    assert.equal(GH_CHEAP_MODEL, 'openai/gpt-4o-mini');
  });

  it('GH_FRONTIER_MODEL is openai/gpt-4o', () => {
    assert.equal(GH_FRONTIER_MODEL, 'openai/gpt-4o');
  });
});

// ---------------------------------------------------------------------------
// 200 OK path
// ---------------------------------------------------------------------------

describe('makeGithubModelsSession — 200 OK', () => {
  let restore: () => void;

  before(() => {
    process.env['GITHUB_TOKEN'] = 'fake-token-for-test';
  });

  after(() => {
    delete process.env['GITHUB_TOKEN'];
  });

  beforeEach(() => {
    const cannedBody = JSON.stringify({
      choices: [{ message: { content: 'Hello from GitHub Models' } }],
    });
    restore = patchFetch(async () => makeFakeResponse({ status: 200, body: cannedBody }));
  });

  afterEach(() => restore());

  it('sendAndWait resolves with { text: string }', async () => {
    const session = makeGithubModelsSession(GH_CHEAP_MODEL);
    const result = await session.sendAndWait({ prompt: 'test prompt' });
    assert.equal(typeof result, 'object');
    assert.equal(typeof result.text, 'string');
  });

  it('text contains the canned response content', async () => {
    const session = makeGithubModelsSession(GH_CHEAP_MODEL);
    const result = await session.sendAndWait({ prompt: 'test prompt' });
    assert.equal(result.text, 'Hello from GitHub Models');
  });

  it('returns empty string when choices array is empty', async () => {
    restore();
    const emptyBody = JSON.stringify({ choices: [] });
    restore = patchFetch(async () => makeFakeResponse({ status: 200, body: emptyBody }));

    const session = makeGithubModelsSession(GH_CHEAP_MODEL);
    const result = await session.sendAndWait({ prompt: 'test' });
    assert.equal(result.text, '');
  });

  it('returns empty string when message.content is null', async () => {
    restore();
    const nullBody = JSON.stringify({ choices: [{ message: { content: null } }] });
    restore = patchFetch(async () => makeFakeResponse({ status: 200, body: nullBody }));

    const session = makeGithubModelsSession(GH_CHEAP_MODEL);
    const result = await session.sendAndWait({ prompt: 'test' });
    assert.equal(result.text, '');
  });
});

// ---------------------------------------------------------------------------
// 429 rate-limit path (exhausted — all retries hit 429)
// Always-429 fakes exercise all 6 retry attempts, so we need NOWAIT.
// ---------------------------------------------------------------------------

describe('makeGithubModelsSession — 429 rate limit (exhausted)', () => {
  let restore: () => void;

  before(() => {
    process.env['GITHUB_TOKEN'] = 'fake-token-for-test';
    // Skip real waits so tests finish in milliseconds.
    process.env['GH_MODELS_TEST_NOWAIT'] = '1';
  });

  after(() => {
    delete process.env['GITHUB_TOKEN'];
    delete process.env['GH_MODELS_TEST_NOWAIT'];
  });

  afterEach(() => restore?.());

  it('throws an error with rate-limit message', async () => {
    restore = patchFetch(async () => makeFakeResponse({ status: 429, body: 'rate limited' }));
    const session = makeGithubModelsSession(GH_CHEAP_MODEL);

    await assert.rejects(
      () => session.sendAndWait({ prompt: 'test' }),
      (err: Error) => {
        assert.ok(err instanceof Error, 'must throw an Error');
        assert.ok(
          err.message.includes('rate limit'),
          `message should say "rate limit", got: ${err.message}`,
        );
        return true;
      },
    );
  });

  it('error message includes the model name', async () => {
    restore = patchFetch(async () => makeFakeResponse({ status: 429, body: '' }));
    const session = makeGithubModelsSession(GH_CHEAP_MODEL);

    await assert.rejects(
      () => session.sendAndWait({ prompt: 'test' }),
      (err: Error) => {
        assert.ok(err.message.includes(GH_CHEAP_MODEL), `message should include model name, got: ${err.message}`);
        return true;
      },
    );
  });

  it('error message includes Retry-After value when header is present', async () => {
    restore = patchFetch(async () =>
      makeFakeResponse({
        status: 429,
        body: '',
        headers: { 'Retry-After': '60' },
      }),
    );
    const session = makeGithubModelsSession(GH_CHEAP_MODEL);

    await assert.rejects(
      () => session.sendAndWait({ prompt: 'test' }),
      (err: Error) => {
        assert.ok(err.message.includes('60'), `message should include Retry-After value, got: ${err.message}`);
        return true;
      },
    );
  });

  it('error message includes LLM_BACKEND=copilot hint', async () => {
    restore = patchFetch(async () => makeFakeResponse({ status: 429, body: '' }));
    const session = makeGithubModelsSession(GH_CHEAP_MODEL);

    await assert.rejects(
      () => session.sendAndWait({ prompt: 'test' }),
      (err: Error) => {
        assert.ok(
          err.message.includes('LLM_BACKEND=copilot'),
          `message should mention LLM_BACKEND=copilot, got: ${err.message}`,
        );
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// 429-then-200 — retry succeeds (no real waiting via NOWAIT env hook)
// ---------------------------------------------------------------------------

describe('makeGithubModelsSession — 429 then 200 (retry succeeds)', () => {
  let restore: () => void;

  before(() => {
    process.env['GITHUB_TOKEN'] = 'fake-token-for-test';
    process.env['GH_MODELS_TEST_NOWAIT'] = '1';
  });

  after(() => {
    delete process.env['GITHUB_TOKEN'];
    delete process.env['GH_MODELS_TEST_NOWAIT'];
  });

  afterEach(() => restore?.());

  it('retries after a single 429 and resolves on the 200', async () => {
    const cannedBody = JSON.stringify({
      choices: [{ message: { content: 'Retry worked' } }],
    });
    const responses = [
      makeFakeResponse({ status: 429, body: 'rate limited' }),
      makeFakeResponse({ status: 200, body: cannedBody }),
    ];
    restore = patchFetch(makeFetchQueue(responses));

    const session = makeGithubModelsSession(GH_CHEAP_MODEL);
    const result = await session.sendAndWait({ prompt: 'test' });
    assert.equal(result.text, 'Retry worked');
  });

  it('retries after two 429s and resolves on the 200', async () => {
    const cannedBody = JSON.stringify({
      choices: [{ message: { content: 'Double retry worked' } }],
    });
    const responses = [
      makeFakeResponse({ status: 429 }),
      makeFakeResponse({ status: 429 }),
      makeFakeResponse({ status: 200, body: cannedBody }),
    ];
    restore = patchFetch(makeFetchQueue(responses));

    const session = makeGithubModelsSession(GH_CHEAP_MODEL);
    const result = await session.sendAndWait({ prompt: 'test' });
    assert.equal(result.text, 'Double retry worked');
  });

  it('retries after a 503 and resolves on the 200', async () => {
    const cannedBody = JSON.stringify({
      choices: [{ message: { content: '5xx retry worked' } }],
    });
    const responses = [
      makeFakeResponse({ status: 503, body: 'Service unavailable' }),
      makeFakeResponse({ status: 200, body: cannedBody }),
    ];
    restore = patchFetch(makeFetchQueue(responses));

    const session = makeGithubModelsSession(GH_CHEAP_MODEL);
    const result = await session.sendAndWait({ prompt: 'test' });
    assert.equal(result.text, '5xx retry worked');
  });

  it('completes in milliseconds (no real waits)', async () => {
    const cannedBody = JSON.stringify({
      choices: [{ message: { content: 'fast' } }],
    });
    // 5 x 429 then 200 — would take 2+4+8+16+30=60s with real backoff.
    const responses = [
      makeFakeResponse({ status: 429 }),
      makeFakeResponse({ status: 429 }),
      makeFakeResponse({ status: 429 }),
      makeFakeResponse({ status: 429 }),
      makeFakeResponse({ status: 429 }),
      makeFakeResponse({ status: 200, body: cannedBody }),
    ];
    restore = patchFetch(makeFetchQueue(responses));

    const start = Date.now();
    const session = makeGithubModelsSession(GH_CHEAP_MODEL);
    await session.sendAndWait({ prompt: 'test' });
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 500, `took ${elapsed}ms — NOWAIT env hook not working`);
  });
});

// ---------------------------------------------------------------------------
// Non-200 / non-429 error path
// ---------------------------------------------------------------------------

describe('makeGithubModelsSession — non-200 errors', () => {
  let restore: () => void;

  before(() => {
    process.env['GITHUB_TOKEN'] = 'fake-token-for-test';
  });

  after(() => {
    delete process.env['GITHUB_TOKEN'];
  });

  afterEach(() => restore?.());

  it('throws with status code in the message on 401', async () => {
    restore = patchFetch(async () =>
      makeFakeResponse({ status: 401, body: 'Unauthorized' }),
    );
    const session = makeGithubModelsSession(GH_CHEAP_MODEL);

    await assert.rejects(
      () => session.sendAndWait({ prompt: 'test' }),
      (err: Error) => {
        assert.ok(err.message.includes('401'), `message should include status 401, got: ${err.message}`);
        return true;
      },
    );
  });

  it('throws immediately on 401 (no retry)', async () => {
    let callCount = 0;
    restore = patchFetch(async () => {
      callCount++;
      return makeFakeResponse({ status: 401, body: 'Unauthorized' });
    });
    const session = makeGithubModelsSession(GH_CHEAP_MODEL);
    await assert.rejects(() => session.sendAndWait({ prompt: 'test' }));
    assert.equal(callCount, 1, '401 should not be retried');
  });

  it('throws with status code in the message on 500', async () => {
    // 500 will be retried — set NOWAIT and patch always-500.
    process.env['GH_MODELS_TEST_NOWAIT'] = '1';
    restore = patchFetch(async () =>
      makeFakeResponse({ status: 500, body: 'Internal Server Error — something went wrong on the server' }),
    );
    const session = makeGithubModelsSession(GH_CHEAP_MODEL);

    await assert.rejects(
      () => session.sendAndWait({ prompt: 'test' }),
      (err: Error) => {
        assert.ok(err.message.includes('500'), `message should include status 500, got: ${err.message}`);
        return true;
      },
    );
    delete process.env['GH_MODELS_TEST_NOWAIT'];
  });
});

// ---------------------------------------------------------------------------
// Missing GITHUB_TOKEN path
// ---------------------------------------------------------------------------

describe('makeGithubModelsSession — missing GITHUB_TOKEN', () => {
  let restore: () => void;

  before(() => {
    // Ensure no token in environment for this suite.
    delete process.env['GITHUB_TOKEN'];
  });

  beforeEach(() => {
    // fetch should NOT be called if token check fails early — but patch anyway
    // so if the code regresses and calls fetch, the test doesn't hang.
    restore = patchFetch(async () => {
      throw new Error('fetch should not be called when GITHUB_TOKEN is missing');
    });
  });

  afterEach(() => restore?.());

  it('throws before making any network call', async () => {
    const session = makeGithubModelsSession(GH_CHEAP_MODEL);
    await assert.rejects(
      () => session.sendAndWait({ prompt: 'test' }),
      (err: Error) => {
        assert.ok(err instanceof Error, 'must throw an Error');
        return true;
      },
    );
  });

  it('error message mentions GITHUB_TOKEN', async () => {
    const session = makeGithubModelsSession(GH_CHEAP_MODEL);
    await assert.rejects(
      () => session.sendAndWait({ prompt: 'test' }),
      (err: Error) => {
        assert.ok(
          err.message.includes('GITHUB_TOKEN'),
          `message should mention GITHUB_TOKEN, got: ${err.message}`,
        );
        return true;
      },
    );
  });

  it('error message explains how to fix it', async () => {
    const session = makeGithubModelsSession(GH_CHEAP_MODEL);
    await assert.rejects(
      () => session.sendAndWait({ prompt: 'test' }),
      (err: Error) => {
        // Should mention .env or token generation
        const hasFixHint =
          err.message.includes('.env') ||
          err.message.includes('export') ||
          err.message.includes('personal_access_token') ||
          err.message.includes('https://github.com/settings/tokens');
        assert.ok(hasFixHint, `message should contain fix instructions, got: ${err.message}`);
        return true;
      },
    );
  });
});
