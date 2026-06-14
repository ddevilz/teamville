/**
 * GET /sim/state?t=<simTimeMs>
 *
 * Returns the positions and states of all agents at the requested sim time.
 * t must be a whole-number (integer) epoch-ms value.
 * t is clamped to [SIM_START, SIM_END] before being passed to the engine.
 *
 * Responses:
 *   200  { simTime, agents: [{ id, x, y, location, activity, bubble }] }
 *   400  { error: string }  — when t is missing, non-numeric, or fractional
 *
 * GET /sim/events
 *
 * Returns scheduled (non-ambient) events as JSON for the HUD dropdown.
 *
 * Responses:
 *   200  { events: SimEvent[] }
 *        where SimEvent = { id, simTime, durationMin, kind, location, participants, label }
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { SimState } from '../../sim/engine.ts';
import type { EventRow } from '../../memory/db.ts';

// ---------------------------------------------------------------------------
// Frozen sim window constants
// ---------------------------------------------------------------------------

/** Frozen sim start: Mon 2026-06-08 09:00 UTC */
const SIM_START = Date.parse('2026-06-08T09:00:00Z');

/** Frozen sim end: Fri 2026-06-12 18:00 UTC */
const SIM_END = Date.parse('2026-06-12T18:00:00Z');

// ---------------------------------------------------------------------------
// /sim/events — shared types + helpers
// ---------------------------------------------------------------------------

export interface SimEvent {
  id: number;
  simTime: number;
  durationMin: number;
  kind: string;
  location: string;
  participants: string[];
  label: string;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Convert a sim epoch-ms to "Mon 09:10" style.
 */
function simTimeLabel(ms: number): string {
  const d = new Date(ms);
  const day = DAY_NAMES[d.getUTCDay()] ?? '???';
  const hh  = String(d.getUTCHours()).padStart(2, '0');
  const mm  = String(d.getUTCMinutes()).padStart(2, '0');
  return `${day} ${hh}:${mm}`;
}

/**
 * Human-friendly room name from the location id.
 */
function locationLabel(loc: string): string {
  const MAP: Record<string, string> = {
    standup_room: 'Standup Room',
    war_room:     'War Room',
    whiteboard:   'Whiteboard',
    kitchen:      'Kitchen',
    lobby:        'Lobby',
    focus_booth:  'Focus Booth',
  };
  return MAP[loc] ?? loc;
}

/**
 * Build a short readable label for the event.
 * Format: "Mon 09:10 — Standup Room (all 6)"
 *      or "Wed 12:00 — War Room: API latency incident (Dana, Tom, Sara, Ben)"
 */
function buildLabel(ev: EventRow): string {
  const timePart    = simTimeLabel(ev.sim_time);
  const locPart     = locationLabel(ev.location);
  const participants: string[] = JSON.parse(ev.participants) as string[];

  // Capitalise first char of each participant id as display name
  const names = participants.map((p) => p.charAt(0).toUpperCase() + p.slice(1));

  // Extract topic from payload if present
  let topicSuffix = '';
  try {
    const payload = JSON.parse(ev.payload) as Record<string, unknown>;
    if (typeof payload['topic'] === 'string' && payload['topic'].length > 0) {
      topicSuffix = `: ${payload['topic'] as string}`;
    } else if (typeof payload['bubble'] === 'string' && payload['bubble'].length > 0 && ev.kind !== 'meeting') {
      // For non-meeting kinds, surface the bubble text as a hint
      topicSuffix = `: ${(payload['bubble'] as string).slice(0, 50)}`;
    }
  } catch {
    // malformed payload — ignore
  }

  const countPart =
    names.length >= 6
      ? `all ${names.length}`
      : names.join(', ');

  return `${timePart} — ${locPart}${topicSuffix} (${countPart})`;
}

/**
 * Convert an EventRow to the public SimEvent shape.
 */
function toSimEvent(ev: EventRow): SimEvent {
  return {
    id:          ev.id,
    simTime:     ev.sim_time,
    durationMin: ev.duration_min,
    kind:        ev.kind,
    location:    ev.location,
    participants: JSON.parse(ev.participants) as string[],
    label:       buildLabel(ev),
  };
}

// ---------------------------------------------------------------------------
// Events router deps + factory
// ---------------------------------------------------------------------------

export interface EventsRouterDeps {
  /** All event rows from the DB, sorted by sim_time. */
  events: EventRow[];
}

/**
 * Create the /sim/events router.
 *
 * Returns all non-ambient scheduled events (meetings, incidents, 1on1s in rooms)
 * as a JSON array sorted by simTime, ready for the HUD dropdown.
 */
export function createEventsRouter(deps: EventsRouterDeps): Router {
  const { events } = deps;

  // Pre-filter + convert once at startup — the event list is static.
  // Show only meaningful GATHERINGS in the dropdown: events held in a room, or
  // with 2+ participants. This drops solo desk "messages" (1 person at a desk),
  // which are ambient flavour, not events you'd want to jump to and watch.
  const ROOM_LOCATIONS = new Set([
    'standup_room', 'war_room', 'kitchen', 'lobby', 'focus_booth', 'whiteboard',
  ]);
  const simEvents: SimEvent[] = events
    .filter((ev) => ev.kind !== 'ambient')
    .map(toSimEvent)
    .filter((e) => ROOM_LOCATIONS.has(e.location) || e.participants.length >= 2)
    .sort((a, b) => a.simTime - b.simTime);

  const router = Router();

  router.get('/events', (_req: Request, res: Response): void => {
    res.json({ events: simEvents });
  });

  return router;
}

// ---------------------------------------------------------------------------
// Dependency interface
// ---------------------------------------------------------------------------

export interface SimRouterDeps {
  /** Pre-built engine instance. Must be created once and reused. */
  engine: { getState(simTime: number): SimState };
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

/**
 * Create the sim state router.
 *
 * Accepts an engine instance so the route stays testable without a real DB.
 * In production, the engine is built once in src/server/index.ts and injected here.
 *
 * @param deps - Dependencies including the pre-built engine
 * @returns Express Router handling GET /state
 */
export function createSimRouter(deps: SimRouterDeps): Router {
  const { engine } = deps;

  const router = Router();

  router.get('/state', (req: Request, res: Response): void => {
    const raw = req.query['t'];

    // Missing or empty parameter
    if (raw === undefined || raw === '') {
      res.status(400).json({ error: 'Missing required query parameter: t (simTimeMs)' });
      return;
    }

    // Must be a string that parses to a finite integer
    const numeric = Number(raw);
    if (!Number.isFinite(numeric) || !Number.isInteger(numeric)) {
      res.status(400).json({
        error: 'Query parameter t must be a finite integer (epoch milliseconds)',
      });
      return;
    }

    // Clamp to sim window
    const clamped = Math.max(SIM_START, Math.min(SIM_END, numeric));

    const state = engine.getState(clamped);
    res.json(state);
  });

  return router;
}
