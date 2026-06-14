// src/ingest/embedder.test.ts
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// We test multiple scenarios. Each describe block that needs a specific
// GITHUB_TOKEN state sets/deletes it around the suite.
//
// IMPORTANT: embedder.ts decides USE_GITHUB at module-load time based on
// GITHUB_TOKEN. To test both branches we use dynamic imports with cache-busting.
// For the "no token" path we can rely on the top-level cached import (no token
// at module load); for the "with token" path the new GitHub-path behaviour
// (retry/throw, never fall back) is tested by patching globalThis.fetch.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FetchFn = typeof globalThis.fetch;

function patchFetch(fake: FetchFn): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  return () => { globalThis.fetch = original; };
}

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

/** Build a fake fetch that returns queued responses; last entry repeats. */
function makeFetchQueue(responses: Response[]): FetchFn {
  let idx = 0;
  return async () => {
    const res = responses[idx];
    if (idx < responses.length - 1) idx++;
    return res;
  };
}

/** Build a 1536-dim embedding response body for N texts. */
function fakeGithubEmbedBody(n: number): string {
  const vec = new Array(1536).fill(0.1);
  const data = Array.from({ length: n }, (_, i) => ({ index: i, embedding: vec }));
  return JSON.stringify({ data });
}

// ---------------------------------------------------------------------------
// Suite 1: MiniLM fallback (no GITHUB_TOKEN)
// ---------------------------------------------------------------------------

describe('embedder – MiniLM fallback (no network)', () => {
  let embed: (texts: string[]) => Promise<Float32Array[]>;
  let embedderName: () => string;

  before(async () => {
    // Ensure no token is present for this test run.
    const saved = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;

    // Dynamic import so the module initialises without a token.
    const mod = await import('./embedder.ts');
    embed = mod.embed;
    embedderName = mod.embedderName;

    if (saved !== undefined) process.env.GITHUB_TOKEN = saved;
  });

  it('returns one Float32Array per input text', async () => {
    const texts = ['hello world', 'another sentence'];
    const result = await embed(texts);
    assert.equal(result.length, 2);
    assert.ok(result[0] instanceof Float32Array, 'should be Float32Array');
    assert.ok(result[1] instanceof Float32Array, 'should be Float32Array');
  });

  it('each vector has 384 dimensions (MiniLM)', async () => {
    const [vec] = await embed(['test sentence']);
    assert.equal(vec.length, 384);
  });

  it('embedderName returns all-MiniLM-L6-v2 when no token', async () => {
    assert.ok(embedderName().includes('MiniLM'), `got: ${embedderName()}`);
  });

  it('cosine similarity of identical texts is > 0.99', async () => {
    const [a, b] = await embed(['identical', 'identical']);
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
    }
    const cos = dot / (Math.sqrt(na) * Math.sqrt(nb));
    assert.ok(cos > 0.99, `cosine was ${cos}`);
  });

  it('empty array returns empty array', async () => {
    const result = await embed([]);
    assert.deepEqual(result, []);
  });
});

// ---------------------------------------------------------------------------
// Suite 2: GitHub Models path — tested by directly exercising the internal
// _githubEmbed path via the module. Since USE_GITHUB is frozen at module-load
// time we test the underlying fetch-based helpers by importing with a token
// already set.
//
// Because Node module cache makes re-importing the same module reuse the
// already-loaded one, we test the GitHub path via the retry+fetch layer
// directly. We verify:
//   1. 429-then-200: embed() retries and returns 1536-dim vectors.
//   2. Persistent 429: embed() THROWS rather than returning MiniLM vectors.
//
// To force these paths even when the cached module has USE_GITHUB=false
// (because the first suite deleted the token before load), we use the
// cache-busting timestamp trick on a dynamic import.
// ---------------------------------------------------------------------------

describe('embedder – GitHub Models path (faked fetch, no network)', () => {
  let embed: (texts: string[]) => Promise<Float32Array[]>;
  let embedderName: () => string;
  let restoreFetch: () => void;

  before(async () => {
    // Set token BEFORE dynamic import so USE_GITHUB is true.
    process.env.GITHUB_TOKEN = 'fake-token-for-embed-test';
    process.env.GH_MODELS_TEST_NOWAIT = '1';

    // Cache-bust so we get a fresh module with USE_GITHUB=true.
    const mod = await import(`./embedder.ts?gh=${Date.now()}`);
    embed = mod.embed;
    embedderName = mod.embedderName;
  });

  afterEach(() => {
    restoreFetch?.();
  });

  // Note: we do NOT delete GITHUB_TOKEN in after() because the test for
  // "persistent 429 throws" below needs it. We clean up at the very end.
  after(() => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_MODELS_TEST_NOWAIT;
  });

  it('embedderName reports GitHub model when token is present', () => {
    assert.ok(
      embedderName().includes('text-embedding-3-small'),
      `got: ${embedderName()}`,
    );
  });

  it('429-then-200: retries and returns 1536-dim GitHub vectors', async () => {
    const body = fakeGithubEmbedBody(2);
    const responses = [
      makeFakeResponse({ status: 429, body: 'rate limited' }),
      makeFakeResponse({ status: 200, body }),
    ];
    restoreFetch = patchFetch(makeFetchQueue(responses));

    const vecs = await embed(['hello', 'world']);
    assert.equal(vecs.length, 2, 'should return 2 vectors');
    assert.equal(vecs[0].length, 1536, 'should be 1536-dim (GitHub)');
    assert.equal(vecs[1].length, 1536, 'should be 1536-dim (GitHub)');
  });

  it('persistent 429: THROWS rather than falling back to MiniLM', async () => {
    // Always returns 429 — all 6 retries will fail.
    restoreFetch = patchFetch(async () => makeFakeResponse({ status: 429 }));

    await assert.rejects(
      () => embed(['test']),
      (err: Error) => {
        assert.ok(err instanceof Error, 'must throw an Error');
        // Must NOT silently fall back — error should mention retries or GitHub Models.
        const msg = err.message.toLowerCase();
        const isGithubError =
          msg.includes('github') ||
          msg.includes('retries') ||
          msg.includes('rate limit') ||
          msg.includes('free-tier') ||
          msg.includes('free tier');
        assert.ok(
          isGithubError,
          `expected GitHub-Models error, got: ${err.message}`,
        );
        // Sanity: the error should not be a success (we rejected, so this is the
        // throw path — correct). The error message may mention MiniLM only as
        // guidance ("unset token to use MiniLM"), not as a fallback result.
        // We verify the call actually threw (above) and the vectors were not
        // silently returned as MiniLM — the assert.rejects verifies no result.
        return true;
      },
    );
  });

  it('persistent 429 with token: error message suggests unset GITHUB_TOKEN for offline mode', async () => {
    restoreFetch = patchFetch(async () => makeFakeResponse({ status: 429 }));

    await assert.rejects(
      () => embed(['test']),
      (err: Error) => {
        // Error should guide the user on how to switch to offline MiniLM.
        const mentionsUnset =
          err.message.includes('GITHUB_TOKEN') ||
          err.message.includes('unset') ||
          err.message.includes('offline');
        assert.ok(
          mentionsUnset,
          `error should guide user to unset token for offline mode, got: ${err.message}`,
        );
        return true;
      },
    );
  });

  it('completes 429-then-200 in milliseconds (no real waits)', async () => {
    const body = fakeGithubEmbedBody(1);
    const responses = [
      makeFakeResponse({ status: 429 }),
      makeFakeResponse({ status: 429 }),
      makeFakeResponse({ status: 429 }),
      makeFakeResponse({ status: 200, body }),
    ];
    restoreFetch = patchFetch(makeFetchQueue(responses));

    const start = Date.now();
    await embed(['hello']);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 500, `took ${elapsed}ms — NOWAIT env hook not working`);
  });
});
