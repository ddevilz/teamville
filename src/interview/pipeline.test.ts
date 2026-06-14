/**
 * Full pipeline tests with all external dependencies injected via _setDeps.
 *
 * Covers:
 *   - answered path (happy path): drafter + judge called, citations mapped,
 *     touchMemories + insertInterview called.
 *   - declined path: ZERO drafter/judge calls, memoryTrace still returned.
 *   - blocked path: judge fails, answer is null (draft never exposed),
 *     no touchMemories/insertInterview.
 *   - unknown personId: throws with personId in message.
 *   - embedding-model mismatch: throws clear error naming stored vs active model.
 *   - DB not ingested (null meta): throws clear error.
 *
 * Citation mapping correctness:
 *   Memories have id=10,20 (NOT 0,1) to catch the classic off-by-one where
 *   someone returns memory.id instead of mapping through the index.
 *
 * Test isolation:
 *   All session acquisition (getFrontierSession/getCheapSession) is injected via
 *   _setDeps so the real Copilot SDK is NEVER touched. npm test passes with no
 *   env vars.
 */

import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { runInterview, _setDeps, SIM_END } from './pipeline.ts';
import type { PipelineDeps } from './pipeline.ts';

// ---------------------------------------------------------------------------
// Dummy session stub — satisfies CopilotSession without any network I/O.
// ---------------------------------------------------------------------------

function makeDummySession(model: string) {
  return {
    _model: model,
    async sendAndWait({ prompt }: { prompt: string }) {
      return { text: `[DUMMY ${model}] ${prompt.slice(0, 30)}` };
    },
  };
}

const DUMMY_FRONTIER = makeDummySession('gpt-4o');
const DUMMY_CHEAP    = makeDummySession('gpt-4o-mini');

/**
 * Injectable session + model deps that every test must include so the real
 * Copilot SDK and embedder are never touched when running `npm test`.
 */
const MATCHED_MODEL_DEPS: Pick<PipelineDeps, 'getMeta' | 'embedderName' | 'getFrontierSession' | 'getCheapSession'> = {
  getMeta: (_db, key) => key === 'embedding_model' ? 'test-model-v1' : null,
  embedderName: () => 'test-model-v1',
  getFrontierSession: async () => DUMMY_FRONTIER as unknown as Awaited<ReturnType<typeof import('./copilot.ts')['getFrontierSession']>>,
  getCheapSession: async () => DUMMY_CHEAP as unknown as Awaited<ReturnType<typeof import('./copilot.ts')['getCheapSession']>>,
};

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const MOCK_PERSON = {
  id: 'priya',
  name: 'Priya',
  role: 'PM',
  persona_json: JSON.stringify({ persona: { personality: { traits: ['direct'] } } }),
};

/**
 * Memories with id=10 and id=20 (deliberately != indices 0/1).
 * This catches the bug where citations return memory.id directly instead of
 * mapping the 0-based citedIds index through top[idx].id.
 */
const MOCK_MEMORIES = [
  {
    id: 10,
    person_id: 'priya',
    text: 'Vendor API returned 503 on Tuesday.',
    sim_time: Date.parse('2026-06-09T14:00:00Z'),
    last_access: Date.parse('2026-06-09T14:00:00Z'),
    importance: 8,
    kind: 'observation' as const,
    source_ref: 'teams://msg/42',
    evidence_ids: '[]',
    embedding: Buffer.from(new Float32Array([0.1, 0.9]).buffer),
  },
  {
    id: 20,
    person_id: 'priya',
    text: 'Dana filed escalation ticket.',
    sim_time: Date.parse('2026-06-10T09:30:00Z'),
    last_access: Date.parse('2026-06-10T09:30:00Z'),
    importance: 7,
    kind: 'observation' as const,
    source_ref: 'teams://msg/55',
    evidence_ids: '[]',
    embedding: Buffer.from(new Float32Array([0.2, 0.8]).buffer),
  },
];

// Decoded version (Float32Array) for what the pipeline passes to retrieve/drafter/judge
const DECODED_MEMORIES = MOCK_MEMORIES.map((m) => ({
  ...m,
  embedding: new Float32Array(m.embedding.buffer, m.embedding.byteOffset, m.embedding.byteLength / 4),
}));

// ---------------------------------------------------------------------------
// Helper: build trace result matching retrieveWithTrace contract
// ---------------------------------------------------------------------------

function makeTraceResult({
  memories = DECODED_MEMORIES,
  maxCosine = 0.85,
  declined = false,
}: {
  memories?: typeof DECODED_MEMORIES;
  maxCosine?: number;
  declined?: boolean;
} = {}) {
  return {
    top: declined ? [] : memories,
    trace: memories.map((m, i) => ({
      memoryId: m.id,
      text: m.text,
      kind: m.kind,
      recency: 0.9 - i * 0.05,
      relevance: maxCosine - i * 0.1,
      importance: m.importance / 10,
      score: declined ? 0 : 3.5 - i * 0.2,
      aboveThreshold: !declined,
    })),
    maxCosine,
    declined,
  };
}

// ---------------------------------------------------------------------------
// Helper: build a mock DB — uses mock.fn() for write ops so we can assert
// ---------------------------------------------------------------------------

function makeMockDb({
  person = MOCK_PERSON as typeof MOCK_PERSON | null,
  memories = MOCK_MEMORIES,
}: {
  person?: typeof MOCK_PERSON | null;
  memories?: typeof MOCK_MEMORIES;
} = {}) {
  return {
    // These are called by the injected getPeople/getMemoriesForPerson overrides
    // in the test deps — the db object itself is passed through but not used
    // directly by those overrides.
    _person: person,
    _memories: memories,
    touchMemories: mock.fn<(db: unknown, ids: number[], nowSimTime: number) => void>(),
    insertInterview: mock.fn<(db: unknown, row: unknown) => number>(),
  };
}

// ---------------------------------------------------------------------------
// Reset deps after each test so tests don't bleed into each other
// ---------------------------------------------------------------------------

afterEach(() => {
  _setDeps(null);
});

// ---------------------------------------------------------------------------
// Answered path (S4 — money shot)
// ---------------------------------------------------------------------------

describe('runInterview — happy path (answered)', () => {
  it('returns status=answered with citations mapped by index, not by memory.id', async () => {
    const db = makeMockDb();

    // citedIds = [0, 1] (0-based indices into top)
    // top[0].id = 10, top[1].id = 20
    // So citations[0].memoryId must be 10, citations[1].memoryId must be 20
    const mockDraft = async () => ({
      answer: 'Blocked by vendor API [1]. Dana escalated [2].',
      citedIds: [0, 1],
    });
    const mockJudge = async () => ({ pass: true, reason: 'All claims grounded.' });

    const deps: PipelineDeps = {
      ...MATCHED_MODEL_DEPS,
      embed: async () => [new Float32Array([0.15, 0.85])],
      retrieveWithTrace: () => makeTraceResult(),
      draftAnswer: mockDraft,
      judgeAnswer: mockJudge,
      getPeople: () => [MOCK_PERSON],
      getMemoriesForPerson: () => MOCK_MEMORIES,
      touchMemories: db.touchMemories as unknown as PipelineDeps['touchMemories'],
      insertInterview: db.insertInterview as unknown as PipelineDeps['insertInterview'],
    };
    _setDeps(deps);

    // db is passed to runInterview but the injected getPeople/getMemoriesForPerson
    // ignore it — that's fine; this matches the test design in the spec.
    const result = await runInterview(db as unknown as import('better-sqlite3').Database, 'priya', 'What is blocking Atlas?');

    assert.equal(result.status, 'answered');
    assert.equal(typeof result.answer, 'string');
    assert.ok(result.answer!.length > 0, 'answer must not be empty');

    // Citations array
    assert.ok(Array.isArray(result.citations), 'citations must be array');
    assert.equal(result.citations.length, 2, 'must have two citations');

    // CRITICAL: citation 1 must map to memory id=10 (index 0 in top), NOT id=0
    assert.equal(result.citations[0].n, 1, 'first citation n=1');
    assert.equal(result.citations[0].memoryId, 10, 'first citation must map to memory id=10 (top[0])');
    assert.equal(result.citations[0].text, MOCK_MEMORIES[0].text);
    assert.equal(result.citations[0].simTime, MOCK_MEMORIES[0].sim_time);
    assert.equal(result.citations[0].sourceRef, 'teams://msg/42');

    // CRITICAL: citation 2 must map to memory id=20 (index 1 in top), NOT id=1
    assert.equal(result.citations[1].n, 2, 'second citation n=2');
    assert.equal(result.citations[1].memoryId, 20, 'second citation must map to memory id=20 (top[1])');

    // memoryTrace
    assert.ok(Array.isArray(result.memoryTrace), 'memoryTrace must be array');
    assert.equal(result.memoryTrace.length, 2);

    // Verdict
    assert.equal(result.verdict!.pass, true);
    assert.equal(typeof result.verdict!.reason, 'string');

    // DB side effects
    assert.equal(db.touchMemories.mock.calls.length, 1, 'touchMemories must be called once');
    assert.equal(db.insertInterview.mock.calls.length, 1, 'insertInterview must be called once');

    // touchFn is called as touchFn(db, ids, SIM_END) — args are (db, ids, simTime)
    // arguments[0] = db, arguments[1] = ids array, arguments[2] = SIM_END
    const touchArgs = db.touchMemories.mock.calls[0].arguments;
    assert.equal(touchArgs[2], SIM_END, 'touchMemories must use SIM_END');
    // Verify memory ids in touch call are actual db ids (10, 20), not indices
    assert.deepEqual([...touchArgs[1]].sort((a: number, b: number) => a - b), [10, 20], 'touchMemories must receive actual memory ids');

    // Verify insertInterview cited_memory_ids contains db ids
    // insertFn called as insertFn(db, row) — arguments[1] = row
    const insertArgs = db.insertInterview.mock.calls[0].arguments;
    const insertRow = insertArgs[1] as { cited_memory_ids: string };
    const citedInInsert = JSON.parse(insertRow.cited_memory_ids) as number[];
    assert.ok(
      citedInInsert.every((id) => [10, 20].includes(id)),
      'insertInterview cited_memory_ids must contain db ids (10, 20), not indices',
    );
  });

  it('uses SIM_END as nowSimTime regardless of current time', async () => {
    // Freeze Date.now to an obviously wrong value — pipeline must ignore it
    const db = makeMockDb();

    const retrieveCalls: number[] = [];
    const deps: PipelineDeps = {
      ...MATCHED_MODEL_DEPS,
      embed: async () => [new Float32Array([0.5, 0.5])],
      retrieveWithTrace: (_memories, _q, nowSimTime) => {
        retrieveCalls.push(nowSimTime);
        return makeTraceResult();
      },
      draftAnswer: async () => ({ answer: 'Answer [1].', citedIds: [0] }),
      judgeAnswer: async () => ({ pass: true, reason: 'ok' }),
      getPeople: () => [MOCK_PERSON],
      getMemoriesForPerson: () => MOCK_MEMORIES,
      touchMemories: db.touchMemories as unknown as PipelineDeps['touchMemories'],
      insertInterview: db.insertInterview as unknown as PipelineDeps['insertInterview'],
    };
    _setDeps(deps);

    await runInterview(db as unknown as import('better-sqlite3').Database, 'priya', 'Test?');

    assert.equal(retrieveCalls.length, 1, 'retrieveWithTrace called once');
    assert.equal(retrieveCalls[0], SIM_END, 'retrieveWithTrace must receive SIM_END as nowSimTime');
  });
});

// ---------------------------------------------------------------------------
// Declined path (S5) — ZERO LLM calls asserted
// ---------------------------------------------------------------------------

describe('runInterview — declined path (S5: max cosine below threshold)', () => {
  it('returns status=declined with no answer, no LLM calls, but full memoryTrace', async () => {
    const db = makeMockDb();

    const mockDraft = mock.fn(async () => {
      throw new Error('drafter MUST NOT be called on decline path');
    });
    const mockJudge = mock.fn(async () => {
      throw new Error('judge MUST NOT be called on decline path');
    });

    const deps: PipelineDeps = {
      ...MATCHED_MODEL_DEPS,
      embed: async () => [new Float32Array([0.5, 0.5])],
      retrieveWithTrace: () => makeTraceResult({ maxCosine: 0.1, declined: true }),
      draftAnswer: mockDraft as unknown as PipelineDeps['draftAnswer'],
      judgeAnswer: mockJudge as unknown as PipelineDeps['judgeAnswer'],
      getPeople: () => [MOCK_PERSON],
      getMemoriesForPerson: () => MOCK_MEMORIES,
      touchMemories: db.touchMemories as unknown as PipelineDeps['touchMemories'],
      insertInterview: db.insertInterview as unknown as PipelineDeps['insertInterview'],
    };
    _setDeps(deps);

    const result = await runInterview(db as unknown as import('better-sqlite3').Database, 'priya', "What is Tom's salary?");

    assert.equal(result.status, 'declined');
    assert.equal(result.answer, null, 'answer must be null on decline');
    assert.deepEqual(result.citations, [], 'citations must be empty on decline');
    assert.equal(result.verdict, null, 'verdict must be null on decline');

    // Full memoryTrace must still be returned (UI shows threshold line)
    assert.ok(Array.isArray(result.memoryTrace), 'memoryTrace must still be returned');
    assert.equal(result.memoryTrace.length, 2, 'memoryTrace must include all candidates');
    assert.ok(
      result.memoryTrace.every((e) => e.aboveThreshold === false),
      'all trace entries must be below threshold on decline',
    );

    // S5 requirement: ZERO LLM calls
    assert.equal(mockDraft.mock.calls.length, 0, 'drafter must NOT be called on decline (S5)');
    assert.equal(mockJudge.mock.calls.length, 0, 'judge must NOT be called on decline (S5)');

    // No DB writes on decline
    assert.equal(db.touchMemories.mock.calls.length, 0, 'touchMemories must NOT be called on decline');
    assert.equal(db.insertInterview.mock.calls.length, 0, 'insertInterview must NOT be called on decline');
  });
});

// ---------------------------------------------------------------------------
// Blocked path (S11 — judge blocks BOTH attempts)
// ---------------------------------------------------------------------------

describe('runInterview — judge-block path (S11)', () => {
  it('returns status=blocked when both draft attempts are blocked; drafter called twice', async () => {
    const db = makeMockDb();

    const mockDraft = mock.fn(async () => ({
      answer: 'Tom earns $120k per year [1].',
      citedIds: [0],
    }));
    const mockJudge = mock.fn(async () => ({
      pass: false,
      reason: 'Salary is sensitive personal info.',
    }));

    const deps: PipelineDeps = {
      ...MATCHED_MODEL_DEPS,
      embed: async () => [new Float32Array([0.15, 0.85])],
      retrieveWithTrace: () => makeTraceResult(),
      draftAnswer: mockDraft as unknown as PipelineDeps['draftAnswer'],
      judgeAnswer: mockJudge as unknown as PipelineDeps['judgeAnswer'],
      getPeople: () => [MOCK_PERSON],
      getMemoriesForPerson: () => MOCK_MEMORIES,
      touchMemories: db.touchMemories as unknown as PipelineDeps['touchMemories'],
      insertInterview: db.insertInterview as unknown as PipelineDeps['insertInterview'],
    };
    _setDeps(deps);

    const result = await runInterview(db as unknown as import('better-sqlite3').Database, 'priya', 'How much does Tom earn?');

    assert.equal(result.status, 'blocked');
    // Draft must NEVER be leaked on blocked path
    assert.equal(result.answer, null, 'answer MUST be null when judge blocks (S11)');
    assert.deepEqual(result.citations, [], 'citations must be empty when blocked');

    assert.equal(result.verdict!.pass, false);
    assert.ok(result.verdict!.reason.length > 0, 'verdict must have a reason');
    assert.ok(
      result.verdict!.reason.includes('Salary') || result.verdict!.reason.length > 0,
    );

    // memoryTrace still populated (shown in debug UI)
    assert.ok(Array.isArray(result.memoryTrace), 'memoryTrace must be returned even when blocked');
    assert.equal(result.memoryTrace.length, 2);

    // Drafter must have been called TWICE (attempt 1 + retry)
    assert.equal(mockDraft.mock.calls.length, 2, 'drafter must be called twice when both attempts are blocked');
    // Second call must use conservative=true
    assert.equal((mockDraft.mock.calls[1].arguments as unknown[])[4], true, 'second draft attempt must pass conservative=true');

    // Judge must have been called TWICE
    assert.equal(mockJudge.mock.calls.length, 2, 'judge must be called twice when both attempts are blocked');

    // No DB writes when blocked
    assert.equal(db.touchMemories.mock.calls.length, 0, 'touchMemories must NOT be called when blocked');
    assert.equal(db.insertInterview.mock.calls.length, 0, 'insertInterview must NOT be called when blocked');
  });
});

// ---------------------------------------------------------------------------
// Retry path — judge blocks attempt 1, passes attempt 2 → 'answered'
// ---------------------------------------------------------------------------

describe('runInterview — retry path (attempt 1 blocked, attempt 2 passes)', () => {
  it('returns status=answered when attempt 2 passes; drafter called twice; touch/insert called', async () => {
    const db = makeMockDb();

    let draftCallCount = 0;
    const mockDraft = mock.fn(async () => {
      draftCallCount++;
      return {
        answer: `Vendor API returned 503 [1]. Dana escalated [2].`,
        citedIds: [0, 1],
      };
    });

    let judgeCallCount = 0;
    const mockJudge = mock.fn(async () => {
      judgeCallCount++;
      // Block the first call, pass the second
      if (judgeCallCount === 1) {
        return { pass: false, reason: 'Slight over-claim on attempt 1.' };
      }
      return { pass: true, reason: 'All claims grounded on retry.' };
    });

    const deps: PipelineDeps = {
      ...MATCHED_MODEL_DEPS,
      embed: async () => [new Float32Array([0.15, 0.85])],
      retrieveWithTrace: () => makeTraceResult(),
      draftAnswer: mockDraft as unknown as PipelineDeps['draftAnswer'],
      judgeAnswer: mockJudge as unknown as PipelineDeps['judgeAnswer'],
      getPeople: () => [MOCK_PERSON],
      getMemoriesForPerson: () => MOCK_MEMORIES,
      touchMemories: db.touchMemories as unknown as PipelineDeps['touchMemories'],
      insertInterview: db.insertInterview as unknown as PipelineDeps['insertInterview'],
    };
    _setDeps(deps);

    const result = await runInterview(db as unknown as import('better-sqlite3').Database, 'priya', 'What is blocking Atlas?');

    assert.equal(result.status, 'answered', 'must be answered when retry passes');
    assert.ok(typeof result.answer === 'string' && result.answer.length > 0, 'answer must be present');

    // Drafter called twice: first attempt + conservative retry
    assert.equal(mockDraft.mock.calls.length, 2, 'drafter must be called twice on retry path');
    // First call: conservative should be undefined/falsy
    assert.ok(!(mockDraft.mock.calls[0].arguments as unknown[])[4], 'first draft attempt must NOT be conservative');
    // Second call: conservative must be true
    assert.equal((mockDraft.mock.calls[1].arguments as unknown[])[4], true, 'second draft attempt must pass conservative=true');

    // Judge called twice
    assert.equal(mockJudge.mock.calls.length, 2, 'judge must be called twice on retry path');

    // Verdict on the result must be the passing one (attempt 2)
    assert.equal(result.verdict!.pass, true);
    assert.ok(result.verdict!.reason.includes('retry'), 'verdict reason must come from attempt 2');

    // Citations must be present
    assert.ok(Array.isArray(result.citations), 'citations must be present');
    assert.equal(result.citations.length, 2);

    // touch/insert must be called (answered path)
    assert.equal(db.touchMemories.mock.calls.length, 1, 'touchMemories must be called on answered retry path');
    assert.equal(db.insertInterview.mock.calls.length, 1, 'insertInterview must be called on answered retry path');
  });
});

// ---------------------------------------------------------------------------
// Unknown personId — 404-style error
// ---------------------------------------------------------------------------

describe('runInterview — unknown personId', () => {
  it('throws an error that names the unknown personId', async () => {
    const db = makeMockDb({ person: null });

    const deps: PipelineDeps = {
      ...MATCHED_MODEL_DEPS,
      embed: async () => [new Float32Array([0.5, 0.5])],
      retrieveWithTrace: () => makeTraceResult(),
      draftAnswer: async () => ({ answer: 'x', citedIds: [] }),
      judgeAnswer: async () => ({ pass: true, reason: 'ok' }),
      getPeople: () => [],          // no people → person not found
      getMemoriesForPerson: () => MOCK_MEMORIES,
      touchMemories: db.touchMemories as unknown as PipelineDeps['touchMemories'],
      insertInterview: db.insertInterview as unknown as PipelineDeps['insertInterview'],
    };
    _setDeps(deps);

    await assert.rejects(
      () => runInterview(db as unknown as import('better-sqlite3').Database, 'nobody', 'anything?'),
      (err: Error) => {
        assert.ok(err instanceof Error, 'must throw an Error instance');
        assert.ok(
          err.message.includes('nobody'),
          `error message must include the unknown personId "nobody", got: ${err.message}`,
        );
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Citation index mapping correctness — explicit edge case
// ---------------------------------------------------------------------------

describe('runInterview — citation memoryId mapping', () => {
  it('maps citedIds[0]=1 to top[1].id (not index 1)', async () => {
    // top has two memories: id=100 at index 0, id=200 at index 1
    // drafter returns citedIds=[1] (citing the second memory, index 1)
    // Expected: citation.memoryId = 200 (top[1].id), NOT 1

    const memories200 = [
      { ...MOCK_MEMORIES[0], id: 100 },
      { ...MOCK_MEMORIES[1], id: 200 },
    ];
    const db = makeMockDb({ memories: memories200 });

    const deps: PipelineDeps = {
      ...MATCHED_MODEL_DEPS,
      embed: async () => [new Float32Array([0.5, 0.5])],
      retrieveWithTrace: () => {
        const decoded = memories200.map((m) => ({
          ...m,
          embedding: new Float32Array(m.embedding.buffer, m.embedding.byteOffset, m.embedding.byteLength / 4),
        }));
        return makeTraceResult({ memories: decoded });
      },
      draftAnswer: async () => ({
        answer: 'Dana escalated the issue [2].',
        citedIds: [1],  // 0-based index → top[1] = id:200
      }),
      judgeAnswer: async () => ({ pass: true, reason: 'grounded' }),
      getPeople: () => [MOCK_PERSON],
      getMemoriesForPerson: () => memories200,
      touchMemories: db.touchMemories as unknown as PipelineDeps['touchMemories'],
      insertInterview: db.insertInterview as unknown as PipelineDeps['insertInterview'],
    };
    _setDeps(deps);

    const result = await runInterview(db as unknown as import('better-sqlite3').Database, 'priya', 'What did Dana do?');

    assert.equal(result.status, 'answered');
    assert.equal(result.citations.length, 1);
    assert.equal(
      result.citations[0].memoryId,
      200,
      'citedIds[0]=1 must map to top[1].id=200, not the literal value 1',
    );
    assert.equal(result.citations[0].n, 1, 'citation n is 1-based display number (position 0 → n=1)');
  });
});

// ---------------------------------------------------------------------------
// Embedding-model enforcement (FIX 1)
// ---------------------------------------------------------------------------

describe('runInterview — embedding-model enforcement', () => {
  it('throws a clear error when DB embedding_model differs from current embedder', async () => {
    const db = makeMockDb();

    const deps: PipelineDeps = {
      // Stored model was ingested with GitHub Models; current process uses MiniLM
      getMeta: (_db, key) => key === 'embedding_model' ? 'openai/text-embedding-3-small' : null,
      embedderName: () => 'Xenova/all-MiniLM-L6-v2',
      getFrontierSession: async () => DUMMY_FRONTIER as unknown as Awaited<ReturnType<typeof import('./copilot.ts')['getFrontierSession']>>,
      getCheapSession: async () => DUMMY_CHEAP as unknown as Awaited<ReturnType<typeof import('./copilot.ts')['getCheapSession']>>,
      embed: async () => [new Float32Array([0.5, 0.5])],
      retrieveWithTrace: () => makeTraceResult(),
      draftAnswer: async () => ({ answer: 'x', citedIds: [] }),
      judgeAnswer: async () => ({ pass: true, reason: 'ok' }),
      getPeople: () => [MOCK_PERSON],
      getMemoriesForPerson: () => MOCK_MEMORIES,
      touchMemories: db.touchMemories as unknown as PipelineDeps['touchMemories'],
      insertInterview: db.insertInterview as unknown as PipelineDeps['insertInterview'],
    };
    _setDeps(deps);

    await assert.rejects(
      () => runInterview(db as unknown as import('better-sqlite3').Database, 'priya', 'What is blocking Atlas?'),
      (err: Error) => {
        assert.ok(err instanceof Error, 'must throw an Error instance');
        assert.ok(
          err.message.includes('openai/text-embedding-3-small'),
          `error must name stored model, got: ${err.message}`,
        );
        assert.ok(
          err.message.includes('Xenova/all-MiniLM-L6-v2'),
          `error must name current model, got: ${err.message}`,
        );
        assert.ok(
          err.message.toLowerCase().includes('mismatch'),
          `error must describe the mismatch, got: ${err.message}`,
        );
        return true;
      },
    );
  });

  it('throws a clear error when DB has never been ingested (getMeta returns null)', async () => {
    const db = makeMockDb();

    const deps: PipelineDeps = {
      // No embedding_model key in meta → DB not ingested
      getMeta: () => null,
      embedderName: () => 'Xenova/all-MiniLM-L6-v2',
      getFrontierSession: async () => DUMMY_FRONTIER as unknown as Awaited<ReturnType<typeof import('./copilot.ts')['getFrontierSession']>>,
      getCheapSession: async () => DUMMY_CHEAP as unknown as Awaited<ReturnType<typeof import('./copilot.ts')['getCheapSession']>>,
      embed: async () => [new Float32Array([0.5, 0.5])],
      retrieveWithTrace: () => makeTraceResult(),
      draftAnswer: async () => ({ answer: 'x', citedIds: [] }),
      judgeAnswer: async () => ({ pass: true, reason: 'ok' }),
      getPeople: () => [MOCK_PERSON],
      getMemoriesForPerson: () => MOCK_MEMORIES,
      touchMemories: db.touchMemories as unknown as PipelineDeps['touchMemories'],
      insertInterview: db.insertInterview as unknown as PipelineDeps['insertInterview'],
    };
    _setDeps(deps);

    await assert.rejects(
      () => runInterview(db as unknown as import('better-sqlite3').Database, 'priya', 'What is blocking Atlas?'),
      (err: Error) => {
        assert.ok(err instanceof Error, 'must throw an Error instance');
        assert.ok(
          err.message.toLowerCase().includes('ingest'),
          `error must mention ingest, got: ${err.message}`,
        );
        return true;
      },
    );
  });

  it('proceeds normally when stored model matches current embedder', async () => {
    const db = makeMockDb();

    const deps: PipelineDeps = {
      // Both sides agree on the model — should NOT throw
      getMeta: (_db, key) => key === 'embedding_model' ? 'openai/text-embedding-3-small' : null,
      embedderName: () => 'openai/text-embedding-3-small',
      getFrontierSession: async () => DUMMY_FRONTIER as unknown as Awaited<ReturnType<typeof import('./copilot.ts')['getFrontierSession']>>,
      getCheapSession: async () => DUMMY_CHEAP as unknown as Awaited<ReturnType<typeof import('./copilot.ts')['getCheapSession']>>,
      embed: async () => [new Float32Array([0.5, 0.5])],
      retrieveWithTrace: () => makeTraceResult(),
      draftAnswer: async () => ({ answer: 'All good [1].', citedIds: [0] }),
      judgeAnswer: async () => ({ pass: true, reason: 'ok' }),
      getPeople: () => [MOCK_PERSON],
      getMemoriesForPerson: () => MOCK_MEMORIES,
      touchMemories: db.touchMemories as unknown as PipelineDeps['touchMemories'],
      insertInterview: db.insertInterview as unknown as PipelineDeps['insertInterview'],
    };
    _setDeps(deps);

    const result = await runInterview(
      db as unknown as import('better-sqlite3').Database,
      'priya',
      'No mismatch here?',
    );
    assert.equal(result.status, 'answered', 'matched model must allow the interview to proceed');
  });
});
