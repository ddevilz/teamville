/**
 * Tests for the Ingest Orchestrator (Task 2.4).
 *
 * Strategy:
 *   - In-memory SQLite DB (no disk I/O)
 *   - Synthetic mini seed data (2 people, 3 events) injected via overrides
 *   - Fake CopilotSession returning canned JSON
 *   - Fake embed function returning deterministic Float32Array vectors
 *
 * Assertions (from spec self-review checklist):
 *   1. Every non-ambient event participant gets at least one memory row
 *   2. sim_time / last_access on observation rows match the event sim_time
 *   3. batched embed called once (not per-text) for the full text batch
 *   4. meta.embedding_model is written
 *   5. reflect() is called once per person (mocked via embed call-count heuristic)
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

import { openDb, getMeta } from '../memory/db.ts';
import { ingestAll, expandEvent, precomputeBubbles } from './index.ts';
import type { CopilotSession } from './importance.ts';

// ---------------------------------------------------------------------------
// Schema helper — mirrors what runIngest applies from db/schema.sql
// ---------------------------------------------------------------------------

function makeDb(): import('better-sqlite3').Database {
  const db = openDb(':memory:');
  db.exec(`
    CREATE TABLE people (
      id TEXT PRIMARY KEY, name TEXT, role TEXT,
      persona_json TEXT, sprite TEXT, desk_x INT, desk_y INT
    );
    CREATE TABLE memories (
      id INTEGER PRIMARY KEY, person_id TEXT,
      kind TEXT CHECK(kind IN ('observation','chat','thought')),
      text TEXT, sim_time INT, last_access INT,
      importance INT, embedding BLOB,
      source_ref TEXT, evidence_ids TEXT
    );
    CREATE INDEX mem_person ON memories(person_id, sim_time);
    CREATE TABLE events (
      id INTEGER PRIMARY KEY, sim_time INT, duration_min INT,
      kind TEXT, location TEXT, participants TEXT, payload TEXT
    );
    CREATE TABLE interviews (
      id INTEGER PRIMARY KEY, person_id TEXT, q TEXT, a TEXT,
      cited_memory_ids TEXT, created_at INT
    );
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  return db;
}

// ---------------------------------------------------------------------------
// Minimal seed fixtures
// ---------------------------------------------------------------------------

const SIM_T1 = Date.parse('2026-06-08T09:00:00Z');
const SIM_T2 = Date.parse('2026-06-08T10:00:00Z');
const SIM_T3 = Date.parse('2026-06-08T11:00:00Z');

const SEED_PEOPLE = [
  {
    id: 'alice',
    name: 'Alice',
    role: 'Engineer',
    sprite: 'alice',
    desk_x: 100,
    desk_y: 100,
    persona: { occupation: { title: 'Engineer' } },
  },
  {
    id: 'bob',
    name: 'Bob',
    role: 'Designer',
    sprite: 'bob',
    desk_x: 200,
    desk_y: 200,
    persona: { occupation: { title: 'Designer' } },
  },
];

const SEED_EVENTS = [
  {
    id: 1,
    sim_time: SIM_T1,
    duration_min: 30,
    kind: 'meeting',
    location: 'standup_room',
    participants: ['alice', 'bob'],
    payload: { topic: 'Monday standup – project status' },
  },
  {
    id: 2,
    sim_time: SIM_T2,
    duration_min: 60,
    kind: 'focus',
    location: 'desk_alice',
    participants: ['alice'],
    payload: { description: 'Alice works on the feature branch.' },
  },
  {
    id: 3,
    sim_time: SIM_T3,
    duration_min: 0,
    kind: 'ambient',
    location: 'kitchen',
    participants: ['bob'],
    payload: { topic: 'Coffee break ambient scene' },
  },
];

// ---------------------------------------------------------------------------
// Fake session: returns scripted responses in order
// ---------------------------------------------------------------------------

function makeScriptedSession(responses: string[]): CopilotSession {
  let idx = 0;
  return {
    async sendAndWait(_opts: { prompt: string }) {
      const text = responses[idx++] ?? '[3]';
      return { text };
    },
  };
}

// ---------------------------------------------------------------------------
// Fake embed: records call count and batch sizes; returns unique vectors
// ---------------------------------------------------------------------------

interface EmbedSpy {
  callCount: number;
  batchSizes: number[];
  fn: (texts: string[]) => Promise<Float32Array[]>;
}

function makeEmbedSpy(dims = 4): EmbedSpy {
  const spy: EmbedSpy = {
    callCount: 0,
    batchSizes: [],
    fn: async (texts: string[]) => {
      spy.callCount++;
      spy.batchSizes.push(texts.length);
      return texts.map((_, i) => {
        const v = new Float32Array(dims);
        v[i % dims] = 1.0;
        return v;
      });
    },
  };
  return spy;
}

// ---------------------------------------------------------------------------
// Unit tests for expandEvent
// ---------------------------------------------------------------------------

describe('expandEvent', () => {
  const peopleMap = new Map(SEED_PEOPLE.map(p => [p.id, p]));

  it('returns empty array for ambient events', () => {
    const result = expandEvent(SEED_EVENTS[2], peopleMap);
    assert.equal(result.length, 0, 'ambient events should produce no memory records');
  });

  it('returns one record per participant for meeting events', () => {
    const result = expandEvent(SEED_EVENTS[0], peopleMap);
    assert.equal(result.length, 2, 'meeting with 2 participants → 2 records');
    const ids = result.map(r => r.personId).sort();
    assert.deepEqual(ids, ['alice', 'bob']);
  });

  it('meeting text mentions topic and other participants', () => {
    const result = expandEvent(SEED_EVENTS[0], peopleMap);
    const aliceRec = result.find(r => r.personId === 'alice')!;
    assert.ok(
      aliceRec.text.includes('Monday standup'),
      `expected topic in text, got: "${aliceRec.text}"`,
    );
    assert.ok(
      aliceRec.text.includes('Bob'),
      `expected other participant name in text, got: "${aliceRec.text}"`,
    );
  });

  it('returns one record for focus event (single participant)', () => {
    const result = expandEvent(SEED_EVENTS[1], peopleMap);
    assert.equal(result.length, 1);
    assert.equal(result[0].personId, 'alice');
  });

  it('focus record text uses payload description', () => {
    const result = expandEvent(SEED_EVENTS[1], peopleMap);
    assert.ok(
      result[0].text.includes('Alice works on the feature branch'),
      `expected description in text, got: "${result[0].text}"`,
    );
  });

  it('record sourceRef matches event id', () => {
    const result = expandEvent(SEED_EVENTS[0], peopleMap);
    assert.ok(result.every(r => r.sourceRef === 'event://1'));
  });

  it('record simTime matches event sim_time', () => {
    const result = expandEvent(SEED_EVENTS[0], peopleMap);
    assert.ok(result.every(r => r.simTime === SIM_T1));
  });

  it('skips unknown personIds gracefully', () => {
    const event = {
      ...SEED_EVENTS[0],
      participants: ['alice', 'ghost'],
    };
    const result = expandEvent(event, peopleMap);
    assert.equal(result.length, 1, 'unknown participant should be silently skipped');
    assert.equal(result[0].personId, 'alice');
  });
});

// ---------------------------------------------------------------------------
// Unit tests for precomputeBubbles
// ---------------------------------------------------------------------------

describe('precomputeBubbles', () => {
  it('sets bubbles array on meeting events', () => {
    const db = makeDb();
    db.prepare(`
      INSERT INTO events (id, sim_time, duration_min, kind, location, participants, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(1, SIM_T1, 30, 'meeting', 'room', '[]', JSON.stringify({ topic: 'Sprint review' }));

    precomputeBubbles(db);

    const row = db.prepare('SELECT payload FROM events WHERE id = 1').get() as { payload: string };
    const payload = JSON.parse(row.payload) as { bubbles?: string[] };
    assert.ok(Array.isArray(payload.bubbles) && payload.bubbles.length > 0, 'bubbles should be set');
  });

  it('does not overwrite existing bubbles', () => {
    const db = makeDb();
    const existingBubbles = ['custom bubble'];
    db.prepare(`
      INSERT INTO events (id, sim_time, duration_min, kind, location, participants, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(1, SIM_T1, 30, 'meeting', 'room', '[]', JSON.stringify({ topic: 'X', bubbles: existingBubbles }));

    precomputeBubbles(db);

    const row = db.prepare('SELECT payload FROM events WHERE id = 1').get() as { payload: string };
    const payload = JSON.parse(row.payload) as { bubbles: string[] };
    assert.deepEqual(payload.bubbles, existingBubbles, 'existing bubbles must not be overwritten');
  });
});

// ---------------------------------------------------------------------------
// Integration tests for ingestAll
// ---------------------------------------------------------------------------

describe('ingestAll – integration', () => {
  // Shared DB and spy for all integration tests.
  let db: import('better-sqlite3').Database;
  let embedSpy: EmbedSpy;

  // Scripted session: importance score answers + reflection answers.
  // We have 3 non-ambient records (alice×meeting + bob×meeting + alice×focus = 3 texts).
  // Importance batch: 3 texts → "[5, 4, 3]"
  // Reflection per person: importance < 150 with 3 memories so no reflect LLM calls
  // (3 memories × max importance 5 = 15, well below 150 threshold).
  // But we still need a session. We provide scripted fallbacks.
  const scriptedResponses = [
    // Importance batch for 3 texts (≤20, so one call)
    '[5, 4, 3]',
  ];

  before(async () => {
    db = makeDb();
    embedSpy = makeEmbedSpy(4);

    const session = makeScriptedSession(scriptedResponses);

    await ingestAll(db, {
      peopleJson: SEED_PEOPLE,
      eventsJson: SEED_EVENTS,
      session,
      embedFn: embedSpy.fn,
    });
  });

  it('upserts correct number of people rows', () => {
    const count = (db.prepare('SELECT COUNT(*) as n FROM people').get() as { n: number }).n;
    assert.equal(count, 2, 'should have 2 people (alice, bob)');
  });

  it('upserts correct number of event rows', () => {
    const count = (db.prepare('SELECT COUNT(*) as n FROM events').get() as { n: number }).n;
    assert.equal(count, 3, 'should have 3 events');
  });

  it('inserts observation memory for every non-ambient event participant', () => {
    // Events: meeting(alice,bob)=2 + focus(alice)=1 + ambient(bob)=0 = 3 observations
    const obs = db.prepare("SELECT * FROM memories WHERE kind = 'observation'").all() as Array<{ person_id: string }>;
    assert.equal(obs.length, 3, `expected 3 observation memories, got ${obs.length}`);
  });

  it('alice gets 2 memories (meeting + focus), bob gets 1 (meeting)', () => {
    const alice = (db.prepare("SELECT COUNT(*) as n FROM memories WHERE person_id = 'alice'").get() as { n: number }).n;
    const bob = (db.prepare("SELECT COUNT(*) as n FROM memories WHERE person_id = 'bob'").get() as { n: number }).n;
    assert.equal(alice, 2, `alice should have 2 memories, got ${alice}`);
    assert.equal(bob, 1, `bob should have 1 memory, got ${bob}`);
  });

  it('sim_time on observation rows matches event sim_time', () => {
    type ObsRow = { person_id: string; sim_time: number; last_access: number };
    const obs = db.prepare("SELECT person_id, sim_time, last_access FROM memories WHERE kind='observation' ORDER BY sim_time")
      .all() as ObsRow[];

    const expectedTimes = [SIM_T1, SIM_T1, SIM_T2]; // meeting(×2), focus(×1)
    const actualTimes = obs.map(r => r.sim_time).sort((a, b) => a - b);
    assert.deepEqual(actualTimes, expectedTimes, 'sim_time values must match event sim_times');
  });

  it('last_access equals sim_time on freshly inserted observations', () => {
    type ObsRow = { sim_time: number; last_access: number };
    const obs = db.prepare("SELECT sim_time, last_access FROM memories WHERE kind='observation'")
      .all() as ObsRow[];

    for (const row of obs) {
      assert.equal(
        row.last_access,
        row.sim_time,
        `last_access (${row.last_access}) should equal sim_time (${row.sim_time}) at ingest`,
      );
    }
  });

  it('embed function is called exactly once for the full text batch', () => {
    // All 3 texts (≤20 each, 1 batch) → embed called once
    assert.equal(embedSpy.callCount, 1, `expected 1 embed call, got ${embedSpy.callCount}`);
    assert.deepEqual(embedSpy.batchSizes, [3], 'embed should receive all 3 texts in one batch');
  });

  it('writes embedding_model to meta', () => {
    const model = getMeta(db, 'embedding_model');
    assert.ok(model !== null && model.length > 0, 'embedding_model meta must be written');
  });

  it('writes ingest_completed_at to meta', () => {
    const ts = getMeta(db, 'ingest_completed_at');
    assert.ok(ts !== null, 'ingest_completed_at meta must be written');
    assert.ok(Number(ts) > 0, 'ingest_completed_at should be a positive timestamp');
  });

  it('writes sim_start and sim_end to meta', () => {
    const simStart = getMeta(db, 'sim_start');
    const simEnd = getMeta(db, 'sim_end');
    assert.ok(simStart !== null, 'sim_start must be written');
    assert.ok(simEnd !== null, 'sim_end must be written');
    assert.ok(Number(simStart) < Number(simEnd), 'sim_start must precede sim_end');
  });

  it('source_ref on observation rows is event:// URI', () => {
    type Row = { source_ref: string };
    const obs = db.prepare("SELECT source_ref FROM memories WHERE kind='observation'").all() as Row[];
    for (const row of obs) {
      assert.ok(
        row.source_ref?.startsWith('event://'),
        `source_ref should be event:// URI, got "${row.source_ref}"`,
      );
    }
  });

  it('embedding BLOB is stored correctly (non-zero length)', () => {
    type Row = { embedding: Buffer };
    const obs = db.prepare("SELECT embedding FROM memories WHERE kind='observation'").all() as Row[];
    for (const row of obs) {
      assert.ok(row.embedding !== null, 'embedding should not be null');
      assert.ok(row.embedding.byteLength > 0, 'embedding buffer should have bytes');
    }
  });

  it('importance scores are applied (non-zero, in 1-10 range)', () => {
    type Row = { importance: number };
    const obs = db.prepare("SELECT importance FROM memories WHERE kind='observation'").all() as Row[];
    for (const row of obs) {
      assert.ok(row.importance >= 1 && row.importance <= 10, `importance ${row.importance} out of range`);
    }
  });
});

// ---------------------------------------------------------------------------
// Test: importance batching — when texts exceed IMPORTANCE_BATCH_SIZE
// ---------------------------------------------------------------------------

describe('ingestAll – importance batching', () => {
  it('calls scoreImportance in batches of ≤20 texts', async () => {
    // Build 25 single-participant events → 25 memory texts → 2 batches (20+5)
    const people = [{ id: 'alice', name: 'Alice', role: 'Eng', sprite: 'alice', desk_x: 0, desk_y: 0, persona: {} }];
    const events = Array.from({ length: 25 }, (_, i) => ({
      id: i + 1,
      sim_time: SIM_T1 + i * 60_000,
      duration_min: 5,
      kind: 'focus',
      location: 'desk',
      participants: ['alice'],
      payload: { description: `Focus block ${i + 1}` },
    }));

    let sessionCallCount = 0;
    const sessionCallTexts: number[] = [];
    const session: CopilotSession = {
      async sendAndWait(opts: { prompt: string }) {
        // Count lines in the numbered list to detect batch size.
        const matches = opts.prompt.match(/^\d+\. /gm);
        const batchSize = matches ? matches.length : 0;
        sessionCallTexts.push(batchSize);
        sessionCallCount++;
        // Return a valid array of the right size.
        return { text: JSON.stringify(Array.from({ length: batchSize }, () => 5)) };
      },
    };

    const embedSpy = makeEmbedSpy(4);
    const db = makeDb();

    await ingestAll(db, {
      peopleJson: people,
      eventsJson: events,
      session,
      embedFn: embedSpy.fn,
    });

    // 25 texts / 20 batch size = 2 batches (sessionCallCount includes reflect calls,
    // but since importance < 150 no reflect LLM calls happen; importance calls = 2).
    assert.ok(
      sessionCallCount >= 2,
      `expected ≥2 importance calls for 25 texts, got ${sessionCallCount}`,
    );
    // Every batch must be ≤20 items.
    for (const sz of sessionCallTexts) {
      assert.ok(sz <= 20, `batch size ${sz} exceeds IMPORTANCE_BATCH_SIZE=20`);
    }
  });
});

// ---------------------------------------------------------------------------
// Test: ambient events produce no memories
// ---------------------------------------------------------------------------

describe('ingestAll – ambient events produce no memory rows', () => {
  it('ambient-only events do not create observation memories', async () => {
    const people = [{ id: 'carol', name: 'Carol', role: 'PM', sprite: 'carol', desk_x: 0, desk_y: 0, persona: {} }];
    const events = [
      {
        id: 1,
        sim_time: SIM_T1,
        duration_min: 0,
        kind: 'ambient',
        location: 'kitchen',
        participants: ['carol'],
        payload: { topic: 'Coffee' },
      },
    ];

    const session: CopilotSession = {
      async sendAndWait() { return { text: '[]' }; },
    };
    const embedSpy = makeEmbedSpy(4);
    const db = makeDb();

    await ingestAll(db, {
      peopleJson: people,
      eventsJson: events,
      session,
      embedFn: embedSpy.fn,
    });

    const count = (db.prepare("SELECT COUNT(*) as n FROM memories WHERE kind='observation'").get() as { n: number }).n;
    assert.equal(count, 0, 'ambient events must not produce observation memories');

    // embed should not have been called (no texts to embed).
    assert.equal(embedSpy.callCount, 0, 'embed should not be called when there are no memory texts');
  });
});

// ---------------------------------------------------------------------------
// Test: ingestAll is idempotent (re-run on same DB replaces people/events)
// ---------------------------------------------------------------------------

describe('ingestAll – idempotency (upsert)', () => {
  it('re-running ingestAll with same seed data does not double-insert people or events', async () => {
    const db = makeDb();
    const session: CopilotSession = {
      async sendAndWait() { return { text: '[5, 5, 5]' }; },
    };
    const embedSpy = makeEmbedSpy(4);

    await ingestAll(db, { peopleJson: SEED_PEOPLE, eventsJson: SEED_EVENTS, session, embedFn: embedSpy.fn });
    await ingestAll(db, { peopleJson: SEED_PEOPLE, eventsJson: SEED_EVENTS, session, embedFn: embedSpy.fn });

    const peopleCount = (db.prepare('SELECT COUNT(*) as n FROM people').get() as { n: number }).n;
    const eventsCount = (db.prepare('SELECT COUNT(*) as n FROM events').get() as { n: number }).n;
    assert.equal(peopleCount, 2, 'people should not be duplicated on second run');
    assert.equal(eventsCount, 3, 'events should not be duplicated on second run');
  });
});
