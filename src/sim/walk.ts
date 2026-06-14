/**
 * Walking interpolation between two map nodes.
 *
 * A "walk segment" begins when an agent transitions to a new location.
 * The transition takes WALK_MS ms of sim time. During that window, the
 * agent's pixel position is linearly interpolated along the BFS path.
 * After WALK_MS the agent snaps (and stays) at the destination node.
 *
 * The BFS path is memoised — same (from, to) pair always returns the
 * same path object, keeping interpolation O(1) per frame.
 */
import { bfs, nodeById } from './map.ts';

/** Duration of a full node-to-node walk in sim-milliseconds (frozen). */
export const WALK_MS = 90_000;

export interface WalkPosition {
  x: number;
  y: number;
  nodeId: string;
}

/** Memoise BFS results keyed by "from|to". */
const _pathCache = new Map<string, string[]>();

/**
 * Return the memoised BFS path (array of node IDs) from `from` to `to`.
 */
function cachedPath(from: string, to: string): string[] {
  const key = `${from}|${to}`;
  let path = _pathCache.get(key);
  if (!path) {
    path = bfs(from, to);
    _pathCache.set(key, path);
  }
  return path;
}

/**
 * Compute the pixel position of an agent walking from `from` to `to`,
 * given that the walk segment started at `segStartMs` and current sim
 * time is `nowMs`.
 *
 * Position is linearly interpolated between consecutive BFS waypoints.
 * Each hop along the path takes an equal share of WALK_MS.
 *
 * @param from        - departure node ID
 * @param to          - destination node ID
 * @param segStartMs  - sim-time when this walk segment began (ms)
 * @param nowMs       - current sim-time (ms)
 * @returns pixel position and nearest waypoint nodeId
 */
export function interpolateWalk(
  from: string,
  to: string,
  segStartMs: number,
  nowMs: number,
): WalkPosition {
  if (from === to) {
    const n = nodeById(from);
    return { x: n.x, y: n.y, nodeId: from };
  }

  const path = cachedPath(from, to);   // e.g. ['a', 'b', 'c']
  const hops = path.length - 1;        // number of edges to traverse

  // Clamp elapsed time to [0, WALK_MS]
  const elapsed = Math.max(0, Math.min(WALK_MS, nowMs - segStartMs));
  const tNorm   = elapsed / WALK_MS;   // 0..1

  // Which hop are we on?
  const hopFloat = tNorm * hops;                          // 0..hops (float)
  const hopIndex = Math.min(Math.floor(hopFloat), hops - 1); // 0..hops-1
  const hopT     = hopFloat - hopIndex;                   // 0..1 within this hop

  const aId = path[hopIndex];
  const bId = path[hopIndex + 1];
  const a   = nodeById(aId);
  const b   = nodeById(bId);

  const x = Math.round(a.x + (b.x - a.x) * hopT);
  const y = Math.round(a.y + (b.y - a.y) * hopT);
  // nodeId = whichever endpoint we are closer to
  const nodeId = hopT < 0.5 ? aId : bId;

  return { x, y, nodeId };
}
