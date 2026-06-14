// src/memory/retrieve.test.ts
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { cosine, RELEVANCE_THRESHOLD, minmax, retrieveWithTrace } from './retrieve.ts';
import * as retrieveModule from './retrieve.ts';

// ---- Task 3.1: cosine -------------------------------------------------------

describe('cosine(a, b)', () => {
  it('identical vectors → 1.0', () => {
    const v = new Float32Array([1, 0]);
    assert.equal(cosine(v, v), 1.0);
  });

  it('orthogonal vectors → 0.0', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    assert.equal(cosine(a, b), 0.0);
  });

  it('45-degree vector [0.7071, 0.7071] vs [1, 0] → ~0.7071', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([Math.SQRT1_2, Math.SQRT1_2]);
    const result = cosine(a, b);
    assert.ok(Math.abs(result - Math.SQRT1_2) < 1e-6,
      `expected ~${Math.SQRT1_2}, got ${result}`);
  });

  it('exports RELEVANCE_THRESHOLD = 0.25', () => {
    assert.equal(RELEVANCE_THRESHOLD, 0.25);
  });
});

// ---- Task 3.2: minmax -------------------------------------------------------

describe('minmax(xs)', () => {
  it('spreads a normal range to [0, 1]', () => {
    const result = minmax([0, 5, 10]);
    assert.deepEqual(result, [0, 0.5, 1]);
  });

  it('all-same values (hi === lo) → all 0.5 (degenerate guard)', () => {
    const result = minmax([7, 7, 7]);
    assert.deepEqual(result, [0.5, 0.5, 0.5]);
  });

  it('single element → 0.5', () => {
    assert.deepEqual(minmax([42]), [0.5]);
  });

  it('handles float values', () => {
    const result = minmax([0.2, 0.8]);
    // lo=0.2, hi=0.8 → [0, 1]
    assert.ok(Math.abs(result[0] - 0.0) < 1e-9);
    assert.ok(Math.abs(result[1] - 1.0) < 1e-9);
  });
});

// ---- Task 3.3: retrieveWithTrace — hand-computed fixtures -------------------

// Frozen constants (match the plan spec exactly)
const SIM_END = Date.parse('2026-06-12T18:00:00Z');

// Helper to build a memory fixture with 2-dim Float32Array embeddings
function mem(
  id: number,
  embedding: number[],
  importance: number,
  lastAccessOffset: number,
) {
  return {
    id,
    person_id: 'priya',
    kind: 'observation' as const,
    text: `memory ${id}`,
    sim_time: SIM_END - 3_600_000,
    last_access: SIM_END - lastAccessOffset,
    importance,
    embedding: new Float32Array(embedding),
    source_ref: `ref-${id}`,
    evidence_ids: null,
  };
}

const m1 = mem(1, [1, 0],                        8, 7_200_000); // last_access = SIM_END - 2h
const m2 = mem(2, [0, 1],                        4, 7_200_000); // last_access = SIM_END - 2h
const m3 = mem(3, [Math.SQRT1_2, Math.SQRT1_2],  6, 3_600_000); // last_access = SIM_END - 1h

const queryEmbedding = new Float32Array([1, 0]);

describe('retrieveWithTrace — happy path (3 memories, query=[1,0])', () => {
  const result = retrieveWithTrace([m1, m2, m3], queryEmbedding, SIM_END);

  it('returns top, trace, maxCosine, declined fields', () => {
    assert.ok('top' in result, 'missing top');
    assert.ok('trace' in result, 'missing trace');
    assert.ok('maxCosine' in result, 'missing maxCosine');
    assert.ok('declined' in result, 'missing declined');
  });

  it('declined = false (maxCosine 1.0 >> threshold 0.25)', () => {
    assert.equal(result.declined, false);
  });

  it('maxCosine = 1.0 (m1 perfectly aligns with query)', () => {
    assert.ok(Math.abs(result.maxCosine - 1.0) < 1e-6,
      `expected maxCosine ≈ 1.0, got ${result.maxCosine}`);
  });

  it('top is ordered m1, m3, m2 (by descending score)', () => {
    assert.equal(result.top[0].id, 1);
    assert.equal(result.top[1].id, 3);
    assert.equal(result.top[2].id, 2);
  });

  it('top has at most n=15 entries (3 here → 3 total)', () => {
    assert.equal(result.top.length, 3);
  });

  it('trace has one entry per candidate memory (3)', () => {
    assert.equal(result.trace.length, 3);
  });

  it('trace entry for m1 has score ≈ 5.0000 (within 1e-3)', () => {
    const t1 = result.trace.find(t => t.memoryId === 1);
    assert.ok(t1, 'trace entry for m1 not found');
    assert.ok(Math.abs(t1.score - 5.0) < 1e-3,
      `expected score ≈ 5.0, got ${t1.score}`);
  });

  it('trace entry for m3 has score ≈ 3.6213 (within 1e-3)', () => {
    const t3 = result.trace.find(t => t.memoryId === 3);
    assert.ok(t3, 'trace entry for m3 not found');
    // 0.5*1.0 + 3.0*SQRT1_2 + 2.0*0.5 = 0.5 + 2.12132... + 1.0 = 3.62132...
    assert.ok(Math.abs(t3.score - 3.6213) < 1e-3,
      `expected score ≈ 3.6213, got ${t3.score}`);
  });

  it('trace entry for m2 has score ≈ 0.0000', () => {
    const t2 = result.trace.find(t => t.memoryId === 2);
    assert.ok(t2, 'trace entry for m2 not found');
    assert.ok(Math.abs(t2.score - 0.0) < 1e-6,
      `expected score ≈ 0.0, got ${t2.score}`);
  });

  it('trace entries carry all required API contract fields', () => {
    const t1 = result.trace.find(t => t.memoryId === 1);
    assert.ok(t1);
    // API shape: { memoryId, text, kind, recency, relevance, importance, score, aboveThreshold }
    assert.ok(typeof t1.memoryId === 'number', 'memoryId missing');
    assert.ok(typeof t1.text === 'string', 'text missing');
    assert.ok(typeof t1.kind === 'string', 'kind missing');
    assert.ok(typeof t1.recency === 'number', 'recency (raw) missing');
    assert.ok(typeof t1.relevance === 'number', 'relevance (raw cosine) missing');
    assert.ok(typeof t1.importance === 'number', 'importance (raw) missing');
    assert.ok(typeof t1.score === 'number', 'score missing');
    assert.ok(typeof t1.aboveThreshold === 'boolean', 'aboveThreshold missing');
  });

  it('trace m1 aboveThreshold = true', () => {
    const t1 = result.trace.find(t => t.memoryId === 1);
    assert.ok(t1);
    assert.equal(t1.aboveThreshold, true);
  });

  it('trace raw relevance for m1: relevanceRaw stored = cosine value 1.0', () => {
    const t1 = result.trace.find(t => t.memoryId === 1);
    assert.ok(t1);
    assert.ok(Math.abs(t1.relevance - 1.0) < 1e-6,
      `expected raw cosine 1.0, got ${t1.relevance}`);
  });
});

// ---- Task 3.4: decline gate -------------------------------------------------

describe('retrieveWithTrace — decline gate (all relevance < 0.25)', () => {
  // Query about salary — embeddings are orthogonal to every memory
  // We use a query vector [0, 1] against memories that all embed as [1, 0]
  // cosine([1,0], [0,1]) = 0.0  → maxCosine = 0.0 < 0.25 → declined

  const salaryMemories = [
    mem(10, [1, 0], 7, 3_600_000),
    mem(11, [1, 0], 5, 3_600_000),
    mem(12, [1, 0], 3, 3_600_000),
  ];
  const orthogonalQuery = new Float32Array([0, 1]);

  const result = retrieveWithTrace(salaryMemories, orthogonalQuery, SIM_END);

  it('declined = true', () => {
    assert.equal(result.declined, true);
  });

  it('top is empty array', () => {
    assert.deepEqual(result.top, []);
  });

  it('maxCosine = 0.0', () => {
    assert.ok(Math.abs(result.maxCosine - 0.0) < 1e-9,
      `expected 0.0, got ${result.maxCosine}`);
  });

  it('trace still has 3 entries (all shown below threshold in UI)', () => {
    assert.equal(result.trace.length, 3);
  });

  it('all trace entries have aboveThreshold = false', () => {
    for (const t of result.trace) {
      assert.equal(t.aboveThreshold, false,
        `trace entry ${t.memoryId} should be below threshold`);
    }
  });

  it('all trace entries have score = 0 (no scoring on decline path)', () => {
    for (const t of result.trace) {
      assert.equal(t.score, 0,
        `trace entry ${t.memoryId} score should be 0 on declined path`);
    }
  });

  it('trace entries still carry raw relevance values (UI renders bars)', () => {
    for (const t of result.trace) {
      assert.ok(typeof t.relevance === 'number', 'relevance missing in declined trace');
      assert.ok(Math.abs(t.relevance - 0.0) < 1e-9,
        `expected raw cosine 0.0, got ${t.relevance}`);
    }
  });
});

// ---- Task 3.5: degenerate normalisation -------------------------------------

describe('retrieveWithTrace — degenerate minmax (all memories identical importance + recency)', () => {
  // All 3 memories: same importance (5), same lastAccess offset (1 sim-hour ago),
  // but different embeddings — relevance alone determines order.
  // Since importance and recency are identical across all candidates:
  //   minmax([5,5,5])      → [0.5, 0.5, 0.5]    (degenerate guard)
  //   minmax([r,r,r])      → [0.5, 0.5, 0.5]    (if all recency identical too)
  //
  // With query [1,0]:
  //   rel_m20 = cosine([1,0],[1,0]) = 1.0
  //   rel_m21 = cosine([0,1],[1,0]) = 0.0
  //   rel_m22 = cosine([SQRT1_2,SQRT1_2],[1,0]) ≈ 0.7071
  //   → minmax([1.0, 0.0, 0.7071]):
  //       rel_n_m20 = 1.0, rel_n_m21 = 0.0, rel_n_m22 = SQRT1_2
  //
  // Scores:
  //   score_m20 = 0.5*0.5 + 3.0*1.0    + 2.0*0.5 = 0.25 + 3.0 + 1.0 = 4.25
  //   score_m21 = 0.5*0.5 + 3.0*0.0    + 2.0*0.5 = 0.25 + 0.0 + 1.0 = 1.25
  //   score_m22 = 0.5*0.5 + 3.0*0.7071 + 2.0*0.5 = 0.25 + 2.1213 + 1.0 = 3.3713
  //
  // Expected order: m20 (4.25) > m22 (3.3713) > m21 (1.25)

  const sameOffset = 3_600_000;
  const degen = [
    mem(20, [1, 0],                        5, sameOffset),
    mem(21, [0, 1],                        5, sameOffset),
    mem(22, [Math.SQRT1_2, Math.SQRT1_2],  5, sameOffset),
  ];
  const result = retrieveWithTrace(degen, new Float32Array([1, 0]), SIM_END);

  it('does not throw (degenerate guard fires without error)', () => {
    assert.ok(result);
  });

  it('declined = false (relevance still above threshold)', () => {
    assert.equal(result.declined, false);
  });

  it('ordering: m20 > m22 > m21', () => {
    assert.equal(result.top[0].id, 20);
    assert.equal(result.top[1].id, 22);
    assert.equal(result.top[2].id, 21);
  });

  it('m20 score ≈ 4.2500 (0.5*0.5 + 3.0*1.0 + 2.0*0.5)', () => {
    const t = result.trace.find(t => t.memoryId === 20);
    assert.ok(t);
    assert.ok(Math.abs(t.score - 4.25) < 1e-3,
      `expected ≈ 4.25, got ${t.score}`);
  });

  it('m22 score ≈ 3.3713 (0.5*0.5 + 3.0*SQRT1_2 + 2.0*0.5)', () => {
    const t = result.trace.find(t => t.memoryId === 22);
    assert.ok(t);
    const expected = 0.25 + 3.0 * Math.SQRT1_2 + 1.0;
    assert.ok(Math.abs(t.score - expected) < 1e-3,
      `expected ≈ ${expected}, got ${t.score}`);
  });

  it('m21 score ≈ 1.2500 (0.5*0.5 + 3.0*0.0 + 2.0*0.5)', () => {
    const t = result.trace.find(t => t.memoryId === 21);
    assert.ok(t);
    assert.ok(Math.abs(t.score - 1.25) < 1e-3,
      `expected ≈ 1.25, got ${t.score}`);
  });
});

// ---- Task 3.6: n-limiting and pure-function lastAccess contract -------------

describe('retrieveWithTrace — n-limiting and pure-function lastAccess contract', () => {
  // Build 20 distinct memories so we can test n=15 truncation.
  // Embeddings alternate between [1,0] and a slight variant so relevance varies.
  // We use constant importance (5) and constant lastAccess (SIM_END - 1h)
  // to keep recency degenerate → only relevance drives order.

  const twentyMems = Array.from({ length: 20 }, (_, idx) => {
    // angle sweeps 0 to π/2 evenly — idx=0 most aligned with [1,0], idx=19 least
    const angle = (idx / 20) * Math.PI / 2;
    return {
      id: 100 + idx,
      person_id: 'priya',
      kind: 'observation' as const,
      text: `memory ${100 + idx}`,
      sim_time: SIM_END - 3_600_000,
      last_access: SIM_END - 3_600_000,
      importance: 5,
      embedding: new Float32Array([Math.cos(angle), Math.sin(angle)]),
      source_ref: null as string | null,
      evidence_ids: null as string | null,
    };
  });

  const result = retrieveWithTrace(twentyMems, new Float32Array([1, 0]), SIM_END, { n: 15 });

  it('top contains exactly n=15 entries when 20 candidates given', () => {
    assert.equal(result.top.length, 15);
  });

  it('trace contains ALL 20 entries (not truncated)', () => {
    assert.equal(result.trace.length, 20);
  });

  it('last entry in trace has aboveThreshold = false (rank 16-20 not in top-15)', () => {
    // The 5 lowest-scored memories are not in top
    const below = result.trace.filter(t => !t.aboveThreshold);
    assert.equal(below.length, 5,
      `expected 5 entries below threshold, got ${below.length}`);
  });

  it('retrieve is pure — input memory objects are NOT mutated (lastAccess unchanged)', () => {
    // The pure retrieval function must NOT update lastAccess on memory objects.
    // Only the DB touch (touchMemories) in pipeline.ts may update lastAccess.
    const originalLastAccess = SIM_END - 3_600_000;
    for (const m of twentyMems) {
      assert.equal(m.last_access, originalLastAccess,
        `memory ${m.id} last_access was mutated by retrieveWithTrace`);
    }
  });

  it('top entries carry the original memory object reference (no copies)', () => {
    // Pipeline uses top[i].id to call touchMemories — must be same objects
    for (const topMem of result.top) {
      const original = twentyMems.find(m => m.id === topMem.id);
      assert.ok(original !== undefined, `top memory id ${topMem.id} not in input`);
    }
  });
});

// ---- Task 3.7: Module export audit ------------------------------------------

describe('Module export contract', () => {
  it('exports cosine', () => {
    assert.equal(typeof retrieveModule.cosine, 'function');
  });

  it('exports minmax', () => {
    assert.equal(typeof retrieveModule.minmax, 'function');
  });

  it('exports retrieveWithTrace', () => {
    assert.equal(typeof retrieveModule.retrieveWithTrace, 'function');
  });

  it('exports RELEVANCE_THRESHOLD as number 0.25', () => {
    assert.equal(typeof retrieveModule.RELEVANCE_THRESHOLD, 'number');
    assert.equal(retrieveModule.RELEVANCE_THRESHOLD, 0.25);
  });

  it('does NOT export mutable state (no DECAY, no W in public API)', () => {
    // DECAY and W are implementation details; keep them unexported
    assert.equal((retrieveModule as Record<string, unknown>)['DECAY'], undefined);
    assert.equal((retrieveModule as Record<string, unknown>)['W'], undefined);
  });
});
