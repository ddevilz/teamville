#!/usr/bin/env node
/**
 * CLI entry point for the ingest pipeline.
 *
 * Usage:
 *   npm run ingest                        # uses db/seed.db
 *   npm run ingest -- --db path/to/db     # custom DB path
 *   DB_PATH=db/runtime.db npm run ingest  # env-var override
 *
 * Acceptance criteria (S9):
 *   - prints "6 people loaded"
 *   - prints memory count
 *   - prints total duration in seconds
 *   - completes in < 60 seconds
 */

// Loads .env from the project root (cwd-independent) BEFORE embedder.ts locks
// its model, and gives us PROJECT_ROOT. Must be the first import.
import { PROJECT_ROOT } from '../src/load-env.ts';
import path from 'node:path';

import { openDb } from '../src/memory/db.ts';
import { runIngest } from '../src/ingest/index.ts';

const DEFAULT_DB = path.join(PROJECT_ROOT, 'db', 'seed.db');

// Parse --db flag (takes precedence over DB_PATH env)
const dbFlagIdx = process.argv.indexOf('--db');
const dbPath =
  dbFlagIdx !== -1
    ? process.argv[dbFlagIdx + 1]!
    : (process.env['DB_PATH'] ?? DEFAULT_DB);

const start = Date.now();
console.log(`[ingest] Opening database: ${dbPath}`);

try {
  await runIngest({ dbPath });
} catch (err) {
  // Surface double-ingest guard and other fatal errors cleanly (no stack trace for known errors).
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[ingest] FATAL: ${msg}`);
  process.exit(1);
}

// Re-open read-only to report final counts (runIngest closes the DB).
const db = openDb(dbPath);
const memCount = (db.prepare('SELECT COUNT(*) as n FROM memories').get() as { n: number }).n;
const thoughtCount = (
  db.prepare("SELECT COUNT(*) as n FROM memories WHERE kind='thought'").get() as { n: number }
).n;
db.close();

const durationSec = ((Date.now() - start) / 1000).toFixed(1);

console.log(`[ingest] embeddings generated`);
console.log(`[ingest] ~${memCount} memories created (${thoughtCount} reflections)`);
console.log(`[ingest] Duration: ${durationSec}s`);

if (parseFloat(durationSec) >= 60) {
  console.warn('[ingest] WARNING: duration exceeded 60s target (S9 criterion)');
}
