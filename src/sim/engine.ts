/**
 * Deterministic sim engine.
 *
 * createEngine(events, people) → { getState(simTime) }
 *
 * getState is a PURE function: same simTime → identical output, no
 * side-effects, no I/O. This keeps the scrubber free and the demo
 * rehearsable.
 *
 * Algorithm per agent per query:
 *   1. Find the active timeline segment for this agent at simTime.
 *      Segments are built from events whose participants include the
 *      agent. Gaps between events are filled with the agent's own desk.
 *   2. If location changed from the previous segment AND
 *      simTime < segStart + WALK_MS → interpolate position along BFS path.
 *   3. Otherwise snap to the target node's pixel coords.
 *   4. Derive activity string and bubble from the active event (or null).
 */
import { nodeById } from './map.ts';
import { interpolateWalk, WALK_MS } from './walk.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Person {
  id: string;
  name: string;
  role: string;
  persona_json: string;
  sprite: string;
  desk_x: number;
  desk_y: number;
}

export interface Event {
  id: number;
  sim_time: number;
  duration_min: number;
  kind: string;
  location: string;
  participants: string;
  payload: string;
}

export interface AgentState {
  id: string;
  x: number;
  y: number;
  location: string;
  activity: string;
  bubble: string | null;
}

export interface SimState {
  simTime: number;
  agents: AgentState[];
}

interface Segment {
  startMs: number;
  endMs: number;
  location: string;
  kind: string;
  payload: Record<string, unknown>;
}

// ── Timeline builder ──────────────────────────────────────────────────────────

/**
 * Build the per-person timeline as a sorted array of event segments.
 * Gaps between events implicitly resolve to the person's own desk.
 */
function buildTimeline(events: Event[], person: Person): Segment[] {
  return events
    .filter(ev => {
      try {
        const parts = JSON.parse(ev.participants) as unknown;
        return Array.isArray(parts) && (parts as string[]).includes(person.id);
      } catch {
        return false;
      }
    })
    .map(ev => ({
      startMs:  ev.sim_time,
      endMs:    ev.sim_time + ev.duration_min * 60_000,
      location: ev.location,
      kind:     ev.kind,
      payload:  (() => {
        try { return JSON.parse(ev.payload ?? '{}') as Record<string, unknown>; }
        catch { return {}; }
      })(),
    }))
    .sort((a, b) => a.startMs - b.startMs);
}

// ── Agent resolver ────────────────────────────────────────────────────────────

/** True if `id` resolves to a known map node (nodeById throws otherwise). */
function isKnownNode(id: string): boolean {
  try {
    nodeById(id);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a single agent's state at simTime.
 * Pure: no mutation, no I/O.
 *
 * Overlap policy: if two events for the same person overlap at simTime, the
 * EARLIER-STARTING event wins. `timeline` is sorted ascending by startMs and
 * `Array.find` returns the first match, so the earlier event takes precedence.
 * (This is what keeps participants inside hero-beat rooms — e.g. the war_room
 * incident — even when a concurrent desk 1:1 is also scheduled.)
 *
 * Unknown-location safety: if an event's location is not one of the 12 map
 * nodes, the agent falls back to its own desk instead of throwing — one
 * typo'd location in events.json must not 500 the entire village render.
 */
function resolveAgent(
  person: Person,
  timeline: Segment[],
  simTime: number,
): AgentState {
  const deskNodeId = `desk_${person.id}`;

  // Active segment: event currently running (earlier-starting wins on overlap)
  const active = timeline.find(
    seg => simTime >= seg.startMs && simTime < seg.endMs,
  ) ?? null;

  // Previous segment: last event that ended at or before simTime
  const prev = timeline
    .filter(seg => seg.endMs <= simTime)
    .at(-1) ?? null;  // last element

  // Where the agent is headed right now. Unknown event location → desk fallback.
  const currentLocation =
    active && isKnownNode(active.location) ? active.location : deskNodeId;

  // Where the agent was before the current segment began
  let prevLocation: string;
  if (active) {
    // Walking TO active.location FROM wherever they were before
    const beforeActive = timeline
      .filter(seg => seg.endMs <= active.startMs)
      .at(-1) ?? null;
    prevLocation = beforeActive ? beforeActive.location : deskNodeId;
  } else {
    // Between events: walking back to desk FROM the last event
    prevLocation = prev ? prev.location : deskNodeId;
  }
  // Sanitize prevLocation too: an unknown prior location would crash the
  // walk interpolation (bfs → nodeById). Snap from desk instead.
  if (!isKnownNode(prevLocation)) prevLocation = deskNodeId;

  // When this transition segment started
  const segStartMs = active
    ? active.startMs
    : prev
      ? prev.endMs
      : 0;

  // Are we mid-walk?
  const isWalking =
    prevLocation !== currentLocation &&
    simTime < segStartMs + WALK_MS;

  let x: number;
  let y: number;
  let nodeId: string;

  if (isWalking) {
    const result = interpolateWalk(prevLocation, currentLocation, segStartMs, simTime);
    x      = result.x;
    y      = result.y;
    nodeId = result.nodeId;
  } else {
    const node = nodeById(currentLocation);
    x      = node.x;
    y      = node.y;
    nodeId = currentLocation;
  }

  // Activity: event kind when active, otherwise 'idle'
  const activity = active ? active.kind : 'idle';

  // Bubble: string from payload when event is active, otherwise null
  const bubble =
    active !== null &&
    active.payload !== null &&
    typeof active.payload['bubble'] === 'string'
      ? active.payload['bubble']
      : null;

  return { id: person.id, x, y, location: nodeId, activity, bubble };
}

// ── Engine factory ────────────────────────────────────────────────────────────

/**
 * Create the deterministic sim engine.
 *
 * @param events  - all events (pre-loaded, not mutated)
 * @param people  - all people (pre-loaded, not mutated)
 * @returns engine with a pure getState(simTime) function
 */
export function createEngine(
  events: Event[],
  people: Person[],
): { getState(simTime: number): SimState } {
  // Pre-build per-person timelines once at construction time
  const timelines = new Map<string, Segment[]>(
    people.map(p => [p.id, buildTimeline(events, p)]),
  );

  return {
    /**
     * Pure function: same simTime → identical output.
     * Complexity: O(people * events) per call (linear scan, no mutation).
     */
    getState(simTime: number): SimState {
      const agents = people.map(person =>
        resolveAgent(person, timelines.get(person.id)!, simTime),
      );
      return { simTime, agents };
    },
  };
}
