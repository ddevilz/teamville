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
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { SimState } from '../../sim/engine.ts';

// ---------------------------------------------------------------------------
// Frozen sim window constants
// ---------------------------------------------------------------------------

/** Frozen sim start: Mon 2026-06-08 09:00 UTC */
const SIM_START = Date.parse('2026-06-08T09:00:00Z');

/** Frozen sim end: Fri 2026-06-12 18:00 UTC */
const SIM_END = Date.parse('2026-06-12T18:00:00Z');

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
