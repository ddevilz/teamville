/**
 * GitHub Models chat-completions backend.
 *
 * Uses the free GitHub Models inference endpoint — no Copilot subscription
 * required, only a standard GitHub personal access token (GITHUB_TOKEN).
 *
 * Endpoint: https://models.github.ai/inference/chat/completions
 * Docs:     https://docs.github.com/en/github-models
 *
 * Implements the CopilotSession interface so all existing consumers
 * (importance.ts, reflector.ts, drafter.ts, judge.ts, pipeline.ts) work
 * without modification.
 *
 * Rate limits (free tier): see GitHub Models quotas per model.
 * On 429/5xx: retries with exponential backoff (up to 6 attempts, max 30s wait
 * per attempt, respecting Retry-After header). After exhausting retries on 429,
 * throws with a clear message including instructions to switch backends.
 *
 * Test hook: set GH_MODELS_TEST_NOWAIT=1 to skip all wait times in tests.
 */

import type { CopilotSession } from '../ingest/importance.ts';
import { withRetry, RetryableError } from '../util/retry.ts';

// ---------------------------------------------------------------------------
// Model ID constants — export so copilot.ts and callers can reference them.
// ---------------------------------------------------------------------------

/** Cheap model: fast, low-cost, suitable for scoring / judge / ingest. */
export const GH_CHEAP_MODEL = 'openai/gpt-4o-mini';

/** Frontier model: higher quality, for interview answer drafting. */
export const GH_FRONTIER_MODEL = 'openai/gpt-4o';

// ---------------------------------------------------------------------------
// GitHub Models chat-completions response shape (partial)
// ---------------------------------------------------------------------------

interface GHModelsChoice {
  message?: {
    content?: string | null;
  };
}

interface GHModelsResponse {
  choices?: GHModelsChoice[];
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a CopilotSession backed by GitHub Models chat completions.
 *
 * @param model  Model ID accepted by the GitHub Models endpoint,
 *               e.g. 'openai/gpt-4o-mini' or 'openai/gpt-4o'.
 * @param opts   Optional sampling config. temperature defaults to 0.3 — low, so
 *               grounded answers stay grounded and judge verdicts stay stable
 *               (drafts that wander get rejected by the grounding judge).
 * @throws       If GITHUB_TOKEN is not set, or on non-retryable HTTP error.
 */
export function makeGithubModelsSession(
  model: string,
  opts: { temperature?: number } = {},
): CopilotSession {
  const ENDPOINT = 'https://models.github.ai/inference/chat/completions';
  const temperature = opts.temperature ?? 0.3;

  return {
    async sendAndWait({ prompt }: { prompt: string }): Promise<{ text: string }> {
      const token = process.env['GITHUB_TOKEN'];
      if (!token) {
        throw new Error(
          'GITHUB_TOKEN is not set. ' +
            'Add it to your .env file or export it in your shell:\n' +
            '  GITHUB_TOKEN=<your_personal_access_token>\n' +
            'Generate one at https://github.com/settings/tokens (no special scopes needed for GitHub Models).',
        );
      }

      const body = JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature,
        max_tokens: 800,
      });

      /**
       * Single attempt: performs one fetch and either returns or throws a
       * RetryableError (for 429/5xx) or a plain Error (for other failures).
       */
      const attempt = async (): Promise<{ text: string }> => {
        let response: Response;
        try {
          response = await fetch(ENDPOINT, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body,
          });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          throw new Error(`GitHub Models network error (model=${model}): ${msg}`);
        }

        // 429: throw a RetryableError so withRetry will back off and retry.
        if (response.status === 429) {
          throw new RetryableError(
            `GitHub Models rate limit hit for ${model} (free tier). ` +
              `Wait and retry, or set LLM_BACKEND=copilot.`,
            429,
            response.headers,
          );
        }

        // 5xx: throw a RetryableError so withRetry will back off and retry.
        if (response.status >= 500 && response.status < 600) {
          let bodyText = '';
          try { bodyText = await response.text(); } catch { /* ignore */ }
          throw new RetryableError(
            `GitHub Models ${response.status}: ${bodyText.slice(0, 200)}`,
            response.status,
            response.headers,
          );
        }

        // 4xx other than 429: fail immediately (no retry).
        if (!response.ok) {
          let bodyText = '';
          try { bodyText = await response.text(); } catch { /* ignore */ }
          throw new Error(
            `GitHub Models ${response.status}: ${bodyText.slice(0, 200)}`,
          );
        }

        // 200 OK — parse and return.
        let json: GHModelsResponse;
        try {
          json = (await response.json()) as GHModelsResponse;
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          throw new Error(`GitHub Models returned non-JSON response (model=${model}): ${msg}`);
        }

        const text = json.choices?.[0]?.message?.content ?? '';
        return { text };
      };

      try {
        return await withRetry(attempt, {
          maxAttempts: 6,
          baseMs: 2_000,
          maxWaitMs: 30_000,
        });
      } catch (err: unknown) {
        // If the final error is a RetryableError from a 429, make the message
        // more actionable (add Retry-After hint if available).
        if (err instanceof RetryableError && err.status === 429) {
          const retryAfterMs = err.headers
            ? (err.headers.get('Retry-After') ? ` Retry-After: ${err.headers.get('Retry-After')}s.` : '')
            : '';
          throw new Error(
            `GitHub Models rate limit hit for ${model} (free tier) after 6 attempts.${retryAfterMs} ` +
              `Wait and retry, or set LLM_BACKEND=copilot.`,
          );
        }
        throw err;
      }
    },
  };
}
