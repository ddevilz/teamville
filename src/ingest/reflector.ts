/**
 * Reflection pass (Park et al. §3.3).
 *
 * Algorithm:
 *   1. Walk person's memories in sim_time order.
 *   2. Accumulate importance. Each time the running sum exceeds REFLECT_THRESHOLD (150):
 *      a. Collect the N most recent non-thought memories that pushed us over.
 *      b. Prompt for 3 focal questions from those memories.
 *      c. For each focal question: retrieve top-15 memories via Park et al. scoring.
 *      d. Prompt for insights (freeform; parse "(because of N, M)" pointers).
 *      e. Insert each insight as a kind='thought' memory with evidence_ids.
 *      f. Reset accumulator.
 *
 * The reflector is called once per person at ingest time; thoughts are stored
 * with their sim_time set to the moment the budget would have tripped.
 *
 * @param session  Cheap Copilot session (gpt-4o-mini).
 * @param db       Open better-sqlite3 database handle.
 * @param personId Person to reflect for.
 * @param embedFn  Embed function injected in tests; defaults to real embedder.
 */

import { getMemoriesForPerson, insertMemory } from '../memory/db.ts';
import { scoreImportance, type CopilotSession } from './importance.ts';
import type { MemoryRow } from '../memory/db.ts';
import { retrieveWithTrace, type MemoryInput } from '../memory/retrieve.ts';

export type { CopilotSession };

const REFLECT_THRESHOLD = 150;
const TOP_K = 15;

// ---------------------------------------------------------------------------
// Prompt helpers
// ---------------------------------------------------------------------------

/**
 * Parse focal questions from LLM response.
 * Tries JSON array first; falls back to numbered lines.
 */
function parseFocalQuestions(text: string): string[] {
  const stripped = text.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
  const match = stripped.match(/\[[\s\S]*?\]/);
  if (match) {
    try {
      const arr: unknown = JSON.parse(match[0]);
      if (Array.isArray(arr)) {
        return (arr as unknown[])
          .filter((s): s is string => typeof s === 'string')
          .slice(0, 3);
      }
    } catch {
      // fall through
    }
  }

  // Fallback: numbered lines "1. question text"
  return text
    .split('\n')
    .map(l => l.replace(/^\d+\.\s*/, '').trim())
    .filter(l => l.length > 10)
    .slice(0, 3);
}

/**
 * Parse insights from LLM response.
 * Expected format per line: "N. Insight text (because of M, K, ...)"
 *
 * @param text            Raw LLM response.
 * @param evidenceMems    The memories passed as numbered context (1-indexed in the prompt).
 */
function parseInsights(
  text: string,
  evidenceMems: Pick<MemoryInput, 'id'>[],
): Array<{ text: string; evidenceIds: number[] }> {
  const results: Array<{ text: string; evidenceIds: number[] }> = [];

  for (const line of text.split('\n')) {
    const clean = line.replace(/^[\d\-*]+[.)]\s*/, '').trim();
    if (!clean) continue;

    // Extract "(because of N, M, K)"
    const becauseMatch = clean.match(/\(because of ([\d,\s]+)\)/i);
    let evidenceIds: number[] = [];
    if (becauseMatch) {
      evidenceIds = becauseMatch[1]
        .split(',')
        .map(s => parseInt(s.trim(), 10) - 1)   // 1-based → 0-based index
        .filter(i => i >= 0 && i < evidenceMems.length)
        .map(i => evidenceMems[i].id)
        .filter((id): id is number => id != null);
    }

    const insightText = clean.replace(/\(because of [\d,\s]+\)/i, '').trim();
    if (insightText.length > 5) {
      results.push({ text: insightText, evidenceIds });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Run the reflection pass for one person.
 *
 * @param session   Cheap Copilot session (gpt-4o-mini or equivalent).
 * @param db        Open better-sqlite3 database.
 * @param personId  Person to reflect for.
 * @param embedFn   Embed function (injected in tests; defaults to real embedder).
 */
export async function reflect(
  session: CopilotSession,
  db: import('better-sqlite3').Database,
  personId: string,
  embedFn?: (texts: string[]) => Promise<Float32Array[]>,
): Promise<void> {
  // Late-bind real embedder if not injected (avoids circular dep at import time).
  if (!embedFn) {
    const { embed } = await import('./embedder.ts');
    embedFn = embed;
  }

  // Load all non-thought memories in chronological order.
  const allRows = getMemoriesForPerson(db, personId).filter(m => m.kind !== 'thought');

  if (allRows.length === 0) return;

  // Deserialize embeddings (stored as BLOB = Buffer of Float32Array bytes).
  // Only memories with a valid embedding are usable for cosine retrieval;
  // rows with null embedding are excluded at the retrievable-filter step.
  type MemoryWithOptEmbedding = Omit<MemoryRow, 'embedding'> & {
    embedding: Float32Array | null;
  };
  const allMemories: MemoryWithOptEmbedding[] = allRows.map(m => ({
    ...m,
    embedding: m.embedding
      ? new Float32Array(
          (m.embedding as Buffer).buffer,
          (m.embedding as Buffer).byteOffset,
          (m.embedding as Buffer).byteLength / 4,
        )
      : null,
  }));

  let budget = REFLECT_THRESHOLD;
  let windowStart = 0; // index of first memory in the current accumulation window

  for (let i = 0; i < allMemories.length; i++) {
    const mem = allMemories[i];
    budget -= mem.importance;

    if (budget <= 0) {
      // The window of memories that pushed us over the threshold.
      const windowMems = allMemories.slice(windowStart, i + 1);
      const triggerSimTime = mem.sim_time;

      // Step 1: Ask for 3 focal questions from the window.
      const windowDescriptions = windowMems
        .map((m, idx) => `${idx + 1}. ${m.text}`)
        .join('\n');

      const focalPrompt =
        `Given only the information below about a team member's recent experiences, ` +
        `what are the 3 most salient high-level questions we can answer about them?\n\n` +
        `Return a JSON array of exactly 3 question strings. No other text.\n\n` +
        `Experiences:\n${windowDescriptions}\n\nJSON array:`;

      const focalRes = await session.sendAndWait({ prompt: focalPrompt });
      const questions = parseFocalQuestions(focalRes.text);

      if (questions.length === 0) {
        // Unparseable response; skip this window and reset budget.
        budget = REFLECT_THRESHOLD;
        windowStart = i + 1;
        continue;
      }

      // Step 2: For each focal question, retrieve evidence and generate insights.
      for (const question of questions) {
        let queryEmbedding: Float32Array;
        try {
          [queryEmbedding] = await embedFn([question]);
        } catch {
          continue; // skip this question if embedding fails
        }

        // Only memories that have embeddings are eligible for cosine retrieval.
        const retrievable = allMemories.filter(
          (m): m is Omit<MemoryRow, 'embedding'> & { embedding: Float32Array } =>
            m.embedding !== null,
        ) as MemoryInput[];
        if (retrievable.length === 0) continue;

        // threshold=0: reflection always wants top memories regardless of cosine magnitude.
        const { top: evidenceMems } = retrieveWithTrace(
          retrievable,
          queryEmbedding,
          triggerSimTime,
          { n: TOP_K, threshold: 0 },
        );
        if (evidenceMems.length === 0) continue;

        const numberedEvidence = evidenceMems
          .map((m, idx) => `${idx + 1}. ${m.text}`)
          .join('\n');

        const insightPrompt =
          `What 5 high-level insights can you infer from the following statements about a team member?\n\n` +
          `For each insight, cite which statement numbers support it using the format: (because of N, M)\n\n` +
          `Statements:\n${numberedEvidence}\n\n` +
          `Focal question: ${question}\n\n` +
          `Insights (one per line, include "(because of N, M)" citations):`;

        const insightRes = await session.sendAndWait({ prompt: insightPrompt });
        const insights = parseInsights(insightRes.text, evidenceMems);

        if (insights.length === 0) continue;

        // Step 3: Score importance and insert each insight as a thought memory.
        const insightTexts = insights.map(ins => ins.text);
        let importanceScores: number[];
        try {
          importanceScores = await scoreImportance(session, insightTexts);
        } catch {
          importanceScores = insightTexts.map(() => 5);
        }

        for (let j = 0; j < insights.length; j++) {
          const ins = insights[j];
          let insightEmbedding: Float32Array;
          try {
            [insightEmbedding] = await embedFn([ins.text]);
          } catch {
            insightEmbedding = new Float32Array(384); // zero vector fallback
          }

          insertMemory(db, {
            person_id: personId,
            kind: 'thought',
            text: ins.text,
            sim_time: triggerSimTime,
            last_access: triggerSimTime,
            importance: importanceScores[j] ?? 5,
            embedding: Buffer.from(insightEmbedding.buffer),
            source_ref: null,
            evidence_ids:
              ins.evidenceIds.length > 0 ? JSON.stringify(ins.evidenceIds) : null,
          });
        }
      }

      // Reset accumulator and advance window.
      budget = REFLECT_THRESHOLD;
      windowStart = i + 1;
    }
  }
}
