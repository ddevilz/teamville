// src/sim/map.test.ts
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { NODES, EDGES, ROOMS, LOCATION_NODE_IDS, nodeById, bfs } from './map.ts';

test('NODES contains all 12 canonical location node IDs', () => {
  const REQUIRED_IDS = [
    'desk_priya', 'desk_dana', 'desk_tom', 'desk_marco', 'desk_sara', 'desk_ben',
    'standup_room', 'war_room', 'kitchen', 'lobby', 'focus_booth', 'whiteboard',
  ];
  const ids = NODES.map(n => n.id);
  for (const req of REQUIRED_IDS) {
    assert.ok(ids.includes(req), `missing node: ${req}`);
  }
  // The 12 canonical ids stay exactly these (the engine only ever targets them).
  assert.deepEqual([...LOCATION_NODE_IDS].sort(), [...REQUIRED_IDS].sort());
});

test('NODES = 12 canonical locations + 6 door waypoints = 18', () => {
  const doorIds = NODES.map(n => n.id).filter(id => id.startsWith('door_'));
  assert.equal(doorIds.length, 6, 'expected one door waypoint per room');
  assert.equal(NODES.length, 18);
});

test('every NODES entry has numeric x, y within 960x640', () => {
  for (const n of NODES) {
    assert.ok(typeof n.x === 'number', `${n.id}.x not a number`);
    assert.ok(typeof n.y === 'number', `${n.id}.y not a number`);
    assert.ok(n.x >= 0 && n.x <= 960, `${n.id}.x=${n.x} out of range`);
    assert.ok(n.y >= 0 && n.y <= 640, `${n.id}.y=${n.y} out of range`);
  }
});

test('desk node coords match frozen people.json values', () => {
  // Frozen from people.json — must never drift
  const FROZEN: Record<string, { x: number; y: number }> = {
    desk_priya: { x: 120, y: 160 },
    desk_dana:  { x: 340, y: 160 },
    desk_tom:   { x: 560, y: 160 },
    desk_marco: { x: 120, y: 380 },
    desk_sara:  { x: 340, y: 380 },
    desk_ben:   { x: 560, y: 380 },
  };
  for (const [id, expected] of Object.entries(FROZEN)) {
    const n = nodeById(id);
    assert.equal(n.x, expected.x, `${id}.x mismatch`);
    assert.equal(n.y, expected.y, `${id}.y mismatch`);
  }
});

test('EDGES are bidirectional and reference valid node IDs', () => {
  const ids = new Set(NODES.map(n => n.id));
  for (const [a, b] of EDGES) {
    assert.ok(ids.has(a), `edge references unknown node: ${a}`);
    assert.ok(ids.has(b), `edge references unknown node: ${b}`);
  }
  // Check no self-loops
  for (const [a, b] of EDGES) {
    assert.notEqual(a, b, `self-loop on node ${a}`);
  }
});

test('nodeById returns correct node', () => {
  const n = nodeById('standup_room');
  assert.equal(n.id, 'standup_room');
});

test('nodeById throws for unknown id', () => {
  assert.throws(() => nodeById('nowhere'), /unknown node/);
});

test('graph is connected (BFS from lobby reaches all nodes)', () => {
  for (const n of NODES) {
    const path = bfs('lobby', n.id);
    assert.ok(path.length >= 1, `lobby cannot reach ${n.id}`);
  }
});

// ── Room geometry ─────────────────────────────────────────────────────────────

test('ROOMS describes all 6 enclosed rooms', () => {
  const ids = ROOMS.map(r => r.id).sort();
  assert.deepEqual(ids, [
    'focus_booth', 'kitchen', 'lobby', 'standup_room', 'war_room', 'whiteboard',
  ]);
});

test('every room rect lies fully within the 960x640 canvas', () => {
  for (const r of ROOMS) {
    assert.ok(r.x >= 0 && r.y >= 0, `${r.id} top-left out of canvas`);
    assert.ok(r.x + r.w <= 960, `${r.id} right edge ${r.x + r.w} > 960`);
    assert.ok(r.y + r.h <= 640, `${r.id} bottom edge ${r.y + r.h} > 640`);
  }
});

test('room rects do not overlap each other', () => {
  for (let i = 0; i < ROOMS.length; i++) {
    for (let j = i + 1; j < ROOMS.length; j++) {
      const a = ROOMS[i];
      const b = ROOMS[j];
      const disjoint =
        a.x + a.w <= b.x || b.x + b.w <= a.x ||
        a.y + a.h <= b.y || b.y + b.h <= a.y;
      assert.ok(disjoint, `rooms overlap: ${a.id} & ${b.id}`);
    }
  }
});

test("each room's interior location node sits inside its wall rect", () => {
  for (const r of ROOMS) {
    const n = nodeById(r.id); // canonical interior node shares the room id
    assert.ok(n.x >= r.x && n.x <= r.x + r.w, `${r.id} interior x outside rect`);
    assert.ok(n.y >= r.y && n.y <= r.y + r.h, `${r.id} interior y outside rect`);
  }
});

test("each room's door waypoint sits at the doorway gap on the door wall", () => {
  const doorIdFor: Record<string, string> = {
    standup_room: 'door_standup',
    war_room:     'door_war',
    kitchen:      'door_kitchen',
    lobby:        'door_lobby',
    focus_booth:  'door_focus',
    whiteboard:   'door_whiteboard',
  };
  for (const r of ROOMS) {
    const door = nodeById(doorIdFor[r.id]);
    // Expected gap centre on the named wall.
    let ex: number;
    let ey: number;
    if (r.doorSide === 'left')   { ex = r.x;        ey = r.y + r.h * r.doorOffset; }
    else if (r.doorSide === 'right')  { ex = r.x + r.w;  ey = r.y + r.h * r.doorOffset; }
    else if (r.doorSide === 'top')    { ex = r.x + r.w * r.doorOffset; ey = r.y; }
    else                              { ex = r.x + r.w * r.doorOffset; ey = r.y + r.h; }
    // Allow ±1px rounding between the float gap centre and the node coord.
    assert.ok(Math.abs(door.x - ex) <= 1, `${r.id} door x ${door.x} != gap ${ex}`);
    assert.ok(Math.abs(door.y - ey) <= 1, `${r.id} door y ${door.y} != gap ${ey}`);
  }
});

// ── Doorway pathing (determinism guard) ─────────────────────────────────────────

test('desk→room BFS path passes THROUGH the room door waypoint', () => {
  // Shortest desk→room hop: desk_tom → standup_room enters via door_standup.
  assert.deepEqual(
    bfs('desk_tom', 'standup_room'),
    ['desk_tom', 'door_standup', 'standup_room'],
  );
  // war_room from its nearest desk likewise threads its door.
  assert.deepEqual(
    bfs('desk_ben', 'war_room'),
    ['desk_ben', 'door_war', 'war_room'],
  );
  // A cross-office route enters the destination room via its door (not a wall).
  const far = bfs('lobby', 'standup_room');
  assert.equal(far[far.length - 2], 'door_standup');
  assert.equal(far[far.length - 1], 'standup_room');
});

test('the 6 canonical desk→standup paths all enter via door_standup', () => {
  for (const desk of ['desk_priya', 'desk_dana', 'desk_tom',
                       'desk_marco', 'desk_sara', 'desk_ben']) {
    const path = bfs(desk, 'standup_room');
    assert.equal(path[path.length - 2], 'door_standup',
      `${desk} must reach standup_room through its doorway`);
  }
});
