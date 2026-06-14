/**
 * Lazy-init LLM sessions with three selectable backends.
 *
 * Model is per-SESSION (not per-call) per the SDK design.
 *   cheap    = gpt-4o-mini  → importance scoring, judge, ingest helpers
 *   frontier = gpt-4o       → interview answer drafting
 *
 * ── Backend selection (priority order) ──────────────────────────────────────
 *
 * 1. COPILOT_STUB=1  → in-process stub (no network, tests / CI).
 *    All consumers receive a deterministic echo response.
 *
 * 2. LLM_BACKEND=copilot  → @github/copilot-sdk (requires Copilot subscription
 *    and `gh auth login`). The existing SDK path is preserved unchanged.
 *
 * 3. (DEFAULT) GitHub Models chat completions  → free with any GitHub PAT.
 *    Set GITHUB_TOKEN in your .env or shell. No Copilot subscription needed.
 *    Endpoint: https://models.github.ai/inference/chat/completions
 *    Models: openai/gpt-4o-mini (cheap) / openai/gpt-4o (frontier).
 *
 * ── Auth notes ───────────────────────────────────────────────────────────────
 *
 * GitHub Models default: add GITHUB_TOKEN=<pat> to .env (no special scopes).
 * Copilot SDK path: run `gh auth login` with a Copilot-enabled account.
 *   Missing auth causes the SDK to throw an opaque error — we rethrow with an
 *   actionable message.
 *
 * ── API shape note ───────────────────────────────────────────────────────────
 *
 * The real SDK's sendAndWait returns AssistantMessageEvent|undefined (where
 * text lives at event.data.content), whereas all consumers (importance.ts,
 * reflector.ts, drafter.ts, judge.ts) expect Promise<{ text: string }>.
 * The Copilot SDK wrapper adapts the response shape; GitHub Models returns the
 * correct shape natively.
 */

// ---------------------------------------------------------------------------
// Shared interface — re-exported so all modules agree on the structural type.
// importance.ts defines the authoritative copy; we re-export it here.
// ---------------------------------------------------------------------------
export type { CopilotSession } from '../ingest/importance.ts';
import type { CopilotSession } from '../ingest/importance.ts';

// ---------------------------------------------------------------------------
// GitHub Models backend (default)
// ---------------------------------------------------------------------------
import { makeGithubModelsSession, GH_CHEAP_MODEL, GH_FRONTIER_MODEL } from './github-models.ts';

// ---------------------------------------------------------------------------
// Module-level singletons
// ---------------------------------------------------------------------------
let _cheapSession: CopilotSession | null = null;
let _frontierSession: CopilotSession | null = null;

// ---------------------------------------------------------------------------
// Stub session (COPILOT_STUB=1 / tests)
// ---------------------------------------------------------------------------

/**
 * Build a minimal stub session for testing without a real Copilot token.
 * Satisfies the CopilotSession interface and records _model for assertions.
 */
function makeStubSession(model: string): CopilotSession & { _model: string } {
  return {
    _model: model,
    async sendAndWait({ prompt }: { prompt: string }): Promise<{ text: string }> {
      // Return a plausible-looking response so callers don't crash.
      return { text: `[STUB ${model}] ${prompt.slice(0, 40)}` };
    },
  };
}

// ---------------------------------------------------------------------------
// Real session (wraps the Copilot SDK; adapts response shape)
// ---------------------------------------------------------------------------

/**
 * Initialise a real Copilot SDK session and return a CopilotSession-shaped
 * wrapper.  The wrapper translates AssistantMessageEvent → { text } so
 * importance.ts / reflector.ts / any future consumer all see a uniform shape.
 *
 * @param model  Model ID (e.g. "gpt-4o-mini", "gpt-4o").
 */
async function makeRealSession(model: string): Promise<CopilotSession & { _model: string }> {
  // Dynamic import keeps the module loadable even without the SDK installed.
  let CopilotClientCtor: typeof import('@github/copilot-sdk').CopilotClient;
  try {
    const mod = await import('@github/copilot-sdk');
    CopilotClientCtor = mod.CopilotClient;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `@github/copilot-sdk not installed. Run: npm install @github/copilot-sdk\n` +
        `(original: ${msg})`,
    );
  }

  const client = new CopilotClientCtor();

  // start() is called automatically by createSession (autoStart:true is the
  // default), but we call it explicitly so we can give a clear auth error.
  try {
    await client.start();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Copilot SDK failed to start. Ensure you are logged in with GitHub Copilot access:\n` +
        `  gh auth login\n` +
        `Then verify: gh auth status\n` +
        `If using a PAT, set GITHUB_TOKEN with "Copilot Requests" permission.\n` +
        `(original error: ${msg})`,
    );
  }

  // Per the research doc: model is selected at session creation (per-session,
  // not per-call).  createSession({ model }) is the verified API.
  // onPermissionRequest is required by SessionConfig; we use approveAll so
  // tool calls (if any) are not blocked.  For prompt-only sessions this is
  // effectively a no-op.
  let sdkSession: import('@github/copilot-sdk').CopilotSession;
  try {
    const { approveAll } = await import('@github/copilot-sdk');
    sdkSession = await client.createSession({ model, onPermissionRequest: approveAll });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Failed to create Copilot session for model "${model}". ` +
        `Check your Copilot subscription and that the model ID is valid.\n` +
        `(original error: ${msg})`,
    );
  }

  // Wrap: adapt AssistantMessageEvent|undefined → { text: string }.
  // The SDK sendAndWait returns the final AssistantMessageEvent when the
  // session goes idle (data.content = the assistant's text response).
  const wrapper: CopilotSession & { _model: string } = {
    _model: model,
    async sendAndWait({ prompt }: { prompt: string }): Promise<{ text: string }> {
      let event: import('@github/copilot-sdk').AssistantMessageEvent | undefined;
      try {
        event = await sdkSession.sendAndWait({ prompt });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`Copilot sendAndWait failed (model=${model}): ${msg}`);
      }

      // event is undefined if the session went idle with no assistant message
      // (e.g. empty prompt or tool-only response).  Return empty text so
      // callers that parse JSON don't throw — importance.ts handles parse
      // failures via its own retry + default-score path.
      const text = event?.data?.content ?? '';
      return { text };
    },
  };

  return wrapper;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns (and lazily creates) the cheap session backed by gpt-4o-mini.
 * Use for: importance scoring, judge verification, batch ingest helpers.
 *
 * Backend selection:
 *   COPILOT_STUB=1       → in-process stub (no network)
 *   LLM_BACKEND=copilot  → Copilot SDK (requires gh auth login + subscription)
 *   (default)            → GitHub Models via GITHUB_TOKEN (free PAT)
 */
export async function getCheapSession(): Promise<CopilotSession & { _model: string }> {
  if (_cheapSession) return _cheapSession as CopilotSession & { _model: string };
  if (process.env['COPILOT_STUB'] === '1') {
    _cheapSession = makeStubSession('gpt-4o-mini');
    return _cheapSession as CopilotSession & { _model: string };
  }
  if (process.env['LLM_BACKEND'] === 'copilot') {
    _cheapSession = await makeRealSession('gpt-4o-mini');
    return _cheapSession as CopilotSession & { _model: string };
  }
  // Default: GitHub Models (free tier, no Copilot subscription required).
  // Cheap session powers the grounding judge + importance scorer — keep it
  // near-deterministic (low temp) so verdicts/scores are stable.
  const ghSession = makeGithubModelsSession(GH_CHEAP_MODEL, { temperature: 0.1 });
  _cheapSession = Object.assign(ghSession, { _model: GH_CHEAP_MODEL });
  return _cheapSession as CopilotSession & { _model: string };
}

/**
 * Returns (and lazily creates) the frontier session backed by gpt-4o.
 * Use for: interview answer drafting ONLY (one call per interview question).
 *
 * Backend selection:
 *   COPILOT_STUB=1       → in-process stub (no network)
 *   LLM_BACKEND=copilot  → Copilot SDK (requires gh auth login + subscription)
 *   (default)            → GitHub Models via GITHUB_TOKEN (free PAT)
 */
export async function getFrontierSession(): Promise<CopilotSession & { _model: string }> {
  if (_frontierSession) return _frontierSession as CopilotSession & { _model: string };
  if (process.env['COPILOT_STUB'] === '1') {
    _frontierSession = makeStubSession('gpt-4o');
    return _frontierSession as CopilotSession & { _model: string };
  }
  if (process.env['LLM_BACKEND'] === 'copilot') {
    _frontierSession = await makeRealSession('gpt-4o');
    return _frontierSession as CopilotSession & { _model: string };
  }
  // Default: GitHub Models (free tier, no Copilot subscription required).
  // Frontier session drafts the answer — low temp keeps it grounded.
  const ghSession = makeGithubModelsSession(GH_FRONTIER_MODEL, { temperature: 0.3 });
  _frontierSession = Object.assign(ghSession, { _model: GH_FRONTIER_MODEL });
  return _frontierSession as CopilotSession & { _model: string };
}

/**
 * Reset cached sessions.
 * Exported for tests that need a fresh instance per test case.
 * Not intended for production use.
 */
export function _resetSessions(): void {
  _cheapSession = null;
  _frontierSession = null;
}
