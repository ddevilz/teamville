// src/sim/engine.test.ts
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createEngine } from './engine.ts';
import { NODES } from './map.ts';
import { WALK_MS } from './walk.ts';

// ── Frozen sim constants (from spec) ─────────────────────────────────────────
const SIM_START = Date.parse('2026-06-08T09:00:00Z'); // 1749376800000
const SIM_END   = Date.parse('2026-06-12T18:00:00Z'); // 1749754800000

// ── Minimal fixture ───────────────────────────────────────────────────────────
// Two people: priya and tom.
const PEOPLE = [
  { id: 'priya', name: 'Priya', role: 'PM',
    persona_json: '{}', sprite: 'priya', desk_x: 120, desk_y: 160 },
  { id: 'tom',   name: 'Tom',   role: 'Frontend',
    persona_json: '{}', sprite: 'tom',   desk_x: 560, desk_y: 160 },
];

// Event: priya and tom attend standup 09:30–09:45 Mon (30 min after SIM_START)
const STANDUP_START = SIM_START + 30 * 60 * 1000;  // 09:30
const STANDUP_END   = SIM_START + 45 * 60 * 1000;  // 09:45

// Event: priya goes to war_room 14:00–15:00 Wed
const WAR_START = Date.parse('2026-06-10T14:00:00Z');
const WAR_END   = Date.parse('2026-06-10T15:00:00Z');

const EVENTS = [
  {
    id: 1,
    sim_time:     STANDUP_START,
    duration_min: 15,
    kind:         'meeting',
    location:     'standup_room',
    participants: JSON.stringify(['priya', 'tom']),
    payload:      JSON.stringify({ topic: 'Sprint standup', bubble: 'Sprint standup — Atlas launch' }),
  },
  {
    id: 2,
    sim_time:     WAR_START,
    duration_min: 60,
    kind:         'incident',
    location:     'war_room',
    participants: JSON.stringify(['priya']),
    payload:      JSON.stringify({ topic: 'API latency spike', bubble: 'API latency spike — investigating' }),
  },
];

// ── Tests ─────────────────────────────────────────────────────────────────────

test('createEngine returns an object with getState', () => {
  const engine = createEngine(EVENTS, PEOPLE);
  assert.ok(typeof engine.getState === 'function');
});

test('getState at SIM_START: all agents at their desks', () => {
  const engine = createEngine(EVENTS, PEOPLE);
  const state  = engine.getState(SIM_START);
  assert.equal(state.simTime, SIM_START);
  assert.equal(state.agents.length, 2);

  const priya = state.agents.find(a => a.id === 'priya')!;
  const tom   = state.agents.find(a => a.id === 'tom')!;

  // Before standup walk begins they must be at their desks
  assert.equal(priya.location, 'desk_priya');
  assert.equal(tom.location,   'desk_tom');

  // Pixel coords match desk node coords (from map, not from person.desk_x)
  const deskPriya = NODES.find(n => n.id === 'desk_priya')!;
  const deskTom   = NODES.find(n => n.id === 'desk_tom')!;
  assert.equal(priya.x, deskPriya.x);
  assert.equal(priya.y, deskPriya.y);
  assert.equal(tom.x,   deskTom.x);
  assert.equal(tom.y,   deskTom.y);

  // No active event → no bubble
  assert.equal(priya.bubble, null);
  assert.equal(tom.bubble,   null);
});

test('getState during standup: agents walking or arrived, bubble set', () => {
  const engine = createEngine(EVENTS, PEOPLE);
  // Query at the midpoint of the walk window (well within WALK_MS after segment start)
  // Segment for standup starts at STANDUP_START.
  // We query at STANDUP_START + WALK_MS/2 (half-way through walk).
  const tWalking = STANDUP_START + Math.round(WALK_MS / 2);
  const state    = engine.getState(tWalking);

  const priya = state.agents.find(a => a.id === 'priya')!;
  const tom   = state.agents.find(a => a.id === 'tom')!;

  // Both must NOT be at destination yet
  const standupNode = NODES.find(n => n.id === 'standup_room')!;
  // At exactly half-walk they have not yet arrived (path has >1 hop for priya)
  assert.ok(
    priya.x !== standupNode.x || priya.y !== standupNode.y,
    'priya should not be at standup_room yet at half-walk'
  );

  // Bubble should be set (event is active)
  assert.equal(priya.bubble, 'Sprint standup — Atlas launch');
  assert.equal(tom.bubble,   'Sprint standup — Atlas launch');

  // Activity comes from event kind
  assert.equal(priya.activity, 'meeting');
  assert.equal(tom.activity,   'meeting');
});

test('getState after standup ends: agents back at desks, bubble null', () => {
  const engine = createEngine(EVENTS, PEOPLE);
  // STANDUP_END + WALK_MS ensures walk back is also complete
  const tAfter = STANDUP_END + WALK_MS + 1;
  const state  = engine.getState(tAfter);

  const priya = state.agents.find(a => a.id === 'priya')!;
  const tom   = state.agents.find(a => a.id === 'tom')!;

  assert.equal(priya.location, 'desk_priya');
  assert.equal(tom.location,   'desk_tom');
  assert.equal(priya.bubble,   null);
  assert.equal(tom.bubble,     null);
});

test('getState is deterministic (same t → identical output)', () => {
  const engine = createEngine(EVENTS, PEOPLE);
  const t      = STANDUP_START + 20_000;
  const s1     = engine.getState(t);
  const s2     = engine.getState(t);
  assert.deepStrictEqual(s1, s2);
});

test('tom not in war_room event: stays at desk during war_room segment', () => {
  const engine  = createEngine(EVENTS, PEOPLE);
  // Query well into the war room incident (after walking window)
  const tWarMid = WAR_START + WALK_MS + 1;
  const state   = engine.getState(tWarMid);

  const priya = state.agents.find(a => a.id === 'priya')!;
  const tom   = state.agents.find(a => a.id === 'tom')!;

  // Priya should have arrived at war_room
  assert.equal(priya.location, 'war_room');
  assert.equal(priya.bubble,   'API latency spike — investigating');

  // Tom is not in this event — he should be at his desk
  assert.equal(tom.location, 'desk_tom');
  assert.equal(tom.bubble,   null);
});

test('agent at standup arrival: coords match standup_room node', () => {
  const engine   = createEngine(EVENTS, PEOPLE);
  // After full walk the agent is at destination
  const tArrived = STANDUP_START + WALK_MS + 1;
  const state    = engine.getState(tArrived);
  const priya    = state.agents.find(a => a.id === 'priya')!;
  const node     = NODES.find(n => n.id === 'standup_room')!;
  assert.equal(priya.x, node.x);
  assert.equal(priya.y, node.y);
  assert.equal(priya.location, 'standup_room');
});

test('bubble is null when no event is active', () => {
  const engine = createEngine(EVENTS, PEOPLE);
  // Midday Monday — no event running
  const tQuiet = SIM_START + 2 * 60 * 60 * 1000; // 11:00
  const state  = engine.getState(tQuiet);
  for (const a of state.agents) {
    assert.equal(a.bubble, null, `${a.id} should have null bubble at quiet time`);
  }
});

test('getState at SIM_END clamps correctly (no crash)', () => {
  const engine = createEngine(EVENTS, PEOPLE);
  const state  = engine.getState(SIM_END);
  assert.equal(state.simTime, SIM_END);
  assert.equal(state.agents.length, 2);
  // All agents at desks at SIM_END (no events running)
  for (const a of state.agents) {
    assert.equal(a.bubble, null);
  }
});
