/**
 * Tests for the reflection pass (Task 2.3).
 *
 * We test using:
 *   - an in-memory SQLite db (via openDb(':memory:'))
 *   - a synthetic set of memories with importance summing past 150
 *   - a mock Copilot session that returns canned focal-point + insight responses
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  openDb,
  getMemoriesForPerson,
  insertMemory,
} from '../memory/db.ts';
import { reflect } from './reflector.ts';
import type { InsertMemoryInput } from '../memory/db.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMemory(
  personId: string,
  text: string,
  importance: number,
  simTime: number,
  _id: number,
): InsertMemoryInput {
  return {
    person_id: personId,
    kind: 'observation',
    text,
    sim_time: simTime,
    last_access: simTime,
    importance,
    // 384-dim zero vector — fine for retrieval in a test with no real cosine ranking needed
    embedding: Buffer.from(new Float32Array(384).buffer),
    source_ref: `test://mem/${_id}`,
    evidence_ids: null,
  };
}

/**
 * Mock session that returns scripted responses in order.
 * Each sendAndWait call consumes the next response in the queue.
 */
function makeScriptedSession(responses: string[]): {
  sendAndWait(opts: { prompt: string }): Promise<{ text: string }>;
} {
  let idx = 0;
  return {
    async sendAndWait({ prompt: _p }: { prompt: string }) {
      const text = responses[idx++] ?? '[]';
      return { text };
    },
  };
}

function makeInMemoryDb(personId: string, personName: string, role: string) {
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
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  db.prepare(`INSERT INTO people VALUES (?,?,?,?,?,?,?)`)
    .run(personId, personName, role, '{}', personId, 100, 100);
  return db;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('reflect – importance-budget trigger', () => {
  // Shared DB used across the first two tests.
  let db: import('better-sqlite3').Database;
  const personId = 'priya';

  before(async () => {
    db = makeInMemoryDb(personId, 'Priya', 'PM');

    // Insert 20 memories × importance 8 = 160 > 150 threshold → triggers once
    const SIM_START = Date.parse('2026-06-08T09:00:00Z');
    for (let i = 0; i < 20; i++) {
      insertMemory(db, makeMemory(personId, `Memory event number ${i + 1}`, 8, SIM_START + i * 3_600_000, i));
    }
  });

  it('inserts at least 3 thought memories when importance budget exceeded', async () => {
    // Scripted responses:
    //  1st call → focal questions (JSON array of 3 strings)
    //  2nd call → insights for Q1 (numbered lines with evidence pointers)
    //  3rd call → importance scores for Q1 insights
    //  4th call → insights for Q2
    //  5th call → importance scores for Q2 insights
    //  6th call → insights for Q3
    //  7th call → importance scores for Q3 insights
    const session = makeScriptedSession([
      // Focal questions
      JSON.stringify([
        'Why is the Atlas launch blocked?',
        'How is the team coping with the vendor delay?',
        'What decisions were made this week?',
      ]),
      // Insights for Q1 — 3 insights with (because of N, M) notation
      `1. The vendor API has a timeout bug (because of 1, 3)\n2. The team is waiting on a ticket (because of 2, 5)\n3. A workaround was proposed but is risky (because of 4)`,
      // Importance scores for Q1 insights (3 items)
      '[7, 6, 5]',
      // Insights for Q2
      `1. Dana is frustrated with the pace (because of 6, 7)\n2. Ben is scheduling extra syncs (because of 8)`,
      // Importance scores for Q2 insights (2 items)
      '[6, 5]',
      // Insights for Q3
      `1. Marco dropped GraphQL for REST (because of 10, 11)`,
      // Importance scores for Q3 insights (1 item)
      '[8]',
    ]);

    // Provide a simple embed stub — returns a unique non-zero vector per call.
    let embedCallCount = 0;
    const embedStub = async (texts: string[]): Promise<Float32Array[]> =>
      texts.map(() => {
        const v = new Float32Array(384);
        v[embedCallCount++ % 384] = 1.0; // unique dimension per call
        return v;
      });

    await reflect(session, db, personId, embedStub);

    const allMems = getMemoriesForPerson(db, personId);
    const thoughts = allMems.filter(m => m.kind === 'thought');
    assert.ok(thoughts.length >= 3, `expected ≥3 thought memories, got ${thoughts.length}`);
  });

  it('thought memories have non-null evidence_ids', () => {
    const allMems = getMemoriesForPerson(db, personId);
    const thoughts = allMems.filter(m => m.kind === 'thought');
    for (const t of thoughts) {
      assert.ok(t.evidence_ids !== null, `thought ${t.id} missing evidence_ids`);
      const ids: unknown = JSON.parse(t.evidence_ids!);
      assert.ok(Array.isArray(ids) && (ids as unknown[]).length > 0, `thought ${t.id} has empty evidence_ids`);
    }
  });

  it('does NOT trigger reflection when importance total is below 150', async () => {
    // Fresh DB with only 5 memories × importance 8 = 40 < 150
    const db2 = makeInMemoryDb('dana', 'Dana', 'Backend');

    const SIM_START = Date.parse('2026-06-08T09:00:00Z');
    for (let i = 0; i < 5; i++) {
      insertMemory(db2, makeMemory('dana', `Low-importance event ${i}`, 8, SIM_START + i * 3_600_000, i));
    }

    let sessionCalled = false;
    const session = {
      async sendAndWait(_opts: { prompt: string }) {
        sessionCalled = true;
        return { text: '[]' };
      },
    };
    const embedStub = async (texts: string[]): Promise<Float32Array[]> =>
      texts.map(() => new Float32Array(384));

    await reflect(session, db2, 'dana', embedStub);

    const thoughts = getMemoriesForPerson(db2, 'dana').filter(m => m.kind === 'thought');
    assert.equal(thoughts.length, 0, 'no reflections expected below threshold');
    assert.equal(sessionCalled, false, 'LLM should not be called below threshold');
  });
});
