/**
 * Interview answer judge.
 *
 * Uses the cheap session (gpt-4o-mini) to verify that:
 *   1. Every factual claim in the answer is grounded in a cited memory.
 *   2. The answer is safe and non-speculative.
 *
 * Returns { pass: boolean, reason: string }.
 * Any parse failure returns { pass: false, reason: 'judge parse error' } —
 * this intentionally blocks the answer rather than silently passing junk.
 * (Fail-closed — scenario S11 safety gate.)
 */

import type { CopilotSession } from '../ingest/importance.ts';

// ---------------------------------------------------------------------------
// Memory shape (structural — matches MemoryRow but avoids a hard DB import)
// ---------------------------------------------------------------------------

interface MemoryLike {
  id: number;
  text: string;
  sim_time: number;
  kind: string;
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface JudgeResult {
  pass: boolean;
  reason: string;
}

// ---------------------------------------------------------------------------
// extractJson (private helper)
// ---------------------------------------------------------------------------

/**
 * Extract a JSON object substring from raw text that may contain prose or
 * markdown code fences.
 *
 * @param raw - raw LLM response text
 * @returns the extracted JSON substring, or raw unchanged if nothing found
 */
function extractJson(raw: string): string {
  // Try markdown code fence first: ```json ... ``` or ``` ... ```
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) return fenceMatch[1].trim();

  // Try to find first { ... } block (handles prose-before-JSON)
  const braceStart = raw.indexOf('{');
  const braceEnd = raw.lastIndexOf('}');
  if (braceStart !== -1 && braceEnd > braceStart) {
    return raw.slice(braceStart, braceEnd + 1);
  }

  return raw;
}

// ---------------------------------------------------------------------------
// parseJudgeResponse
// ---------------------------------------------------------------------------

/**
 * Parse the judge LLM response into { pass, reason }.
 * Returns { pass: false, reason: 'judge parse error' } on any parse failure —
 * never throws.
 *
 * @param raw - raw text from the LLM
 * @returns JudgeResult
 */
export function parseJudgeResponse(raw: string): JudgeResult {
  if (!raw || typeof raw !== 'string') {
    return { pass: false, reason: 'judge parse error' };
  }

  try {
    const json = extractJson(raw.trim());
    const obj = JSON.parse(json) as Record<string, unknown>;

    if (typeof obj['pass'] !== 'boolean') {
      return { pass: false, reason: 'judge parse error' };
    }

    return {
      pass: obj['pass'],
      reason: typeof obj['reason'] === 'string' ? obj['reason'] : String(obj['reason'] ?? ''),
    };
  } catch {
    return { pass: false, reason: 'judge parse error' };
  }
}

// ---------------------------------------------------------------------------
// buildJudgePrompt
// ---------------------------------------------------------------------------

/**
 * Build the judge verification prompt.
 *
 * @param question - the interview question
 * @param answer   - the drafted answer with [n] citation markers
 * @param memories - same array passed to draftAnswer (order matters — [1] = index 0)
 * @returns prompt string
 */
export function buildJudgePrompt(
  question: string,
  answer: string,
  memories: MemoryLike[],
): string {
  const memoryLines = memories.map((m, i) => `[${i + 1}] ${m.text}`).join('\n');

  return [
    'You are a strict grounding and safety verifier for an AI agent answer system.',
    '',
    'TASK: Verify the following answer against the provided source memories.',
    '',
    'CHECK 1 — GROUNDING: Every factual claim in the answer MUST be traceable to a cited memory [n].',
    "  - If any claim lacks a citation, or the cited memory does not support the claim → FAIL.",
    "  - If the answer says \"I don't have information\" → PASS (honest decline is always grounded).",
    '',
    'CHECK 2 — SAFETY: The answer must not contain:',
    '  - Speculation presented as fact',
    '  - Opinions about individuals not grounded in cited evidence',
    '  - Sensitive personal information (salary, health, private matters)',
    '  - Potentially harmful or legally problematic claims',
    '',
    'OUTPUT: Respond with ONLY a JSON object, no prose before or after:',
    '{"pass": true|false, "reason": "one sentence explanation"}',
    '',
    '---',
    `QUESTION: ${question}`,
    '',
    'SOURCE MEMORIES:',
    memoryLines,
    '',
    `ANSWER TO VERIFY:\n${answer}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// judgeAnswer
// ---------------------------------------------------------------------------

/**
 * Run the judge verification against a drafted answer.
 *
 * Uses the CHEAP session (gpt-4o-mini) — this is a safety gate, not a
 * frontier model call.
 *
 * @param session   - cheap Copilot session (from getCheapSession())
 * @param question  - the interview question
 * @param answer    - the drafted answer (with [n] citation markers)
 * @param memories  - same array passed to draftAnswer
 * @returns Promise<JudgeResult> — never rejects; parse errors → fail-closed
 */
export async function judgeAnswer(
  session: CopilotSession,
  question: string,
  answer: string,
  memories: MemoryLike[],
): Promise<JudgeResult> {
  const prompt = buildJudgePrompt(question, answer, memories);

  const response = await session.sendAndWait({ prompt });

  // CopilotSession.sendAndWait returns { text: string }
  const raw = response?.text ?? '';

  return parseJudgeResponse(raw);
}
