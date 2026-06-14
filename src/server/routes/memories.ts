/**
 * Express route handler for GET /memories/:personId.
 *
 * Returns all memories for a person as a JSON array, formatted for the
 * Memories tab in InterviewPanel. Strips embedding blobs and last_access
 * (internal retrieval fields). Parses evidence_ids from JSON string to array.
 *
 * Mount in src/server/index.ts:
 *   import { createMemoriesRouter } from './routes/memories.ts';
 *   app.use('/memories', createMemoriesRouter());
 *
 * Canonical dependency: getMemoriesForPerson(db, personId) from src/memory/db.ts
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { getMemoriesForPerson as _getMemoriesForPerson } from '../../memory/db.ts';
import type { MemoryRow } from '../../memory/db.ts';
import type Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Frozen person IDs — 400 if request uses anything else.
// ---------------------------------------------------------------------------

const VALID_PERSON_IDS = new Set(['priya', 'dana', 'tom', 'marco', 'sara', 'ben']);

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

export interface MemoryResponse {
  id: number;
  kind: 'observation' | 'chat' | 'thought';
  text: string;
  simTime: number;
  importance: number;
  sourceRef: string | null;
  evidenceIds: number[] | null;
}

// ---------------------------------------------------------------------------
// Handler builder (enables unit testing without HTTP overhead)
// ---------------------------------------------------------------------------

type GetMemsFn = (db: Database.Database, personId: string) => MemoryRow[];

/**
 * Build the request handler with injected dependencies (enables unit testing).
 *
 * @param db        The opened SQLite database
 * @param getMemsFn  Injectable getMemoriesForPerson; defaults to the real implementation
 * @param validIds  Set of accepted personId values; defaults to the frozen team set
 */
export function buildMemoriesHandler(
  db: Database.Database,
  getMemsFn: GetMemsFn = _getMemoriesForPerson,
  validIds: Set<string> = VALID_PERSON_IDS,
): (req: Request, res: Response) => Promise<void> {
  return async function memoriesHandler(req: Request, res: Response): Promise<void> {
    // Named route params (/:personId) are always strings; cast away the union type.
    const personId = req.params['personId'] as string;

    if (!validIds.has(personId)) {
      res.status(400).json({
        error: `Unknown personId: "${personId}". Valid IDs: ${[...validIds].join(', ')}.`,
      });
      return;
    }

    const rows = getMemsFn(db, personId);

    const result: MemoryResponse[] = rows.map((row) => {
      // Parse evidence_ids: stored as JSON string e.g. "[3,7,12]" or "[]" or null.
      // Return null for empty arrays — no evidence to link.
      let evidenceIds: number[] | null = null;
      if (row.evidence_ids) {
        try {
          const parsed: unknown = JSON.parse(row.evidence_ids);
          evidenceIds =
            Array.isArray(parsed) && (parsed as unknown[]).length > 0
              ? (parsed as number[])
              : null;
        } catch {
          evidenceIds = null;
        }
      }

      return {
        id: row.id,
        kind: row.kind,
        text: row.text,
        simTime: row.sim_time,
        importance: row.importance,
        sourceRef: row.source_ref ?? null,
        evidenceIds,
        // embedding and last_access intentionally omitted
      };
    });

    res.json(result);
  };
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

/**
 * Create the memories router.
 *
 * Reads the db from req.app.locals.db (set by src/server/index.ts).
 * Mount at /memories so the full path is GET /memories/:personId.
 */
export function createMemoriesRouter(): Router {
  const router = Router();

  router.get('/:personId', (req: Request, res: Response): void => {
    const db = (req.app.locals as { db?: Database.Database | null }).db;
    if (!db) {
      res.status(500).json({ error: 'Database not available.' });
      return;
    }
    const handler = buildMemoriesHandler(db);
    void handler(req, res);
  });

  return router;
}
