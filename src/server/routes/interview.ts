/**
 * POST /interview route factory.
 *
 * Accepts: { personId: string, question: string }
 * Returns the full InterviewResult from runInterview.
 *
 * 400 — missing personId or question
 * 404 — personId not found (runInterview throws with "Unknown personId")
 * 500 — unexpected pipeline error
 *
 * createInterviewRouter accepts a dependency object so tests can inject a
 * mock runInterview without touching the real pipeline or DB.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { runInterview as _runInterview } from '../../interview/pipeline.ts';
import type { InterviewResult } from '../../interview/pipeline.ts';
import type Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Dependency injection interface
// ---------------------------------------------------------------------------

export interface InterviewRouterDeps {
  /**
   * Injectable runInterview function. Defaults to the real pipeline.
   * Signature mirrors runInterview(db, personId, question).
   */
  runInterview?: (
    db: Database.Database | null,
    personId: string,
    question: string,
  ) => Promise<InterviewResult>;
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

/**
 * Create the interview router with optional dependency injection.
 *
 * The db instance is read from req.app.locals.db (set by the server at startup).
 * Tests that don't need a real DB can pass a mock runInterview that ignores db.
 *
 * @param deps - Optional deps for testing
 * @returns Express Router handling POST /
 */
export function createInterviewRouter(deps: InterviewRouterDeps = {}): Router {
  const runInterview = deps.runInterview ?? _runInterview;

  const router = Router();

  router.post('/', async (req: Request, res: Response): Promise<void> => {
    const body = req.body as Record<string, unknown> | undefined;
    const personId = body?.personId;
    const question = body?.question;

    // 400: validate required fields
    if (!personId || typeof personId !== 'string' || personId.trim() === '') {
      res.status(400).json({ error: 'personId is required and must be a non-empty string.' });
      return;
    }
    if (!question || typeof question !== 'string' || question.trim() === '') {
      res.status(400).json({ error: 'question is required and must be a non-empty string.' });
      return;
    }

    // Retrieve the shared DB handle from app locals (may be null in tests)
    const db = (req.app.locals as { db?: Database.Database | null }).db ?? null;

    let result: InterviewResult;
    try {
      result = await runInterview(db as Database.Database, personId.trim(), question.trim());
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Unknown personId')) {
        res.status(404).json({ error: msg });
        return;
      }
      console.error('[interview route] pipeline error:', err);
      res.status(500).json({ error: 'Interview pipeline failed. Check server logs.' });
      return;
    }

    res.json(result);
  });

  return router;
}
