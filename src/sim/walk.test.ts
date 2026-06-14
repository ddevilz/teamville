// src/sim/walk.test.ts
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { interpolateWalk, WALK_MS } from './walk.ts';
import { NODES, bfs } from './map.ts';

// Helper: get pixel coords for a node id
const coordsOf = (id: string): { x: number; y: number } => {
  const n = NODES.find(n => n.id === id);
  if (!n) throw new Error(`unknown node ${id}`);
  return { x: n.x, y: n.y };
};

// Helper: BFS shortest path (alias, expresses intent in path-routing tests)
const bfsPath = (from: string, to: string): string[] => bfs(from, to);

test('WALK_MS is 90000 (the frozen constant)', () => {
  assert.equal(WALK_MS, 90000);
});

test('interpolateWalk at t=0 of walk returns from-node coords', () => {
  const from = 'desk_priya';
  const to   = 'standup_room';
  const segStart = 1_000_000;
  const pos = interpolateWalk(from, to, segStart, segStart);
  const expected = coordsOf(from);
  assert.equal(pos.x, expected.x);
  assert.equal(pos.y, expected.y);
  assert.equal(pos.nodeId, from);
});

test('interpolateWalk at t=WALK_MS returns to-node coords', () => {
  const from = 'desk_priya';
  const to   = 'standup_room';
  const segStart = 1_000_000;
  const pos = interpolateWalk(from, to, segStart, segStart + WALK_MS);
  const expected = coordsOf(to);
  assert.equal(pos.x, expected.x);
  assert.equal(pos.y, expected.y);
  assert.equal(pos.nodeId, to);
});

test('interpolateWalk at t=WALK_MS/2 returns the BFS waypoint at the walk midpoint', () => {
  // New layout: desk_priya → standup_room routes THROUGH the doorway, so the
  // BFS path is 5 nodes / 4 hops:
  //   desk_priya -> desk_dana -> desk_tom -> door_standup -> standup_room
  // Each hop takes WALK_MS / 4 ms. At t=WALK_MS/2 we are exactly at the END of
  // hop 1 = the 3rd waypoint = desk_tom (the open-area midpoint of the walk).
  const from = 'desk_priya';
  const to   = 'standup_room';
  const segStart = 1_000_000;
  const tMid = segStart + WALK_MS / 2;
  const pos = interpolateWalk(from, to, segStart, tMid);
  const midCoords = coordsOf('desk_tom');
  assert.equal(pos.x, midCoords.x);
  assert.equal(pos.y, midCoords.y);
  assert.equal(pos.nodeId, 'desk_tom');
});

test('interpolateWalk routes desk→room THROUGH the door waypoint', () => {
  // Determinism + doorway-pathing guard: the path from an open-area desk to an
  // enclosed room must pass through that room's door_* waypoint, never jump a
  // wall. desk_tom → standup_room is the shortest such path.
  const path = bfsPath('desk_tom', 'standup_room');
  assert.deepEqual(path, ['desk_tom', 'door_standup', 'standup_room']);
  assert.ok(path.includes('door_standup'), 'path must traverse the doorway');

  // And a long cross-office route still threads the destination room's door.
  const far = bfsPath('lobby', 'war_room');
  assert.equal(far[0], 'lobby');
  assert.equal(far[far.length - 1], 'war_room');
  assert.equal(far[far.length - 2], 'door_war', 'must enter war_room via its door');
});

test('interpolateWalk past WALK_MS snaps to to-node', () => {
  const from = 'desk_ben';
  const to   = 'kitchen';
  const segStart = 2_000_000;
  const pos = interpolateWalk(from, to, segStart, segStart + WALK_MS * 5);
  const expected = coordsOf(to);
  assert.equal(pos.x, expected.x);
  assert.equal(pos.y, expected.y);
});

test('interpolateWalk same node returns that node coords', () => {
  const pos = interpolateWalk('kitchen', 'kitchen', 0, 50000);
  const expected = coordsOf('kitchen');
  assert.equal(pos.x, expected.x);
  assert.equal(pos.y, expected.y);
  assert.equal(pos.nodeId, 'kitchen');
});

test('interpolateWalk is deterministic (same input → same output)', () => {
  const from = 'lobby';
  const to   = 'war_room';
  const segStart = 5_000_000;
  const t = segStart + 30_000;
  const p1 = interpolateWalk(from, to, segStart, t);
  const p2 = interpolateWalk(from, to, segStart, t);
  assert.deepStrictEqual(p1, p2);
});
