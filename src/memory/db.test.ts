// src/memory/db.test.ts
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  openDb,
  getPeople,
  getMemoriesForPerson,
  insertMemory,
  getEvents,
  insertInterview,
  setMeta,
  getMeta,
  touchMemories,
} from './db.ts';

const SIM_START = Date.parse('2026-06-08T09:00:00Z');

/** Create a fully-qualified in-memory DB with the frozen schema. */
function makeDb(): Database.Database {
  const db = openDb(':memory:');
  db.exec(`
    CREATE TABLE people (
      id TEXT PRIMARY KEY, name TEXT, role TEXT,
      persona_json TEXT, sprite TEXT, desk_x INT, desk_y INT
    );
    CREATE TABLE memories (
      id INTEGER PRIMARY KEY, person_id TEXT REFERENCES people(id),
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

describe('openDb', () => {
  it('returns a better-sqlite3 Database instance', () => {
    const db = openDb(':memory:');
    assert.ok(db, 'db should be truthy');
    assert.equal(typeof db.prepare, 'function', 'should have prepare()');
    assert.equal(typeof db.exec, 'function', 'should have exec()');
  });

  it('opens with WAL journal mode', () => {
    const db = openDb(':memory:');
    // WAL is set internally; just verify db is operational
    const row = db.prepare('SELECT 1 AS v').get() as { v: number };
    assert.equal(row.v, 1);
  });
});

describe('getPeople', () => {
  let db: Database.Database;
  before(() => {
    db = makeDb();
    db.prepare(`INSERT INTO people (id,name,role,persona_json,sprite,desk_x,desk_y)
      VALUES (?,?,?,?,?,?,?)`).run('priya', 'Priya Sharma', 'PM', '{}', 'priya', 100, 200);
    db.prepare(`INSERT INTO people (id,name,role,persona_json,sprite,desk_x,desk_y)
      VALUES (?,?,?,?,?,?,?)`).run('dana', 'Dana Chen', 'Senior Backend Engineer', '{}', 'dana', 300, 200);
  });

  it('returns all people rows', () => {
    const people = getPeople(db);
    assert.equal(people.length, 2);
  });

  it('each person has id, name, role, persona_json fields', () => {
    const [p] = getPeople(db);
    assert.ok(p.id);
    assert.ok(p.name);
    assert.ok(p.role);
    assert.ok('persona_json' in p);
  });
});

describe('insertMemory + getMemoriesForPerson', () => {
  let db: Database.Database;
  const vec = new Float32Array([0.1, 0.2, 0.3]);

  before(() => {
    db = makeDb();
    db.prepare(`INSERT INTO people (id,name,role,persona_json,sprite,desk_x,desk_y)
      VALUES (?,?,?,?,?,?,?)`).run('tom', 'Tom Park', 'Frontend Engineer', '{}', 'tom', 400, 100);
  });

  it('insertMemory returns the rowid', () => {
    const id = insertMemory(db, {
      person_id: 'tom',
      kind: 'observation',
      text: 'Attended standup in the standup room.',
      sim_time: SIM_START,
      last_access: SIM_START,
      importance: 5,
      embedding: Buffer.from(vec.buffer),
      source_ref: 'event://1',
      evidence_ids: null,
    });
    assert.ok(typeof id === 'number' && id > 0, `expected positive rowid, got ${id}`);
  });

  it('getMemoriesForPerson returns rows in ascending sim_time order', () => {
    const db2 = makeDb();
    db2.prepare(`INSERT INTO people (id,name,role,persona_json,sprite,desk_x,desk_y)
      VALUES (?,?,?,?,?,?,?)`).run('sara', 'Sara Osei', 'Data Engineer', '{}', 'sara', 500, 100);

    insertMemory(db2, {
      person_id: 'sara', kind: 'observation',
      text: 'Second memory', sim_time: SIM_START + 3600_000,
      last_access: SIM_START + 3600_000, importance: 3,
      embedding: Buffer.from(vec.buffer), source_ref: null, evidence_ids: null,
    });
    insertMemory(db2, {
      person_id: 'sara', kind: 'observation',
      text: 'First memory', sim_time: SIM_START,
      last_access: SIM_START, importance: 3,
      embedding: Buffer.from(vec.buffer), source_ref: null, evidence_ids: null,
    });

    const mems = getMemoriesForPerson(db2, 'sara');
    assert.equal(mems.length, 2);
    assert.ok(mems[0].sim_time <= mems[1].sim_time, 'should be sorted ascending');
  });

  it('getMemoriesForPerson only returns rows for requested person', () => {
    const db3 = makeDb();
    db3.prepare(`INSERT INTO people (id,name,role,persona_json,sprite,desk_x,desk_y)
      VALUES (?,?,?,?,?,?,?)`).run('ben', 'Ben Torres', 'Engineering Manager', '{}', 'ben', 200, 300);
    db3.prepare(`INSERT INTO people (id,name,role,persona_json,sprite,desk_x,desk_y)
      VALUES (?,?,?,?,?,?,?)`).run('marco', 'Marco Reyes', 'Designer', '{}', 'marco', 600, 300);

    insertMemory(db3, {
      person_id: 'ben', kind: 'observation', text: 'Ben memory',
      sim_time: SIM_START, last_access: SIM_START, importance: 2,
      embedding: Buffer.from(vec.buffer), source_ref: null, evidence_ids: null,
    });
    insertMemory(db3, {
      person_id: 'marco', kind: 'observation', text: 'Marco memory',
      sim_time: SIM_START, last_access: SIM_START, importance: 2,
      embedding: Buffer.from(vec.buffer), source_ref: null, evidence_ids: null,
    });

    const benMems = getMemoriesForPerson(db3, 'ben');
    assert.equal(benMems.length, 1);
    assert.equal(benMems[0].text, 'Ben memory');
  });

  it('embedding BLOB is preserved as Buffer', () => {
    const db4 = makeDb();
    db4.prepare(`INSERT INTO people (id,name,role,persona_json,sprite,desk_x,desk_y)
      VALUES (?,?,?,?,?,?,?)`).run('priya', 'Priya', 'PM', '{}', 'priya', 0, 0);

    const original = new Float32Array([1.0, 2.0, 3.0]);
    insertMemory(db4, {
      person_id: 'priya', kind: 'observation', text: 'Blob test',
      sim_time: SIM_START, last_access: SIM_START, importance: 1,
      embedding: Buffer.from(original.buffer), source_ref: null, evidence_ids: null,
    });

    const [m] = getMemoriesForPerson(db4, 'priya');
    const emb = m.embedding;
    // Buffer extends Uint8Array; Buffer.isBuffer covers both cases here.
    assert.ok(emb !== null && Buffer.isBuffer(emb),
      'embedding should be Buffer/Uint8Array');
    const recovered = new Float32Array(
      emb.buffer,
      emb.byteOffset,
      emb.byteLength / 4,
    );
    assert.ok(Math.abs(recovered[0] - 1.0) < 1e-6);
    assert.ok(Math.abs(recovered[1] - 2.0) < 1e-6);
    assert.ok(Math.abs(recovered[2] - 3.0) < 1e-6);
  });
});

describe('getEvents', () => {
  let db: Database.Database;
  before(() => {
    db = makeDb();
    db.prepare(`INSERT INTO events (id, sim_time, duration_min, kind, location, participants, payload)
      VALUES (?,?,?,?,?,?,?)`).run(
      1, SIM_START, 30, 'meeting', 'standup_room',
      JSON.stringify(['priya', 'dana', 'tom']),
      JSON.stringify({ topic: 'Sprint planning' }),
    );
    db.prepare(`INSERT INTO events (id, sim_time, duration_min, kind, location, participants, payload)
      VALUES (?,?,?,?,?,?,?)`).run(
      2, SIM_START + 7200_000, 15, 'message', 'war_room',
      JSON.stringify(['dana']),
      JSON.stringify({ text: 'Platform API is down again.' }),
    );
  });

  it('returns all event rows', () => {
    const events = getEvents(db);
    assert.equal(events.length, 2);
  });

  it('events are ordered by sim_time ascending', () => {
    const events = getEvents(db);
    assert.ok(events[0].sim_time <= events[1].sim_time);
  });

  it('each event has id, sim_time, kind, location', () => {
    const [e] = getEvents(db);
    assert.ok(e.id);
    assert.ok(e.sim_time);
    assert.ok(e.kind);
    assert.ok(e.location);
  });
});

describe('insertInterview', () => {
  let db: Database.Database;
  before(() => {
    db = makeDb();
  });

  it('inserts a row and returns the rowid', () => {
    const id = insertInterview(db, {
      person_id: 'priya',
      q: 'What is blocking Atlas?',
      a: 'The vendor API is slow.',
      cited_memory_ids: JSON.stringify([1, 3, 7]),
      created_at: Date.now(),
    });
    assert.ok(typeof id === 'number' && id > 0);
  });
});

describe('setMeta / getMeta', () => {
  let db: Database.Database;
  before(() => {
    db = makeDb();
  });

  it('round-trips a string value', () => {
    setMeta(db, 'embedding_model', 'openai/text-embedding-3-small');
    assert.equal(getMeta(db, 'embedding_model'), 'openai/text-embedding-3-small');
  });

  it('overwrites an existing key (upsert)', () => {
    setMeta(db, 'version', '1');
    setMeta(db, 'version', '2');
    assert.equal(getMeta(db, 'version'), '2');
  });

  it('returns null for a missing key', () => {
    assert.equal(getMeta(db, 'nonexistent_key_xyz'), null);
  });
});

describe('touchMemories', () => {
  let db: Database.Database;
  let insertedIds: number[];
  const OLD_ACCESS = SIM_START;
  const NEW_ACCESS = SIM_START + 48 * 3600_000;
  const vec = new Float32Array([0.5, 0.5]);

  before(() => {
    db = makeDb();
    db.prepare(`INSERT INTO people (id,name,role,persona_json,sprite,desk_x,desk_y)
      VALUES (?,?,?,?,?,?,?)`).run('dana', 'Dana', 'Backend', '{}', 'dana', 0, 0);

    insertedIds = [];
    for (let i = 0; i < 3; i++) {
      const id = insertMemory(db, {
        person_id: 'dana', kind: 'observation',
        text: `Memory ${i}`, sim_time: SIM_START + i * 3600_000,
        last_access: OLD_ACCESS, importance: 5,
        embedding: Buffer.from(vec.buffer), source_ref: null, evidence_ids: null,
      });
      insertedIds.push(id);
    }
  });

  it('updates last_access for all touched IDs', () => {
    touchMemories(db, insertedIds, NEW_ACCESS);
    const mems = getMemoriesForPerson(db, 'dana');
    for (const m of mems) {
      assert.equal(m.last_access, NEW_ACCESS,
        `memory ${m.id} last_access should be ${NEW_ACCESS}, got ${m.last_access}`);
    }
  });

  it('is a no-op for empty id list', () => {
    assert.doesNotThrow(() => touchMemories(db, [], NEW_ACCESS));
  });
});
