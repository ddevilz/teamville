/**
 * Route tests using a real Express server spun up on an ephemeral port.
 * All pipeline internals are mocked via the runInterview dep injection so
 * no LLM or DB calls fire.
 *
 * Uses Node's built-in fetch (available Node 18+).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createInterviewRouter } from './interview.ts';
import type { InterviewResult } from '../../interview/pipeline.ts';
import type Database from 'better-sqlite3';

const SIM_END = Date.parse('2026-06-12T18:00:00Z');

// ---------------------------------------------------------------------------
// Shared mock results
// ---------------------------------------------------------------------------

const ANSWERED_RESULT: InterviewResult = {
  status: 'answered',
  answer: 'Atlas is blocked by the vendor API [1].',
  citations: [
    {
      n: 1,
      memoryId: 42,
      text: 'Vendor returned 503.',
      simTime: SIM_END - 86400000,
      sourceRef: 'teams://msg/42',
    },
  ],
  memoryTrace: [
    {
      memoryId: 42,
      text: 'Vendor returned 503.',
      kind: 'observation',
      recency: 0.9,
      relevance: 0.88,
      importance: 0.8,
      score: 3.6,
      aboveThreshold: true,
    },
  ],
  verdict: { pass: true, reason: 'All claims grounded.' },
};

const DECLINED_RESULT: InterviewResult = {
  status: 'declined',
  answer: null,
  citations: [],
  memoryTrace: [
    {
      memoryId: 5,
      text: 'Unrelated memory.',
      kind: 'observation',
      recency: 0.5,
      relevance: 0.1,
      importance: 0.3,
      score: 0.4,
      aboveThreshold: false,
    },
  ],
  verdict: null,
};

// ---------------------------------------------------------------------------
// Test server factory
// ---------------------------------------------------------------------------

type RunInterviewMock = (
  db: Database.Database | null,
  personId: string,
  question: string,
) => Promise<InterviewResult>;

async function startServer(
  runInterviewMock: RunInterviewMock,
): Promise<{ server: http.Server; url: string }> {
  const app = express();
  app.use(express.json());
  app.use('/interview', createInterviewRouter({ runInterview: runInterviewMock }));

  return new Promise((resolve) => {
    const s = http.createServer(app);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      if (!addr || typeof addr === 'string') throw new Error('Unexpected address type');
      const { port } = addr;
      resolve({ server: s, url: `http://127.0.0.1:${port}/interview` });
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /interview — happy path', () => {
  let server: http.Server;
  let url: string;

  before(async () => {
    const s = await startServer(async (_db, _personId, _question) => ANSWERED_RESULT);
    server = s.server;
    url = s.url;
  });
  after(() => server?.close());

  it('returns 200 with status=answered', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ personId: 'priya', question: 'What is blocking Atlas?' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as InterviewResult;
    assert.equal(body.status, 'answered');
    assert.equal(typeof body.answer, 'string');
    assert.ok(Array.isArray(body.citations));
    assert.ok(Array.isArray(body.memoryTrace));
    assert.equal(body.verdict?.pass, true);
  });
});

describe('POST /interview — decline path', () => {
  let server: http.Server;
  let url: string;

  before(async () => {
    const s = await startServer(async () => DECLINED_RESULT);
    server = s.server;
    url = s.url;
  });
  after(() => server?.close());

  it('returns 200 with status=declined and null answer', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ personId: 'priya', question: "What is Tom's salary?" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as InterviewResult;
    assert.equal(body.status, 'declined');
    assert.equal(body.answer, null);
    assert.ok(Array.isArray(body.memoryTrace));
  });
});

describe('POST /interview — 400 on missing fields', () => {
  let server: http.Server;
  let url: string;

  before(async () => {
    const s = await startServer(async () => ANSWERED_RESULT);
    server = s.server;
    url = s.url;
  });
  after(() => server?.close());

  it('returns 400 when personId is missing', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'What is blocking Atlas?' }),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { error?: string };
    assert.ok(body.error, 'must return error message');
  });

  it('returns 400 when question is missing', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ personId: 'priya' }),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { error?: string };
    assert.ok(body.error);
  });

  it('returns 400 when body is empty', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 400);
  });
});

describe('POST /interview — 404 on unknown personId', () => {
  let server: http.Server;
  let url: string;

  before(async () => {
    const s = await startServer(async (_db, personId: string) => {
      if (personId !== 'priya') {
        throw Object.assign(new Error(`Unknown personId: "${personId}"`), {
          code: 'PERSON_NOT_FOUND',
        });
      }
      return ANSWERED_RESULT;
    });
    server = s.server;
    url = s.url;
  });
  after(() => server?.close());

  it('returns 404 for an unknown agent', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ personId: 'batman', question: 'Where is the cave?' }),
    });
    assert.equal(res.status, 404);
    const body = await res.json() as { error?: string };
    assert.ok(body.error);
  });
});
