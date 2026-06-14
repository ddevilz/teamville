/**
 * Tests for GET /sim/state route.
 *
 * Uses Node's built-in test runner and fetch (Node 18+).
 *
 * Two test groups:
 *   1. Basic route behaviour (clamp, 400, shape) — uses a 1-person engine.
 *   2. S2/S3 scenario backing (standup_room, war_room) — uses a 6-person engine
 *      with seed-shaped events aligned to the frozen sim window.
 *
 * Visual checks (S1/S2/S3 as rendered in Phaser) remain deferred to Section 6/8.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createSimRouter } from './sim.ts';
import { createEngine } from '../../sim/engine.ts';
import type { Person, Event, SimState } from '../../sim/engine.ts';

// ── Frozen sim constants ──────────────────────────────────────────────────────
const SIM_START = Date.parse('2026-06-08T09:00:00Z'); // 1780909200000
const SIM_END   = Date.parse('2026-06-12T18:00:00Z'); // 1781287200000

// WALK_MS must match src/sim/walk.ts — frozen at 90_000 ms
const WALK_MS = 90_000;

// ── Minimal fixture (1 person, no events) ────────────────────────────────────
const MINIMAL_PEOPLE: Person[] = [
  {
    id: 'priya',
    name: 'Priya Sharma',
    role: 'PM',
    persona_json: '{}',
    sprite: 'priya',
    desk_x: 120,
    desk_y: 160,
  },
];

// ── Seed-shaped 6-person fixture ─────────────────────────────────────────────
// Desk coords match people.json exactly.
const SEED_PEOPLE: Person[] = [
  { id: 'priya',  name: 'Priya Sharma',   role: 'PM',                       persona_json: '{}', sprite: 'priya',  desk_x: 120, desk_y: 160 },
  { id: 'dana',   name: 'Dana Chen',      role: 'Senior Backend Engineer',   persona_json: '{}', sprite: 'dana',   desk_x: 340, desk_y: 160 },
  { id: 'tom',    name: 'Tom Park',       role: 'Frontend Engineer',         persona_json: '{}', sprite: 'tom',    desk_x: 560, desk_y: 160 },
  { id: 'marco',  name: 'Marco Reyes',    role: 'Designer',                  persona_json: '{}', sprite: 'marco',  desk_x: 120, desk_y: 380 },
  { id: 'sara',   name: 'Sara Osei',      role: 'Data Engineer',             persona_json: '{}', sprite: 'sara',   desk_x: 340, desk_y: 380 },
  { id: 'ben',    name: 'Ben Torres',     role: 'Engineering Manager',       persona_json: '{}', sprite: 'ben',    desk_x: 560, desk_y: 380 },
];

// S2 fixture: standup event at sim_time = SIM_START + 10*60*1000 (09:10),
// running 30 min. At Mon 09:30 (SIM_START+30m) it is active + walk is done.
// Matches seed events.json event id=1 exactly.
const S2_STANDUP_START = SIM_START + 10 * 60_000; // Mon 09:10 UTC

// S3 fixture: war_room incident at sim_time = 1781092800000 (Wed 12:00),
// running 180 min. At Wed 14:00 it is active + walk is done.
// Matches seed events.json event id=21 exactly.
const S3_WAR_ROOM_START = 1781092800000; // Wed 2026-06-10 12:00 UTC

const SEED_EVENTS: Event[] = [
  // S2: Monday standup — all 6 people, standup_room
  {
    id: 1,
    sim_time: S2_STANDUP_START,
    duration_min: 30,
    kind: 'meeting',
    location: 'standup_room',
    participants: JSON.stringify(['priya', 'dana', 'tom', 'marco', 'sara', 'ben']),
    payload: JSON.stringify({ bubble: 'Atlas launch — let\'s go' }),
  },
  // S3: Wednesday war_room incident — dana, tom, sara, ben
  {
    id: 21,
    sim_time: S3_WAR_ROOM_START,
    duration_min: 180,
    kind: 'meeting',
    location: 'war_room',
    participants: JSON.stringify(['dana', 'tom', 'sara', 'ben']),
    payload: JSON.stringify({ bubble: 'war room, incident declared — API latency spike' }),
  },
];

// ── Server helpers ────────────────────────────────────────────────────────────

type Engine = { getState(simTime: number): SimState };

async function startServer(engine: Engine): Promise<{ server: http.Server; baseUrl: string }> {
  const app = express();
  app.use('/sim', createSimRouter({ engine }));
  return new Promise((resolve) => {
    const s = http.createServer(app);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      if (!addr || typeof addr === 'string') throw new Error('unexpected address type');
      resolve({ server: s, baseUrl: `http://127.0.0.1:${(addr as { port: number }).port}` });
    });
  });
}

async function get(
  baseUrl: string,
  path: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

// ── Test group 1: basic route behaviour ───────────────────────────────────────

describe('GET /sim/state — basic route behaviour', () => {
  let server: http.Server;
  let baseUrl: string;

  before(async () => {
    const engine = createEngine([], MINIMAL_PEOPLE);
    ({ server, baseUrl } = await startServer(engine));
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('returns 200 with simTime + agents array at SIM_START', async () => {
    const { status, body } = await get(baseUrl, `/sim/state?t=${SIM_START}`);
    assert.equal(status, 200);
    const b = body as { simTime: number; agents: Array<{ id: string; x: number; y: number; location: string; activity: string; bubble: unknown }> };
    assert.equal(b.simTime, SIM_START);
    assert.ok(Array.isArray(b.agents));
    assert.equal(b.agents.length, 1);
    assert.ok(typeof b.agents[0]!.x === 'number');
    assert.ok(typeof b.agents[0]!.y === 'number');
    assert.ok(typeof b.agents[0]!.location === 'string');
    assert.ok('bubble' in b.agents[0]!);
    assert.ok('activity' in b.agents[0]!);
  });

  it('returns 200 at SIM_END', async () => {
    const { status, body } = await get(baseUrl, `/sim/state?t=${SIM_END}`);
    assert.equal(status, 200);
    const b = body as { simTime: number };
    assert.equal(b.simTime, SIM_END);
  });

  it('clamps t below SIM_START to SIM_START', async () => {
    const tBefore = SIM_START - 1_000_000;
    const { status, body } = await get(baseUrl, `/sim/state?t=${tBefore}`);
    assert.equal(status, 200);
    const b = body as { simTime: number };
    assert.equal(b.simTime, SIM_START);
  });

  it('clamps t above SIM_END to SIM_END', async () => {
    const tAfter = SIM_END + 1_000_000;
    const { status, body } = await get(baseUrl, `/sim/state?t=${tAfter}`);
    assert.equal(status, 200);
    const b = body as { simTime: number };
    assert.equal(b.simTime, SIM_END);
  });

  it('returns 400 for non-numeric t', async () => {
    const { status } = await get(baseUrl, '/sim/state?t=banana');
    assert.equal(status, 400);
  });

  it('returns 400 for missing t', async () => {
    const { status } = await get(baseUrl, '/sim/state');
    assert.equal(status, 400);
  });

  it('returns 400 for fractional t', async () => {
    const { status } = await get(baseUrl, '/sim/state?t=1780909200000.5');
    assert.equal(status, 400);
  });

  it('Content-Type is application/json for valid request', async () => {
    const res = await fetch(`${baseUrl}/sim/state?t=${SIM_START}`);
    assert.ok(
      res.headers.get('content-type')?.includes('application/json'),
      'expected application/json',
    );
  });

  it('returns idle activity and null bubble at desk when no events', async () => {
    const { body } = await get(baseUrl, `/sim/state?t=${SIM_START}`);
    const b = body as { agents: Array<{ id: string; activity: string; bubble: unknown; location: string }> };
    const priya = b.agents[0]!;
    assert.equal(priya.activity, 'idle');
    assert.equal(priya.bubble, null);
    assert.equal(priya.location, 'desk_priya');
  });
});

// ── Test group 2: S2 — standup_room at Mon 09:30 ─────────────────────────────

describe('GET /sim/state — S2 standup_room scenario', () => {
  let server: http.Server;
  let baseUrl: string;

  before(async () => {
    const engine = createEngine(SEED_EVENTS, SEED_PEOPLE);
    ({ server, baseUrl } = await startServer(engine));
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('returns 6 agents at Mon 09:30', async () => {
    const t = SIM_START + 30 * 60_000; // Mon 09:30
    const { status, body } = await get(baseUrl, `/sim/state?t=${t}`);
    assert.equal(status, 200);
    const b = body as { simTime: number; agents: object[] };
    assert.equal(b.simTime, t);
    assert.equal(b.agents.length, 6);
  });

  it('all 6 agents have activity=meeting during standup event window', async () => {
    // Well inside the standup event and well past WALK_MS
    const t = S2_STANDUP_START + WALK_MS + 60_000; // event start + 2.5 min walk + 1 min buffer
    const { body } = await get(baseUrl, `/sim/state?t=${t}`);
    const b = body as { agents: Array<{ id: string; activity: string }> };
    for (const agent of b.agents) {
      assert.equal(
        agent.activity,
        'meeting',
        `expected activity=meeting for ${agent.id}, got ${agent.activity}`,
      );
    }
  });

  it('standup participants are at standup_room after walk completes', async () => {
    // After WALK_MS, all agents should have snapped to standup_room
    const t = S2_STANDUP_START + WALK_MS + 1; // just past walk duration
    const { body } = await get(baseUrl, `/sim/state?t=${t}`);
    const b = body as { agents: Array<{ id: string; location: string }> };
    for (const agent of b.agents) {
      assert.equal(
        agent.location,
        'standup_room',
        `expected standup_room for ${agent.id}, got ${agent.location}`,
      );
    }
  });

  it('standup agents have correct bubble', async () => {
    const t = S2_STANDUP_START + WALK_MS + 1;
    const { body } = await get(baseUrl, `/sim/state?t=${t}`);
    const b = body as { agents: Array<{ id: string; bubble: unknown }> };
    for (const agent of b.agents) {
      assert.equal(
        agent.bubble,
        "Atlas launch — let's go",
        `expected standup bubble for ${agent.id}`,
      );
    }
  });
});

// ── Test group 3: S3 — war_room at Wed 14:00 ─────────────────────────────────

describe('GET /sim/state — S3 war_room scenario', () => {
  let server: http.Server;
  let baseUrl: string;

  // Wed 14:00 = 1781100000000 — inside the war_room event (12:00–15:00)
  const T_WAR = Date.parse('2026-06-10T14:00:00Z'); // 1781100000000

  before(async () => {
    const engine = createEngine(SEED_EVENTS, SEED_PEOPLE);
    ({ server, baseUrl } = await startServer(engine));
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('war_room participants are at war_room at Wed 14:00', async () => {
    // T_WAR is well past WALK_MS from S3_WAR_ROOM_START
    const { status, body } = await get(baseUrl, `/sim/state?t=${T_WAR}`);
    assert.equal(status, 200);
    const b = body as { agents: Array<{ id: string; location: string }> };

    const warParticipants = ['dana', 'tom', 'sara', 'ben'];
    const nonParticipants = ['priya', 'marco'];

    for (const agent of b.agents) {
      if (warParticipants.includes(agent.id)) {
        assert.equal(
          agent.location,
          'war_room',
          `expected war_room for ${agent.id}, got ${agent.location}`,
        );
      }
      if (nonParticipants.includes(agent.id)) {
        // Non-participants should be at their desks (no event for them at this time)
        assert.match(
          agent.location,
          /^desk_/,
          `expected desk for ${agent.id}, got ${agent.location}`,
        );
      }
    }
  });

  it('war_room participants have incident bubble', async () => {
    const { body } = await get(baseUrl, `/sim/state?t=${T_WAR}`);
    const b = body as { agents: Array<{ id: string; bubble: unknown }> };

    const warParticipants = ['dana', 'tom', 'sara', 'ben'];
    for (const agent of b.agents) {
      if (warParticipants.includes(agent.id)) {
        assert.ok(
          typeof agent.bubble === 'string' &&
            (agent.bubble as string).includes('API latency spike'),
          `expected incident bubble for ${agent.id}, got ${String(agent.bubble)}`,
        );
      }
    }
  });

  it('non-war_room agents have null bubble at Wed 14:00', async () => {
    const { body } = await get(baseUrl, `/sim/state?t=${T_WAR}`);
    const b = body as { agents: Array<{ id: string; bubble: unknown }> };
    const nonParticipants = ['priya', 'marco'];
    for (const agent of b.agents) {
      if (nonParticipants.includes(agent.id)) {
        assert.equal(
          agent.bubble,
          null,
          `expected null bubble for ${agent.id}, got ${String(agent.bubble)}`,
        );
      }
    }
  });
});

// ── Test group 4: real wiring sanity — createApp with in-memory DB ───────────

describe('GET /sim/state — real wiring via createApp with seed DB', () => {
  let server: http.Server;
  let baseUrl: string;

  before(async () => {
    // Apply schema + seed the 6 people and 2 key events in an in-memory DB.
    // This exercises the real wiring: openDb → getPeople/getEvents → createEngine.
    const { openDb, getPeople, getEvents } = await import('../../memory/db.ts');
    const { createEngine: _createEngine } = await import('../../sim/engine.ts');
    const { createSimRouter: _createSimRouter } = await import('./sim.ts');
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const schemaPath = path.resolve(__dirname, '..', '..', '..', 'db', 'schema.sql');
    const schema = readFileSync(schemaPath, 'utf-8');

    const db = openDb(':memory:');
    // db.exec handles multi-statement SQL including comments correctly
    db.exec(schema);

    // Insert seed people
    const insertPerson = db.prepare(
      'INSERT INTO people (id, name, role, persona_json, sprite, desk_x, desk_y) VALUES (@id, @name, @role, @persona_json, @sprite, @desk_x, @desk_y)',
    );
    for (const p of SEED_PEOPLE) {
      insertPerson.run(p as unknown as object);
    }

    // Insert seed events (both S2 + S3 events)
    const insertEvent = db.prepare(
      'INSERT INTO events (id, sim_time, duration_min, kind, location, participants, payload) VALUES (@id, @sim_time, @duration_min, @kind, @location, @participants, @payload)',
    );
    for (const ev of SEED_EVENTS) {
      insertEvent.run(ev as unknown as object);
    }

    const people = getPeople(db);
    const events = getEvents(db);
    const engine = _createEngine(events, people);

    const app = express();
    app.use('/sim', _createSimRouter({ engine }));

    await new Promise<void>((resolve) => {
      server = http.createServer(app);
      server.listen(0, '127.0.0.1', resolve);
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('unexpected address type');
    baseUrl = `http://127.0.0.1:${(addr as { port: number }).port}`;
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('returns 200 with 6 agents at SIM_START via real DB wiring', async () => {
    const { status, body } = await get(baseUrl, `/sim/state?t=${SIM_START}`);
    assert.equal(status, 200);
    const b = body as { simTime: number; agents: object[] };
    assert.equal(b.simTime, SIM_START);
    assert.equal(b.agents.length, 6);
  });

  it('standup participants at standup_room via real DB wiring', async () => {
    const t = S2_STANDUP_START + WALK_MS + 1;
    const { body } = await get(baseUrl, `/sim/state?t=${t}`);
    const b = body as { agents: Array<{ id: string; location: string }> };
    for (const agent of b.agents) {
      assert.equal(agent.location, 'standup_room', `${agent.id} not at standup_room`);
    }
  });

  it('war_room participants at war_room via real DB wiring', async () => {
    const { body } = await get(baseUrl, `/sim/state?t=${Date.parse('2026-06-10T14:00:00Z')}`);
    const b = body as { agents: Array<{ id: string; location: string }> };
    const warP = ['dana', 'tom', 'sara', 'ben'];
    for (const agent of b.agents) {
      if (warP.includes(agent.id)) {
        assert.equal(agent.location, 'war_room', `${agent.id} not at war_room`);
      }
    }
  });
});
