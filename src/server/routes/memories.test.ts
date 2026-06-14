/**
 * Tests for GET /memories/:personId route.
 *
 * Two test layers:
 *   1. Unit tests via buildMemoriesHandler — mock db and getMemoriesForPerson stub,
 *      no HTTP involved. Verifies shape, field omissions, and evidenceIds parsing.
 *   2. Integration test via HTTP — ephemeral Express server with in-memory SQLite,
 *      exercises the real wiring (createMemoriesRouter → buildMemoriesHandler →
 *      getMemoriesForPerson).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { buildMemoriesHandler, createMemoriesRouter } from './memories.ts';
import type { MemoryRow } from '../../memory/db.ts';
import type { Request, Response } from 'express';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const SAMPLE_ROWS: MemoryRow[] = [
  {
    id: 7,
    person_id: 'dana',
    kind: 'thought',
    text: 'Dana seems frustrated with deployment pace.',
    sim_time: 1749556800000,
    last_access: 1749556800000,
    importance: 8,
    embedding: Buffer.alloc(4 * 384), // never returned
    source_ref: null,
    evidence_ids: '[3,7,12]',
  },
  {
    id: 3,
    person_id: 'dana',
    kind: 'observation',
    text: "Dana said: 'This vendor API is killing us.'",
    sim_time: 1749484800000,
    last_access: 1749484800000,
    importance: 7,
    embedding: Buffer.alloc(4 * 384),
    source_ref: 'teams://msg/117',
    evidence_ids: '[]',
  },
  {
    id: 9,
    person_id: 'priya',
    kind: 'observation',
    text: 'Priya noted the Atlas launch is blocked by vendor API.',
    sim_time: 1749463200000,
    last_access: 1749463200000,
    importance: 9,
    embedding: null,
    source_ref: 'teams://thread/atlas',
    evidence_ids: null,
  },
];

// Stub db — shape matches what buildMemoriesHandler expects
const stubDb = { _rows: SAMPLE_ROWS } as unknown as import('better-sqlite3').Database;

function getMemoriesStub(db: import('better-sqlite3').Database, personId: string): MemoryRow[] {
  return (db as unknown as { _rows: MemoryRow[] })._rows.filter(
    (r) => r.person_id === personId,
  );
}

// Minimal Express-like req/res mock helpers
function makeReq(personId: string): Request {
  return { params: { personId } } as unknown as Request;
}

interface MockRes {
  statusCode: number | null;
  body: unknown;
  res: Response;
}

function makeRes(): MockRes {
  const mock: MockRes = { statusCode: null, body: null, res: null as unknown as Response };
  const res = {
    status(code: number) {
      mock.statusCode = code;
      return res;
    },
    json(data: unknown) {
      mock.body = data;
      return res;
    },
  };
  mock.res = res as unknown as Response;
  return mock;
}

// ---------------------------------------------------------------------------
// Unit tests — buildMemoriesHandler
// ---------------------------------------------------------------------------

describe('buildMemoriesHandler — unit', () => {
  it('returns 200 JSON array for known personId (dana)', async () => {
    const handler = buildMemoriesHandler(stubDb, getMemoriesStub);
    const mock = makeRes();
    await handler(makeReq('dana'), mock.res);

    // status() not called → default Express 200
    assert.equal(mock.statusCode, null, 'should not call res.status() for success');
    assert.ok(Array.isArray(mock.body), 'body should be an array');
    assert.equal((mock.body as unknown[]).length, 2, 'should return only dana memories');
  });

  it('strips embedding and last_access from every response element', async () => {
    const handler = buildMemoriesHandler(stubDb, getMemoriesStub);
    const mock = makeRes();
    await handler(makeReq('dana'), mock.res);

    const body = mock.body as Array<Record<string, unknown>>;
    for (const mem of body) {
      assert.equal(mem['embedding'], undefined, 'embedding must not be in response');
      assert.equal(mem['last_access'], undefined, 'last_access must not be in response');
    }
  });

  it('maps snake_case db fields to camelCase response fields', async () => {
    const handler = buildMemoriesHandler(stubDb, getMemoriesStub);
    const mock = makeRes();
    await handler(makeReq('dana'), mock.res);

    const body = mock.body as Array<Record<string, unknown>>;
    const thought = body.find((m) => m['kind'] === 'thought');
    assert.ok(thought, 'thought entry must be present');
    assert.ok('simTime' in thought, 'simTime field should be present');
    assert.ok('sourceRef' in thought, 'sourceRef field should be present');
    assert.ok('evidenceIds' in thought, 'evidenceIds field should be present');
    // snake_case originals must NOT leak through
    assert.equal(thought['sim_time'], undefined);
    assert.equal(thought['source_ref'], undefined);
    assert.equal(thought['evidence_ids'], undefined);
  });

  it('parses evidenceIds from JSON string "[3,7,12]" → array', async () => {
    const handler = buildMemoriesHandler(stubDb, getMemoriesStub);
    const mock = makeRes();
    await handler(makeReq('dana'), mock.res);

    const body = mock.body as Array<Record<string, unknown>>;
    const thought = body.find((m) => m['kind'] === 'thought');
    assert.ok(thought, 'thought must exist');
    assert.ok(Array.isArray(thought['evidenceIds']), 'evidenceIds should be an array');
    assert.deepEqual(thought['evidenceIds'], [3, 7, 12]);
  });

  it('converts empty evidence_ids "[]" to null', async () => {
    const handler = buildMemoriesHandler(stubDb, getMemoriesStub);
    const mock = makeRes();
    await handler(makeReq('dana'), mock.res);

    const body = mock.body as Array<Record<string, unknown>>;
    const obs = body.find((m) => m['kind'] === 'observation');
    assert.ok(obs, 'observation must exist');
    assert.equal(obs['evidenceIds'], null, 'empty evidence_ids array should become null');
  });

  it('returns null evidenceIds when column is null', async () => {
    const handler = buildMemoriesHandler(stubDb, getMemoriesStub);
    const mock = makeRes();
    await handler(makeReq('priya'), mock.res);

    const body = mock.body as Array<Record<string, unknown>>;
    assert.equal(body.length, 1);
    assert.equal(body[0]!['evidenceIds'], null, 'null evidence_ids column → null in response');
  });

  it('returns 400 for unknown personId when validIds provided', async () => {
    const VALID_IDS = new Set(['priya', 'dana', 'tom', 'marco', 'sara', 'ben']);
    const handler = buildMemoriesHandler(stubDb, getMemoriesStub, VALID_IDS);
    const mock = makeRes();
    await handler(makeReq('nobody'), mock.res);

    assert.equal(mock.statusCode, 400);
    assert.ok(
      typeof mock.body === 'object' &&
        mock.body !== null &&
        'error' in (mock.body as object),
      'should return error field',
    );
  });

  it('returns 400 for unknown personId using default VALID_PERSON_IDS', async () => {
    const handler = buildMemoriesHandler(stubDb, getMemoriesStub);
    const mock = makeRes();
    await handler(makeReq('unknown_agent_xyz'), mock.res);

    assert.equal(mock.statusCode, 400);
  });

  it('response includes id, kind, text, simTime, importance, sourceRef, evidenceIds', async () => {
    const handler = buildMemoriesHandler(stubDb, getMemoriesStub);
    const mock = makeRes();
    await handler(makeReq('dana'), mock.res);

    const body = mock.body as Array<Record<string, unknown>>;
    const thought = body.find((m) => m['kind'] === 'thought')!;
    assert.equal(thought['id'], 7);
    assert.equal(thought['kind'], 'thought');
    assert.equal(thought['text'], 'Dana seems frustrated with deployment pace.');
    assert.equal(thought['simTime'], 1749556800000);
    assert.equal(thought['importance'], 8);
    assert.equal(thought['sourceRef'], null);
    assert.deepEqual(thought['evidenceIds'], [3, 7, 12]);
  });
});

// ---------------------------------------------------------------------------
// Integration test — HTTP server with real in-memory SQLite
// ---------------------------------------------------------------------------

describe('GET /memories/:personId — HTTP integration with in-memory SQLite', () => {
  let server: http.Server;
  let baseUrl: string;

  before(async () => {
    const { openDb } = await import('../../memory/db.ts');
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const schemaPath = path.resolve(__dirname, '..', '..', '..', 'db', 'schema.sql');
    const schema = readFileSync(schemaPath, 'utf-8');

    const db = openDb(':memory:');
    db.exec(schema);

    // Insert one person
    db.prepare(
      'INSERT INTO people (id, name, role, persona_json, sprite, desk_x, desk_y) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('dana', 'Dana Chen', 'Senior Backend Engineer', '{}', 'dana', 340, 160);

    // Insert memories: one thought (with evidence_ids), one observation (empty []), one observation (null)
    const insertMem = db.prepare(`
      INSERT INTO memories (person_id, kind, text, sim_time, last_access, importance, embedding, source_ref, evidence_ids)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Thought with evidence ids
    insertMem.run(
      'dana', 'thought',
      'Dana seems frustrated with deployment pace.',
      1749556800000, 1749556800000, 8,
      Buffer.alloc(4), // minimal embedding blob
      null,
      '[3,7,12]',
    );

    // Observation with empty evidence_ids
    insertMem.run(
      'dana', 'observation',
      "Dana said: 'This vendor API is killing us.'",
      1749484800000, 1749484800000, 7,
      null, 'teams://msg/117', '[]',
    );

    // Observation with null evidence_ids
    insertMem.run(
      'dana', 'observation',
      'Dana reviewed the deployment pipeline.',
      1749470000000, 1749470000000, 6,
      null, null, null,
    );

    const app = express();
    app.use(express.json());
    app.locals['db'] = db;
    app.use('/memories', createMemoriesRouter());

    await new Promise<void>((resolve) => {
      server = http.createServer(app);
      server.listen(0, '127.0.0.1', resolve);
    });

    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('unexpected address type');
    baseUrl = `http://127.0.0.1:${(addr as { port: number }).port}`;
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  async function get(path: string): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${baseUrl}${path}`);
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }

  it('returns 200 with JSON array for known personId', async () => {
    const { status, body } = await get('/memories/dana');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body), 'body should be array');
    assert.equal((body as unknown[]).length, 3, 'should return 3 memories for dana');
  });

  it('response contains no embedding or last_access fields', async () => {
    const { body } = await get('/memories/dana');
    const mems = body as Array<Record<string, unknown>>;
    for (const m of mems) {
      assert.equal(m['embedding'], undefined, 'embedding must be absent');
      assert.equal(m['last_access'], undefined, 'last_access must be absent');
    }
  });

  it('thought memory has parsed evidenceIds array', async () => {
    const { body } = await get('/memories/dana');
    const mems = body as Array<Record<string, unknown>>;
    const thought = mems.find((m) => m['kind'] === 'thought');
    assert.ok(thought, 'thought must be present');
    assert.ok(Array.isArray(thought['evidenceIds']), 'evidenceIds must be array');
    assert.deepEqual(thought['evidenceIds'], [3, 7, 12]);
  });

  it('observation with empty evidence_ids returns null evidenceIds', async () => {
    const { body } = await get('/memories/dana');
    const mems = body as Array<Record<string, unknown>>;
    // The observation at sim_time 1749484800000 has evidence_ids='[]'
    const obs = mems.find(
      (m) => m['kind'] === 'observation' && m['sourceRef'] === 'teams://msg/117',
    );
    assert.ok(obs, 'observation with sourceRef must exist');
    assert.equal(obs['evidenceIds'], null, '[] should map to null');
  });

  it('observation with null evidence_ids returns null evidenceIds', async () => {
    const { body } = await get('/memories/dana');
    const mems = body as Array<Record<string, unknown>>;
    const obs = mems.find(
      (m) => m['kind'] === 'observation' && m['sourceRef'] === null,
    );
    assert.ok(obs, 'observation with null sourceRef must exist');
    assert.equal(obs['evidenceIds'], null, 'null evidence_ids → null');
  });

  it('memories are ordered by sim_time ascending', async () => {
    const { body } = await get('/memories/dana');
    const mems = body as Array<Record<string, unknown>>;
    const times = mems.map((m) => m['simTime'] as number);
    for (let i = 1; i < times.length; i++) {
      assert.ok(times[i]! >= times[i - 1]!, `sim_time not ascending at index ${i}`);
    }
  });

  it('returns 400 for unknown personId', async () => {
    const { status, body } = await get('/memories/nobody');
    assert.equal(status, 400);
    assert.ok(
      typeof body === 'object' && body !== null && 'error' in (body as object),
      'must return error field',
    );
  });

  it('returns 400 for personId not in valid set', async () => {
    const { status } = await get('/memories/ghost');
    assert.equal(status, 400);
  });
});
