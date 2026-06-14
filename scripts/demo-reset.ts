#!/usr/bin/env node
/**
 * Demo reset: copy db/seed.db → db/runtime.db and clear the interviews table.
 * Must complete in < 5s (S10 acceptance criterion).
 *
 * seed.db is the committed fixture produced by `npm run ingest` (read-only, never overwritten).
 * runtime.db is the live file used by `npm start` — gitignored.
 *
 * Usage:
 *   node scripts/demo-reset.ts
 *   npm run demo:reset
 *
 * Exports resetDb(seedPath, runtimePath) for testability.
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const DEFAULT_SEED    = path.join(ROOT, 'db', 'seed.db');
const DEFAULT_RUNTIME = path.join(ROOT, 'db', 'runtime.db');

export interface ResetResult {
  memoryCount: number;
  interviewsCleared: boolean;
}

/**
 * Copy seedPath → runtimePath, then wipe the interviews table and reset last_access.
 *
 * @param seedPath    - source database (read-only, never modified)
 * @param runtimePath - destination database (overwritten each call)
 * @returns { memoryCount, interviewsCleared }
 */
export function resetDb(seedPath: string = DEFAULT_SEED, runtimePath: string = DEFAULT_RUNTIME): ResetResult {
  if (!existsSync(seedPath)) {
    throw new Error(`seed.db not found at ${seedPath}. Run "npm run ingest" first.`);
  }

  // Ensure db/ directory exists (in case runtime.db lives in a non-existent dir)
  mkdirSync(path.dirname(runtimePath), { recursive: true });

  // 1. Atomic copy — seed.db is a plain SQLite file; copyFileSync is safe because
  //    seed.db is never opened with live WAL writers during reset.
  copyFileSync(seedPath, runtimePath);

  // 2. Open the copied runtime.db and reset demo state
  const db = new Database(runtimePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Clear interview history so every demo/eval run starts clean
  db.prepare('DELETE FROM interviews').run();

  // Reset last_access on all memories to sim_time (undo any warm-up from prior retrieval)
  db.prepare('UPDATE memories SET last_access = sim_time').run();

  // Report counts
  const memoryCount = (db.prepare('SELECT COUNT(*) as n FROM memories').get() as { n: number }).n;

  db.close();

  return { memoryCount, interviewsCleared: true };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('demo-reset.ts') || process.argv[1].endsWith('demo-reset.js'));

if (isMain) {
  const seedPath    = process.env['SEED_DB']    ?? DEFAULT_SEED;
  const runtimePath = process.env['RUNTIME_DB'] ?? DEFAULT_RUNTIME;

  console.log('Teamville demo reset...');
  console.log(`  seed:    ${seedPath}`);
  console.log(`  runtime: ${runtimePath}`);

  const t0 = Date.now();

  try {
    const { memoryCount, interviewsCleared } = resetDb(seedPath, runtimePath);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
    console.log(`  memories: ${memoryCount}`);
    console.log(`  interviews cleared: ${interviewsCleared}`);
    console.log(`Done in ${elapsed}s — runtime.db ready.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${msg}`);
    process.exit(1);
  }
}
