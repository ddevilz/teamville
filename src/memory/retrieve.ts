/**
 * Pure retrieval engine — no DB access.
 * Implements Park et al. (2023) formula with code weights from the released repo:
 *   score = 0.5·recency_norm + 3.0·relevance_norm + 2.0·importance_norm
 * Each raw score is min-max normalised independently across candidates.
 *
 * Exports (public API):
 *   cosine(a, b)                     → number
 *   minmax(xs)                       → number[]
 *   RELEVANCE_THRESHOLD              → 0.25
 *   retrieveWithTrace(memories, queryEmbedding, nowSimTime, opts?) → result
 *
 * DECAY and W are intentionally unexported (implementation details).
 */

/** Cosine similarity between two Float32Array (or plain number[]) vectors. */
export function cosine(a: Float32Array | number[], b: Float32Array | number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * Min-max normalise an array of raw scores to [0, 1].
 * Degenerate guard: if all values are identical (hi === lo), returns all 0.5
 * so no candidate is artificially penalised.
 */
export function minmax(xs: number[]): number[] {
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  if (hi === lo) return xs.map(() => 0.5);
  return xs.map(x => (x - lo) / (hi - lo));
}

/** Minimum cosine similarity required for retrieval to proceed. Tunable. */
export const RELEVANCE_THRESHOLD = 0.25;

// ---- Private constants (NOT exported) ----
const DECAY = 0.995;   // per sim-hour since last access (Park et al.)
const W = { recency: 0.5, relevance: 3.0, importance: 2.0 }; // repo gw values

// ---- Types ----

export interface MemoryInput {
  id: number;
  person_id: string;
  kind: string;
  text: string;
  sim_time: number;
  last_access: number;
  importance: number;
  embedding: Float32Array | number[];
  source_ref: string | null;
  evidence_ids: string | null;
}

export interface TraceEntry {
  memoryId: number;
  text: string;
  kind: string;
  recency: number;
  relevance: number;
  importance: number;
  score: number;
  aboveThreshold: boolean;
}

export interface RetrieveResult {
  top: MemoryInput[];
  trace: TraceEntry[];
  maxCosine: number;
  declined: boolean;
}

/**
 * Retrieve top-n memories with a full scoring trace for the API response.
 *
 * Pure function — does NOT mutate input memories (no lastAccess update).
 * Caller (pipeline.ts) must call touchMemories(db, ids, nowSimTime) after.
 *
 * @param memories  — full list for one person; embeddings already decoded
 * @param queryEmbedding
 * @param nowSimTime  — for interviews always SIM_END (frozen by contract)
 * @param opts  — n: top-n limit (default 15), threshold: cosine decline gate (default 0.25)
 */
export function retrieveWithTrace(
  memories: MemoryInput[],
  queryEmbedding: Float32Array | number[],
  nowSimTime: number,
  { n = 15, threshold = RELEVANCE_THRESHOLD }: { n?: number; threshold?: number } = {},
): RetrieveResult {
  // ---- 1. Raw scores ----
  const recencyRaw    = memories.map(m =>
    Math.pow(DECAY, (nowSimTime - m.last_access) / 3_600_000));
  const relevanceRaw  = memories.map(m => cosine(m.embedding, queryEmbedding));
  const importanceRaw = memories.map(m => m.importance);

  const maxCosine = memories.length > 0 ? Math.max(...relevanceRaw) : 0;

  // ---- 2. Decline gate ----
  if (maxCosine < threshold) {
    const trace: TraceEntry[] = memories.map((m, i) => ({
      memoryId:       m.id,
      text:           m.text,
      kind:           m.kind,
      recency:        recencyRaw[i],
      relevance:      relevanceRaw[i],
      importance:     importanceRaw[i],
      score:          0,           // no ranking on declined path
      aboveThreshold: false,       // everything below the red line in UI
    }));
    return { top: [], trace, maxCosine, declined: true };
  }

  // ---- 3. Normalise ----
  const recencyN    = minmax(recencyRaw);
  const relevanceN  = minmax(relevanceRaw);
  const importanceN = minmax(importanceRaw);

  // ---- 4. Combined score + sort ----
  const scored = memories.map((m, i) => ({
    m,
    i,
    score: W.recency * recencyN[i] + W.relevance * relevanceN[i] + W.importance * importanceN[i],
  }));
  scored.sort((a, b) => b.score - a.score);

  const top = scored.slice(0, n).map(s => s.m);
  const topIds = new Set(top.map(m => m.id));

  // ---- 5. Build trace (ALL candidates) ----
  const trace: TraceEntry[] = memories.map((m, i) => {
    const s = scored.find(entry => entry.i === i)!;
    return {
      memoryId:       m.id,
      text:           m.text,
      kind:           m.kind,
      recency:        recencyRaw[i],
      relevance:      relevanceRaw[i],
      importance:     importanceRaw[i],
      score:          s.score,
      aboveThreshold: topIds.has(m.id),
    };
  });

  return { top, trace, maxCosine, declined: false };
}
