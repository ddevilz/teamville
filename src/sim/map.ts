/**
 * Office layout: 960×640 pixel canvas.
 *
 * This is the SINGLE SOURCE OF TRUTH for office geometry. The frontend
 * (public/game/VillageScene.ts) mirrors NODE_POSITIONS and ROOMS with the
 * exact same numbers — keep them in sync.
 *
 * Structure
 * ─────────
 *   • Central OPEN desk area (no walls): the 6 desks in 2 rows × 3 cols.
 *     Desk coords are FROZEN — they must match data/seed/people.json exactly:
 *       priya 120,160 · dana 340,160 · tom 560,160
 *       marco 120,380 · sara 340,380 · ben 560,380
 *
 *   • 6 ENCLOSED rooms around the edges (see ROOMS). Each room is a wall
 *     rectangle with a 1-tile DOORWAY gap on the side facing the open area
 *     and space for a header bar across the top. standup_room and war_room
 *     are the largest (hold 6 and 4 agents respectively).
 *
 * Pathing through doorways
 * ────────────────────────
 *   The 12 canonical LOCATION nodes (6 desks + 6 rooms) are the only targets
 *   the engine sends agents to. Each room ALSO has a hidden door-waypoint node
 *   (door_*) sitting at its doorway gap. EDGES wire:
 *
 *       room_interior ── door_room ── nearest_open_node
 *
 *   so BFS from a desk to a room walks desk → … → door_room → room_interior,
 *   i.e. THROUGH the doorway, never through a wall. Desks interconnect freely
 *   in the open area. The engine's walk interpolation is unchanged; it simply
 *   traverses more nodes.
 */

export interface MapNode {
  id: string;
  x: number;
  y: number;
  label: string;
}

/** A room's wall rectangle + doorway, consumed by the renderer. */
export interface Room {
  /** Matches the canonical interior location node id (e.g. 'standup_room'). */
  id: string;
  /** Wall-rectangle top-left x (px). */
  x: number;
  /** Wall-rectangle top-left y (px). */
  y: number;
  /** Wall-rectangle width (px). */
  w: number;
  /** Wall-rectangle height (px). */
  h: number;
  /** Which wall the doorway gap sits on (faces the open area). */
  doorSide: 'left' | 'right' | 'top' | 'bottom';
  /** Door gap centre as a fraction (0..1) along that wall. */
  doorOffset: number;
  /** Header-bar display label. */
  label: string;
}

/**
 * Room geometry — wall rectangles, doorway position, header label.
 *
 * Layout (960×640):
 *   • standup_room — right side, UPPER. Largest (holds 6). Door on LEFT.
 *   • war_room     — right side, LOWER. Large (holds 4). Door on LEFT.
 *   • kitchen      — bottom centre. Door on TOP.
 *   • lobby        — left edge, upper. Door on RIGHT (entrance pod).
 *   • focus_booth  — left edge, lower. Door on RIGHT.
 *   • whiteboard   — top centre. Door on BOTTOM.
 *
 * Invariants (asserted in map.test.ts):
 *   • every rect lies fully within 960×640,
 *   • rects do not overlap each other,
 *   • each room's interior location node sits inside its rect,
 *   • each room's door waypoint sits at the doorway gap on the door wall.
 */
export const ROOMS: Room[] = [
  { id: 'standup_room', x: 710, y:  40, w: 230, h: 210, doorSide: 'left',   doorOffset: 0.55, label: 'Standup Room' },
  { id: 'war_room',     x: 710, y: 300, w: 230, h: 200, doorSide: 'left',   doorOffset: 0.45, label: 'War Room'     },
  { id: 'kitchen',      x: 380, y: 505, w: 230, h: 115, doorSide: 'top',    doorOffset: 0.50, label: 'Kitchen'      },
  { id: 'lobby',        x:  12, y:  30, w:  80, h: 150, doorSide: 'right',  doorOffset: 0.60, label: 'Lobby'        },
  { id: 'focus_booth',  x:  12, y: 300, w:  80, h: 160, doorSide: 'right',  doorOffset: 0.45, label: 'Focus Booth' },
  { id: 'whiteboard',   x: 300, y:  25, w: 230, h:  95, doorSide: 'bottom', doorOffset: 0.50, label: 'Whiteboard'   },
];

/**
 * All 18 graph nodes:
 *   • 6 desks (open area, frozen coords),
 *   • 6 room INTERIOR centres (the 12 canonical location ids = desks + rooms),
 *   • 6 door waypoints (door_*), each at its room's doorway gap.
 *
 * The 12 canonical location ids (desk_* + the 6 room ids) are the ONLY targets
 * the engine sends agents to. door_* nodes are pure pathing waypoints.
 */
export const NODES: MapNode[] = [
  // ── Open-plan desk cluster (two rows of three) — FROZEN ────────────────────
  { id: 'desk_priya',  x: 120, y: 160, label: "Priya's Desk"  },
  { id: 'desk_dana',   x: 340, y: 160, label: "Dana's Desk"   },
  { id: 'desk_tom',    x: 560, y: 160, label: "Tom's Desk"    },
  { id: 'desk_marco',  x: 120, y: 380, label: "Marco's Desk"  },
  { id: 'desk_sara',   x: 340, y: 380, label: "Sara's Desk"   },
  { id: 'desk_ben',    x: 560, y: 380, label: "Ben's Desk"    },

  // ── Enclosed-room INTERIOR centres (canonical location ids) ────────────────
  { id: 'standup_room', x: 820, y: 155, label: 'Standup Room' },
  { id: 'war_room',     x: 820, y: 415, label: 'War Room'     },
  { id: 'kitchen',      x: 495, y: 572, label: 'Kitchen'      },
  { id: 'lobby',        x:  52, y: 115, label: 'Lobby'        },
  { id: 'focus_booth',  x:  52, y: 390, label: 'Focus Booth'  },
  { id: 'whiteboard',   x: 415, y:  82, label: 'Whiteboard'   },

  // ── Door waypoints (at each room's doorway gap; pathing only) ──────────────
  // Coords computed from ROOMS: gap centre on the door wall.
  //   standup_room: left wall  @ y = 40 + 210*0.55 = 155.5 → 156
  //   war_room:     left wall  @ y = 300 + 200*0.45 = 390
  //   kitchen:      top wall   @ x = 380 + 230*0.50 = 495
  //   lobby:        right wall @ y = 30 + 150*0.60 = 120
  //   focus_booth:  right wall @ y = 300 + 160*0.45 = 372
  //   whiteboard:   bottom wall@ x = 300 + 230*0.50 = 415
  { id: 'door_standup',    x: 710, y: 156, label: 'Standup Door'    },
  { id: 'door_war',        x: 710, y: 390, label: 'War Room Door'   },
  { id: 'door_kitchen',    x: 495, y: 505, label: 'Kitchen Door'    },
  { id: 'door_lobby',      x:  92, y: 120, label: 'Lobby Door'      },
  { id: 'door_focus',      x:  92, y: 372, label: 'Focus Door'      },
  { id: 'door_whiteboard', x: 415, y: 120, label: 'Whiteboard Door' },
];

/** The 12 canonical LOCATION node ids (desks + rooms) the engine targets. */
export const LOCATION_NODE_IDS = [
  'desk_priya', 'desk_dana', 'desk_tom', 'desk_marco', 'desk_sara', 'desk_ben',
  'standup_room', 'war_room', 'kitchen', 'lobby', 'focus_booth', 'whiteboard',
] as const;

/**
 * Undirected adjacency pairs — BFS treats each pair as bidirectional.
 *
 * Open area (desk grid):
 *   • front row: priya–dana–tom; back row: marco–sara–ben
 *   • columns: priya–marco, dana–sara, tom–ben
 *
 * Rooms connect to the open area ONLY through their door waypoint:
 *   room_interior ── door_room ── nearest open node(s)
 *
 *   • standup_room → door_standup → desk_tom        (right side, upper)
 *   • war_room     → door_war     → desk_ben        (right side, lower)
 *   • kitchen      → door_kitchen → desk_sara, desk_ben (bottom centre)
 *   • lobby        → door_lobby   → desk_priya      (top-left entrance)
 *   • focus_booth  → door_focus   → desk_marco      (left wall pod)
 *   • whiteboard   → door_whiteboard → desk_dana, desk_tom (top centre)
 *
 * This keeps the graph fully connected while forcing room access through
 * the doorway gap (never through a wall).
 */
export const EDGES: [string, string][] = [
  // ── Open-plan desk grid ────────────────────────────────────────────────────
  // front row
  ['desk_priya',   'desk_dana'    ],
  ['desk_dana',    'desk_tom'     ],
  // back row
  ['desk_marco',   'desk_sara'    ],
  ['desk_sara',    'desk_ben'     ],
  // columns (front → back)
  ['desk_priya',   'desk_marco'   ],
  ['desk_dana',    'desk_sara'    ],
  ['desk_tom',     'desk_ben'     ],

  // ── standup_room (right, upper) ────────────────────────────────────────────
  ['desk_tom',     'door_standup' ],
  ['door_standup', 'standup_room' ],

  // ── war_room (right, lower) ────────────────────────────────────────────────
  ['desk_ben',     'door_war'     ],
  ['door_war',     'war_room'     ],

  // ── kitchen (bottom centre) ────────────────────────────────────────────────
  ['desk_sara',    'door_kitchen' ],
  ['desk_ben',     'door_kitchen' ],
  ['door_kitchen', 'kitchen'      ],

  // ── lobby (top-left entrance) ──────────────────────────────────────────────
  ['desk_priya',   'door_lobby'   ],
  ['door_lobby',   'lobby'        ],

  // ── focus_booth (left wall pod) ────────────────────────────────────────────
  ['desk_marco',   'door_focus'   ],
  ['door_focus',   'focus_booth'  ],

  // ── whiteboard (top centre) ────────────────────────────────────────────────
  ['desk_dana',    'door_whiteboard' ],
  ['desk_tom',     'door_whiteboard' ],
  ['door_whiteboard', 'whiteboard'   ],
];

// ── Index ─────────────────────────────────────────────────────────────────────

const _index = new Map<string, MapNode>(NODES.map(n => [n.id, n]));

/**
 * Return the node with the given id, throwing if not found.
 */
export function nodeById(id: string): MapNode {
  const n = _index.get(id);
  if (!n) throw new Error(`unknown node: ${id}`);
  return n;
}

// ── Adjacency list (bidirectional) ────────────────────────────────────────────

const _adj = new Map<string, string[]>(NODES.map(n => [n.id, []]));
for (const [a, b] of EDGES) {
  _adj.get(a)!.push(b);
  _adj.get(b)!.push(a);
}

/**
 * BFS shortest path between two nodes.
 * Returns array of node IDs from `from` (inclusive) to `to` (inclusive).
 * If `from === to` returns `[from]`.
 * Throws if either node is unknown or if no path exists.
 */
export function bfs(from: string, to: string): string[] {
  nodeById(from); // validate
  nodeById(to);   // validate
  if (from === to) return [from];

  const visited = new Set<string>([from]);
  const queue: string[][] = [[from]]; // each element is the path so far

  while (queue.length > 0) {
    const path = queue.shift()!;
    const current = path[path.length - 1];
    for (const neighbour of (_adj.get(current) ?? [])) {
      if (neighbour === to) return [...path, neighbour];
      if (!visited.has(neighbour)) {
        visited.add(neighbour);
        queue.push([...path, neighbour]);
      }
    }
  }
  throw new Error(`no path from ${from} to ${to}`);
}
