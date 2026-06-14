/**
 * Unit tests for the Teamville MCP server (Task 7.1).
 *
 * All external dependencies (DB, pipeline, embedder, retrieveWithTrace) are
 * injected via stubs — no network calls, no real SQLite, no LLM.
 *
 * Run: node --test src/mcp/server.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { listAgentsTool, interviewTool, memoryTraceTool, createServer } from './server.ts';

// ---------------------------------------------------------------------------
// Shared stubs
// ---------------------------------------------------------------------------

/** Minimal Database stub — only the DB object reference is passed; tools call getPeopleFn(db) etc. */
const DB_STUB = {} as import('better-sqlite3').Database;

const PEOPLE_STUB = [
  {
    id: 'priya', name: 'Priya', role: 'PM',
    persona_json: '{}', sprite: 'priya', desk_x: 100, desk_y: 100,
  },
  {
    id: 'dana', name: 'Dana', role: 'Senior Backend Engineer',
    persona_json: '{}', sprite: 'dana', desk_x: 200, desk_y: 100,
  },
];

const MEMORY_STUB = {
  id: 1,
  person_id: 'priya',
  kind: 'observation' as const,
  text: 'Vendor API latency is blocking the Atlas launch.',
  sim_time: Date.parse('2026-06-09T10:00:00Z'),
  last_access: Date.parse('2026-06-09T10:00:00Z'),
  importance: 9,
  embedding: new Float32Array(1536).fill(0.1),
  source_ref: 'teams://thread/atlas-blocked',
  evidence_ids: '[]',
};

const MEMORIES_STUB = [MEMORY_STUB];

const runInterviewAnswered = async (
  _db: import('better-sqlite3').Database,
  personId: string,
  question: string,
) => ({
  status: 'answered' as const,
  answer: `${personId} answered: ${question}`,
  citations: [
    {
      n: 1,
      memoryId: 1,
      text: 'Vendor API latency...',
      simTime: 1749463200000,
      sourceRef: 'teams://thread/atlas-blocked',
    },
  ],
  memoryTrace: [
    {
      memoryId: 1,
      text: 'Vendor API latency...',
      kind: 'observation',
      recency: 0.9,
      relevance: 0.8,
      importance: 0.9,
      score: 4.15,
      aboveThreshold: true,
    },
  ],
  verdict: { pass: true, reason: 'All claims grounded.' },
});

const runInterviewDeclined = async () => ({
  status: 'declined' as const,
  answer: null,
  citations: [] as never[],
  memoryTrace: [
    {
      memoryId: 1,
      text: 'Salary info',
      kind: 'observation',
      recency: 0.5,
      relevance: 0.1,
      importance: 0.2,
      score: 0.6,
      aboveThreshold: false,
    },
  ],
  verdict: null,
});

const retrieveWithTraceStub = (
  _memories: import('../memory/retrieve.ts').MemoryInput[],
  _embedding: Float32Array | number[],
  _nowSimTime: number,
  _opts?: { n?: number; threshold?: number },
) => ({
  top: [{ ...MEMORY_STUB }] as import('../memory/retrieve.ts').MemoryInput[],
  trace: [
    {
      memoryId: 1,
      text: 'Vendor API latency...',
      kind: 'observation',
      recency: 0.9,
      relevance: 0.8,
      importance: 0.9,
      score: 4.15,
      aboveThreshold: true,
    },
  ],
  maxCosine: 0.8,
  declined: false,
});

const embedStub = async (_texts: string[]): Promise<Float32Array[]> => [
  new Float32Array(1536).fill(0.1),
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('listAgentsTool returns all people with id, name, role only', async () => {
  const result = await listAgentsTool({
    db: DB_STUB,
    getPeople: () => PEOPLE_STUB,
  });

  assert.ok(Array.isArray(result), 'result should be array');
  assert.equal(result.length, 2);
  assert.equal(result[0].id, 'priya');
  assert.equal(result[0].name, 'Priya');
  assert.equal(result[0].role, 'PM');

  // Must NOT expose internal fields
  assert.equal((result[0] as Record<string, unknown>)['desk_x'], undefined);
  assert.equal((result[0] as Record<string, unknown>)['persona_json'], undefined);
});

test('interviewTool formats cited answer as text with citation list', async () => {
  const result = await interviewTool(
    { personId: 'priya', question: 'What is blocking Atlas?' },
    { db: DB_STUB, runInterview: runInterviewAnswered },
  );

  assert.equal(typeof result, 'string', 'result should be string');
  assert.ok(result.includes('priya'), 'should mention person');
  assert.ok(result.includes('[1]'), 'should include citation marker');
  assert.ok(result.includes('teams://thread/atlas-blocked'), 'should include source ref');
  assert.ok(result.includes('All claims grounded'), 'should include judge verdict');
});

test('interviewTool returns declined message on status=declined', async () => {
  const result = await interviewTool(
    { personId: 'priya', question: "What is Tom's salary?" },
    { db: DB_STUB, runInterview: runInterviewDeclined },
  );

  assert.equal(typeof result, 'string');
  assert.ok(result.includes('declined'), 'declined status should be present');
  assert.ok(result.includes('below'), 'should explain threshold');
  assert.ok(result.includes('No LLM call'), 'should note no LLM was called');
});

test('interviewTool returns blocked message on status=blocked', async () => {
  const runInterviewBlocked = async () => ({
    status: 'blocked' as const,
    answer: null,
    citations: [] as never[],
    memoryTrace: [] as never[],
    verdict: { pass: false, reason: 'Answer not grounded in memories.' },
  });

  const result = await interviewTool(
    { personId: 'priya', question: 'Some question' },
    { db: DB_STUB, runInterview: runInterviewBlocked },
  );

  assert.ok(result.includes('blocked'), 'blocked status should be present');
  assert.ok(result.includes('not grounded'), 'should include judge reason');
});

test('memoryTraceTool returns retrieval trace without LLM call', async () => {
  const result = await memoryTraceTool(
    { personId: 'priya', question: 'What is blocking Atlas?' },
    {
      db: DB_STUB,
      retrieveWithTrace: retrieveWithTraceStub,
      embed: embedStub,
      getMemoriesForPerson: () => MEMORIES_STUB,
    },
  );

  assert.equal(typeof result, 'string', 'result should be string');
  assert.ok(result.includes('Vendor API latency'), 'should include memory text');
  assert.ok(result.includes('score'), 'should include score info');
  assert.ok(result.includes('maxCosine'), 'should include maxCosine');
  // CRITICAL: retrieveWithTrace was called (not runInterview), so NO LLM chat call was made
});

test('memoryTraceTool formats scores with fixed decimal places', async () => {
  const result = await memoryTraceTool(
    { personId: 'priya', question: 'test question?' },
    {
      db: DB_STUB,
      retrieveWithTrace: retrieveWithTraceStub,
      embed: embedStub,
      getMemoriesForPerson: () => MEMORIES_STUB,
    },
  );

  // Check that scores are rendered (pattern like rec=0.900)
  assert.match(result, /rec=\d+\.\d+/, 'recency should be formatted');
  assert.match(result, /rel=\d+\.\d+/, 'relevance should be formatted');
  assert.match(result, /imp=\d+\.\d+/, 'importance should be formatted');
});

test('createServer returns object with run() method', () => {
  // Pass a non-existent dbPath to avoid opening a real DB in the factory.
  // We only check the returned shape — we do NOT call run() in unit tests.
  const s = createServer({ dbPath: ':memory:', runInterview: runInterviewAnswered });
  assert.equal(typeof s, 'object');
  assert.equal(typeof s.run, 'function');
});
