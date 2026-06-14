/**
 * Scores the importance (poignancy, 1–10) of memory texts using a cheap
 * Copilot session (gpt-4o-mini).  One prompt, many texts — batched to
 * minimise premium-request consumption.
 *
 * Prompt is verbatim from Park et al. poignancy_event_v1.txt, generalised
 * to score N events in one call by returning a JSON array.
 *
 * Retry strategy: one retry on parse failure; default 3 if both fail.
 * (ai-town uses default 5; we use 3 to be conservative for mundane chatter.)
 */

const DEFAULT_SCORE = 3;

/**
 * Minimal structural interface for a Copilot session.
 * Section 4 will define the real SDK type; this stays structural so any
 * object with a matching sendAndWait method satisfies it (including fakes).
 */
export interface CopilotSession {
  sendAndWait(opts: { prompt: string }): Promise<{ text: string }>;
}

/**
 * Build the batch-scoring prompt.
 */
function buildPrompt(texts: string[]): string {
  const numbered = texts.map((t, i) => `${i + 1}. ${t}`).join('\n');
  return `You are scoring the poignancy/importance of workplace memory events.

On a scale of 1 to 10, where:
  1 = purely mundane (e.g. "made coffee", "checked calendar")
  5 = moderately significant (e.g. "attended a team meeting")
  10 = extremely important (e.g. "production outage, blocked launch, major decision")

Rate each of the following ${texts.length} event(s) for a software team member.
Return ONLY a JSON array of integers with exactly ${texts.length} element(s).
No explanation. No markdown prose. Just the array.

Events:
${numbered}

Response (JSON array only):`;
}

/**
 * Parse the LLM response to extract a numeric array.
 * Strips markdown code fences if present.
 * Returns null if parsing fails or array length doesn't match.
 */
function parseResponse(text: string, expected: number): number[] | null {
  // Strip code fences: ```json ... ``` or ``` ... ```
  const stripped = text.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();

  // Find the first JSON array in the response.
  const match = stripped.match(/\[[\d\s,.\-]+\]/);
  if (!match) return null;

  let arr: unknown;
  try {
    arr = JSON.parse(match[0]);
  } catch {
    return null;
  }

  if (!Array.isArray(arr) || arr.length !== expected) return null;
  if (!(arr as unknown[]).every(v => typeof v === 'number' && isFinite(v as number))) return null;

  return (arr as number[]).map(v => Math.min(10, Math.max(1, Math.round(v))));
}

/**
 * Score the importance of an array of memory texts (1–10 each).
 * Sends ONE prompt to the cheap session regardless of array size.
 *
 * @param session  Cheap Copilot session (gpt-4o-mini or equivalent).
 * @param texts    Memory descriptions to score.
 * @returns        Importance scores, same order as input.
 */
export async function scoreImportance(
  session: CopilotSession,
  texts: string[],
): Promise<number[]> {
  if (texts.length === 0) return [];

  const prompt = buildPrompt(texts);

  // Attempt 1
  const res1 = await session.sendAndWait({ prompt });
  const parsed1 = parseResponse(res1.text, texts.length);
  if (parsed1) return parsed1;

  // Attempt 2 — one retry with an explicit nudge
  const retryPrompt =
    prompt + '\n\nIMPORTANT: Return ONLY the JSON array. Example: [4, 7, 2]';
  const res2 = await session.sendAndWait({ prompt: retryPrompt });
  const parsed2 = parseResponse(res2.text, texts.length);
  if (parsed2) return parsed2;

  // Default fallback
  console.warn(
    `[importance] Failed to parse scores after retry; defaulting all to ${DEFAULT_SCORE}. ` +
      `Last response: ${res2.text.slice(0, 120)}`,
  );
  return texts.map(() => DEFAULT_SCORE);
}
