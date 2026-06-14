/**
 * Batch text embedder.
 *
 * Primary: GitHub Models  POST https://models.github.ai/inference/embeddings
 *   model: openai/text-embedding-3-small  →  1536-dim Float32Array per text
 *   Auth: Bearer GITHUB_TOKEN  (env var)
 *   Free tier: 15 req/min · 150 req/day · 64k tokens/req — ALWAYS batched.
 *
 * Fallback: @huggingface/transformers  Xenova/all-MiniLM-L6-v2  →  384-dim
 *   Used ONLY when GITHUB_TOKEN is absent at startup. Never switched mid-run.
 *
 * CRITICAL: The model is chosen ONCE at startup based on token presence and
 * never changes. Mixing 1536-dim and 384-dim vectors in one DB corrupts cosine
 * retrieval. On persistent GitHub Models failure (after retries), we THROW
 * rather than silently falling back to MiniLM.
 *
 * Test hook: set GH_MODELS_TEST_NOWAIT=1 to skip retry waits in tests.
 */

import { withRetry, RetryableError } from '../util/retry.ts';

const GITHUB_MODELS_URL = 'https://models.github.ai/inference/embeddings';
const GITHUB_MODEL_ID   = 'openai/text-embedding-3-small';
const MINILM_MODEL_ID   = 'Xenova/all-MiniLM-L6-v2';

// ---------------------------------------------------------------------------
// Model selection — decided ONCE at module load time, never changes mid-run.
// ---------------------------------------------------------------------------

/**
 * Whether this run uses GitHub Models (true) or MiniLM (false).
 * Determined by the presence of GITHUB_TOKEN at module load time.
 *
 * Exported for tests only — do not mutate from outside this module.
 */
export const USE_GITHUB = Boolean(process.env.GITHUB_TOKEN);

// ---------------------------------------------------------------------------
// MiniLM (offline) implementation
// ---------------------------------------------------------------------------

/** Lazy-loaded MiniLM pipeline — initialised once on first use. */
let _miniLMPipeline: ((text: string, opts: { pooling: string; normalize: boolean }) => Promise<{ data: Float32Array }>) | null = null;

async function _getMiniLM(): Promise<(text: string, opts: { pooling: string; normalize: boolean }) => Promise<{ data: Float32Array }>> {
  if (_miniLMPipeline) return _miniLMPipeline;
  const { pipeline } = await import('@huggingface/transformers');
  // Keep in Node process memory; dtype float32 for consistency.
  const pipe = await pipeline('feature-extraction', MINILM_MODEL_ID, {
    dtype: 'fp32',
  });
  _miniLMPipeline = pipe as unknown as (text: string, opts: { pooling: string; normalize: boolean }) => Promise<{ data: Float32Array }>;
  return _miniLMPipeline;
}

/**
 * Embed texts with MiniLM (offline mode — no network).
 */
async function _miniLMEmbed(texts: string[]): Promise<Float32Array[]> {
  const pipe = await _getMiniLM();
  const results: Float32Array[] = [];
  for (const text of texts) {
    // mean-pool the token embeddings → single fixed-size vector.
    const output = await pipe(text, { pooling: 'mean', normalize: true });
    results.push(new Float32Array(output.data));
  }
  return results;
}

// ---------------------------------------------------------------------------
// GitHub Models implementation — with retry on 429/5xx
// ---------------------------------------------------------------------------

/**
 * Single attempt to call GitHub Models embeddings endpoint.
 * Throws RetryableError on 429/5xx so withRetry can back off.
 * Throws plain Error on other failures (no retry).
 */
async function _githubEmbedAttempt(texts: string[]): Promise<Float32Array[]> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN not set');

  const body = JSON.stringify({ model: GITHUB_MODEL_ID, input: texts });
  const res = await fetch(GITHUB_MODELS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body,
  });

  if (res.status === 429) {
    throw new RetryableError(
      `GitHub Models embeddings rate limited (429, free tier)`,
      429,
      res.headers,
    );
  }

  if (res.status >= 500 && res.status < 600) {
    const text = await res.text().catch(() => '');
    throw new RetryableError(
      `GitHub Models embeddings ${res.status}: ${text.slice(0, 200)}`,
      res.status,
      res.headers,
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub Models embeddings ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = await res.json() as { data?: Array<{ embedding: number[] }> };
  if (!Array.isArray(json.data) || json.data.length !== texts.length) {
    throw new Error(
      `GitHub Models: unexpected response shape (expected data[${texts.length}], got ${Array.isArray(json.data) ? json.data.length : typeof json.data})`
    );
  }
  // Response order matches input order per OpenAI-compatible spec.
  return json.data.map(d => new Float32Array(d.embedding));
}

/**
 * Call GitHub Models embeddings with retry on 429/5xx.
 * Throws if all retries are exhausted — does NOT fall back to MiniLM.
 */
async function _githubEmbed(texts: string[]): Promise<Float32Array[]> {
  try {
    return await withRetry(() => _githubEmbedAttempt(texts), {
      maxAttempts: 6,
      baseMs: 2_000,
      maxWaitMs: 30_000,
    });
  } catch (err: unknown) {
    // Re-throw with a clear, actionable message.
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `GitHub Models embeddings failed after retries (${detail}).\n` +
        `Re-run later (free-tier limit) or unset GITHUB_TOKEN to use the offline MiniLM model for the whole run.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Embed an array of texts in a single batched request.
 *
 * Model is chosen ONCE at startup:
 *   - GITHUB_TOKEN present → GitHub Models (1536-dim). Retries on 429/5xx.
 *     Throws (never falls back) if retries exhausted.
 *   - GITHUB_TOKEN absent  → MiniLM offline (384-dim). No network.
 *
 * @param texts  — may be empty (returns [])
 * @returns one Float32Array per input text
 */
export async function embed(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];

  if (USE_GITHUB) {
    // Throws on persistent failure. Never falls back to MiniLM.
    return await _githubEmbed(texts);
  }

  return await _miniLMEmbed(texts);
}

/**
 * Returns the embedding model name for this run.
 *
 * The model is locked at module load time (token presence). This is correct
 * even before the first embed() call, so meta.embedding_model is consistent.
 */
export function embedderName(): string {
  return USE_GITHUB ? GITHUB_MODEL_ID : MINILM_MODEL_ID;
}
