/**
 * Interview pipeline — the only live AI path in Teamville.
 *
 * Flow:
 *   1. Load person from DB → error if not found
 *   2. Load person's memories from DB
 *   3. Embed the question
 *   4. retrieveWithTrace with nowSimTime = SIM_END (always end-of-week perspective)
 *   5. Decline gate: declined=true → return { status:'declined' }
 *      (no LLM call, no touchMemories, no insertInterview)
 *   6. Draft answer — attempt 1 (frontier session)
 *   7. Judge answer — attempt 1 (cheap session)
 *   8a. Attempt 1 passes → proceed
 *   8b. Attempt 1 blocked → retry: draft again (conservative=true) + judge again
 *       8b-i.  Attempt 2 passes → proceed
 *       8b-ii. Attempt 2 blocked → return { status:'blocked', answer:null }
 *              (returns attempt 2's verdict reason; no touchMemories, no insertInterview)
 *   9. touchMemories (update last_access for retrieved memories)
 *  10. insertInterview (persist Q&A)
 *  11. Return full InterviewResult with status:'answered'
 *
 * SIM_END is always used for "now" regardless of the UI scrubber position.
 * This avoids negative-decay bugs when the scrubber is dragged backwards.
 */

import { getCheapSession, getFrontierSession } from './copilot.ts';
import { draftAnswer as _draftAnswer } from './drafter.ts';
import { judgeAnswer as _judgeAnswer } from './judge.ts';
import { embed as _embed, embedderName as _embedderName } from '../ingest/embedder.ts';
import {
  retrieveWithTrace as _retrieveWithTrace,
  RELEVANCE_THRESHOLD,
} from '../memory/retrieve.ts';
import type { MemoryInput } from '../memory/retrieve.ts';
import {
  getPeople as _getPeople,
  getMemoriesForPerson as _getMemoriesForPerson,
  touchMemories as _touchMemories,
  insertInterview as _insertInterview,
  getMeta as _getMeta,
} from '../memory/db.ts';
import type Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Frozen constant — ALWAYS end-of-week perspective for interviews.
// ---------------------------------------------------------------------------

export const SIM_END = Date.parse('2026-06-12T18:00:00Z');

// ---------------------------------------------------------------------------
// Return types
// ---------------------------------------------------------------------------

export interface Citation {
  /** 1-based citation number for display */
  n: number;
  memoryId: number;
  text: string;
  simTime: number;
  sourceRef: string | null;
}

export interface MemoryTraceEntry {
  memoryId: number;
  text: string;
  kind: string;
  /** Raw recency decay score */
  recency: number;
  /** Raw cosine similarity */
  relevance: number;
  /** Raw importance (1-10) */
  importance: number;
  /** Weighted combined score */
  score: number;
  aboveThreshold: boolean;
}

export interface InterviewResult {
  status: 'answered' | 'declined' | 'blocked';
  /** null when declined or blocked */
  answer: string | null;
  /** Empty when declined or blocked */
  citations: Citation[];
  /** Always populated — UI shows it even on decline to visualise candidates */
  memoryTrace: MemoryTraceEntry[];
  /** null when declined */
  verdict: { pass: boolean; reason: string } | null;
}

// ---------------------------------------------------------------------------
// Dependency injection slot for tests
// ---------------------------------------------------------------------------

/**
 * Override shape for test injection.
 * All fields optional — omit to fall through to real implementations.
 */
export interface PipelineDeps {
  embed?: (texts: string[]) => Promise<Float32Array[]>;
  embedderName?: () => string;
  getMeta?: (db: Database.Database, key: string) => string | null;
  getFrontierSession?: () => Promise<Awaited<ReturnType<typeof getFrontierSession>>>;
  getCheapSession?: () => Promise<Awaited<ReturnType<typeof getCheapSession>>>;
  retrieveWithTrace?: (
    memories: MemoryInput[],
    queryEmbedding: Float32Array | number[],
    nowSimTime: number,
    opts?: { n?: number; threshold?: number },
  ) => ReturnType<typeof _retrieveWithTrace>;
  draftAnswer?: (
    session: Awaited<ReturnType<typeof getCheapSession>>,
    persona: { id: string; name: string; role: string; persona_json: string },
    question: string,
    memories: MemoryInput[],
    conservative?: boolean,
  ) => Promise<{ answer: string; citedIds: number[] }>;
  judgeAnswer?: (
    session: Awaited<ReturnType<typeof getCheapSession>>,
    question: string,
    answer: string,
    memories: MemoryInput[],
  ) => Promise<{ pass: boolean; reason: string }>;
  getPeople?: (db: Database.Database) => Array<{
    id: string;
    name: string;
    role: string;
    persona_json: string;
    sprite?: string;
    desk_x?: number;
    desk_y?: number;
  }>;
  getMemoriesForPerson?: (db: Database.Database, personId: string) => Array<{
    id: number;
    text: string;
    sim_time: number;
    last_access: number;
    importance: number;
    kind: string;
    source_ref: string | null;
    evidence_ids: string | null;
    embedding: Buffer | Float32Array | null;
    person_id: string;
  }>;
  touchMemories?: (db: Database.Database, ids: number[], nowSimTime: number) => void;
  insertInterview?: (db: Database.Database, row: {
    person_id: string;
    q: string;
    a: string | null;
    cited_memory_ids: string | null;
    created_at: number;
  }) => number;
  /** If provided, overrides the DB object passed to getPeople/getMemoriesForPerson/etc. */
  db?: Database.Database;
}

let _deps: PipelineDeps | null = null;

/**
 * Override internal dependencies for testing.
 * Call _setDeps(null) or _setDeps({}) to revert to real implementations.
 */
export function _setDeps(deps: PipelineDeps | null): void {
  _deps = deps;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getDep<K extends keyof PipelineDeps>(name: K, fallback: NonNullable<PipelineDeps[K]>): NonNullable<PipelineDeps[K]> {
  const override = _deps?.[name];
  return (override ?? fallback) as NonNullable<PipelineDeps[K]>;
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

/**
 * Run the full interview pipeline.
 *
 * @param db       - open better-sqlite3 database instance
 * @param personId - must match a row in the people table
 * @param question - free-text interview question
 * @returns Promise<InterviewResult>
 * @throws Error with personId in message if personId is not found (route layer → 404)
 */
export async function runInterview(
  db: Database.Database,
  personId: string,
  question: string,
): Promise<InterviewResult> {
  // ---- 1. Load person -------------------------------------------------------
  const peopleGetter = getDep('getPeople', _getPeople);
  const people = peopleGetter(db);
  const person = people.find((p) => p.id === personId);
  if (!person) {
    const knownIds = people.map((p) => p.id).join(', ') || '(none)';
    throw new Error(
      `Unknown personId: "${personId}". Known IDs: ${knownIds}`,
    );
  }

  // ---- 2. Load raw memories -------------------------------------------------
  const memoryGetter = getDep('getMemoriesForPerson', _getMemoriesForPerson);
  const rawMemories = memoryGetter(db, personId);

  // Deserialise embeddings: stored as Buffer (SQLite BLOB) → Float32Array.
  const memories: MemoryInput[] = rawMemories.map((m) => {
    let embedding: Float32Array | number[];
    if (m.embedding instanceof Buffer) {
      embedding = new Float32Array(
        m.embedding.buffer,
        m.embedding.byteOffset,
        m.embedding.byteLength / 4,
      );
    } else if (m.embedding instanceof Float32Array) {
      embedding = m.embedding;
    } else {
      // null or unexpected — use zero vector so retrieve can still run
      embedding = new Float32Array(0);
    }
    return {
      id: m.id,
      person_id: m.person_id,
      kind: m.kind,
      text: m.text,
      sim_time: m.sim_time,
      last_access: m.last_access,
      importance: m.importance,
      embedding,
      source_ref: m.source_ref,
      evidence_ids: m.evidence_ids,
    };
  });

  // ---- 3. Embedding-model assertion (BEFORE embed()) -----------------------
  // Ingest writes embedding_model to meta. If the query path uses a different
  // model (or a different dim — e.g. GitHub Models 1536-dim vs MiniLM 384-dim),
  // cosine similarities are garbage. Fail fast with a clear error.
  const getMetaFn = getDep('getMeta', _getMeta);
  const storedModel = getMetaFn(db, 'embedding_model');
  if (storedModel === null) {
    throw new Error(
      'DB not ingested — run npm run ingest first.',
    );
  }
  const embedderNameFn = getDep('embedderName', _embedderName);
  const currentModel = embedderNameFn();
  if (storedModel !== currentModel) {
    throw new Error(
      `Embedding model mismatch: DB was ingested with "${storedModel}" but query path uses "${currentModel}". ` +
      `Re-run npm run db:reset && npm run ingest, or restore the matching model/GITHUB_TOKEN.`,
    );
  }

  // ---- 4. Embed question ----------------------------------------------------
  const embedFn = getDep('embed', _embed);
  const [queryEmbedding] = await embedFn([question]);

  // ---- 5. Retrieve with trace (nowSimTime = SIM_END, always) ----------------
  const retrieveFn = getDep('retrieveWithTrace', _retrieveWithTrace);
  const { top, trace, declined } = retrieveFn(
    memories,
    queryEmbedding,
    SIM_END,
    { threshold: RELEVANCE_THRESHOLD },
  );

  // Build memoryTrace payload — always returned (UI shows it even on decline).
  const memoryTrace: MemoryTraceEntry[] = trace.map((entry) => ({
    memoryId: entry.memoryId,
    text: entry.text,
    kind: entry.kind,
    recency: entry.recency,
    relevance: entry.relevance,
    importance: entry.importance,
    score: entry.score,
    aboveThreshold: entry.aboveThreshold,
  }));

  // ---- 6. Decline gate — no LLM, no DB writes ------------------------------
  if (declined) {
    return {
      status: 'declined',
      answer: null,
      citations: [],
      memoryTrace,
      verdict: null,
    };
  }

  // ---- 7. Draft answer (frontier session) -----------------------------------
  const getFrontierSessionFn = getDep('getFrontierSession', getFrontierSession);
  const frontierSession = await getFrontierSessionFn();
  const draftFn = getDep('draftAnswer', _draftAnswer);
  const { answer: draft1, citedIds: citedIds1 } = await draftFn(
    frontierSession,
    person as { id: string; name: string; role: string; persona_json: string },
    question,
    top,
  );

  // ---- 8. Judge answer — attempt 1 (cheap session) --------------------------
  const getCheapSessionFn = getDep('getCheapSession', getCheapSession);
  const cheapSession = await getCheapSessionFn();
  const judgeFn = getDep('judgeAnswer', _judgeAnswer);
  const verdict1 = await judgeFn(cheapSession, question, draft1, top);

  // ---- 9. Block gate — attempt 1 -------------------------------------------
  //   If attempt 1 passes, proceed as before.
  //   If attempt 1 is blocked, retry once with a conservative prompt; if that
  //   also fails return 'blocked' using the second verdict's reason.
  let draft: string;
  let citedIds: number[];
  let verdict: { pass: boolean; reason: string };

  if (verdict1.pass) {
    draft = draft1;
    citedIds = citedIds1;
    verdict = verdict1;
  } else {
    // Attempt 1 blocked — retry with conservative=true to raise grounding odds.
    console.error('[pipeline] draft blocked, retrying once');
    const { answer: draft2, citedIds: citedIds2 } = await draftFn(
      frontierSession,
      person as { id: string; name: string; role: string; persona_json: string },
      question,
      top,
      /* conservative= */ true,
    );
    const verdict2 = await judgeFn(cheapSession, question, draft2, top);

    if (!verdict2.pass) {
      // Both attempts blocked — return 'blocked' with attempt 2's reason.
      return {
        status: 'blocked',
        answer: null,
        citations: [],
        memoryTrace,
        verdict: verdict2,
      };
    }

    // Attempt 2 passed.
    draft = draft2;
    citedIds = citedIds2;
    verdict = verdict2;
  }

  // ---- 10. touchMemories — update last_access for recalled memories ----------
  const touchFn = getDep('touchMemories', _touchMemories);
  touchFn(db, top.map((m) => m.id), SIM_END);

  // ---- Build citations ------------------------------------------------------
  // CRITICAL: citedIds are 0-based indices into `top` (the retrieved subset),
  // NOT memory.id values. Map each index → the memory object at that position.
  const citations: Citation[] = citedIds.map((idx, position) => {
    const m = top[idx];
    return {
      n: position + 1,          // 1-based display number
      memoryId: m.id,           // actual DB row id
      text: m.text,
      simTime: m.sim_time,
      sourceRef: m.source_ref ?? null,
    };
  });

  // ---- 11. Persist interview record ----------------------------------------
  const insertFn = getDep('insertInterview', _insertInterview);
  const citedMemoryIds = citedIds.map((idx) => top[idx].id);
  insertFn(db, {
    person_id: personId,
    q: question,
    a: draft,
    cited_memory_ids: JSON.stringify(citedMemoryIds),
    created_at: SIM_END,
  });

  // ---- 12. Return full result -----------------------------------------------
  return {
    status: 'answered',
    answer: draft,
    citations,
    memoryTrace,
    verdict,
  };
}
