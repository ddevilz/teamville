/**
 * Express application factory and server entry point.
 *
 * createApp({ db }) — returns the configured Express app (for testing).
 * When run directly, opens the DB and starts listening on PORT (default 3000).
 *
 * Static files:
 *   /          → public/           (Phaser game — serves index.html automatically)
 *   /assets/*  → assets/           (tiles, sprites loaded by Phaser as /assets/...)
 *   /game/*    → public/game/      (game bundles loaded as /game/main.js etc.)
 *
 * API routes:
 *   POST /interview  → src/server/routes/interview.ts
 *   GET  /sim/state  → src/server/routes/sim.ts        (implemented in Section 5)
 *   GET  /memories/:personId → (implemented in Section 6)
 */

// Loads .env from the project root (cwd-independent) BEFORE embedder.ts locks
// its model — and gives us PROJECT_ROOT. Must be the first import.
import { PROJECT_ROOT } from '../load-env.ts';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterviewRouter } from './routes/interview.ts';
import { createSimRouter, createEventsRouter } from './routes/sim.ts';
import { createMemoriesRouter } from './routes/memories.ts';
import { createEngine } from '../sim/engine.ts';
import { openDb, getPeople, getEvents } from '../memory/db.ts';
import type Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Project root (= one level up from src/), shared with load-env.
const REPO_ROOT = PROJECT_ROOT;
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');
const ASSETS_DIR = path.join(REPO_ROOT, 'assets');

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

export interface CreateAppOptions {
  /** The opened SQLite database. May be null in tests that don't need DB. */
  db: Database.Database | null;
}

/**
 * Build and configure the Express application.
 *
 * @param options.db  Opened SQLite database instance (or null for tests)
 * @returns Configured Express application
 */
export function createApp({ db }: CreateAppOptions = { db: null }): express.Application {
  const app = express();

  // Parse JSON bodies for all API routes
  app.use(express.json());

  // Make the DB instance available to all route handlers via req.app.locals.db
  app.locals.db = db ?? null;

  // ── API routes ────────────────────────────────────────────────────────────
  app.use('/interview', createInterviewRouter());

  // GET /sim/state — engine is built once here and reused for all requests.
  // When db is null (tests that don't exercise sim), we skip mounting the route
  // so callers get a 404 rather than a runtime error from getPeople/getEvents.
  if (db !== null) {
    const events = getEvents(db);
    const simEngine = createEngine(events, getPeople(db));
    app.use('/sim', createSimRouter({ engine: simEngine }));
    app.use('/sim', createEventsRouter({ events }));
  }

  // GET /memories/:personId — Memories tab in InterviewPanel (Section 6 / Task 6.8)
  app.use('/memories', createMemoriesRouter());

  // ── Static files ──────────────────────────────────────────────────────────
  // 1. Serve public/ as the web root — GET / returns public/index.html,
  //    GET /game/main.js returns public/game/main.js, etc.
  app.use(express.static(PUBLIC_DIR));

  // 2. Serve assets/ directory under /assets so Phaser can load tiles and
  //    sprites at paths like /assets/tiles/overworld.png.
  //    Falls back gracefully if the directory doesn't exist yet.
  app.use('/assets', express.static(ASSETS_DIR));

  return app;
}

// ── Standalone entry point ────────────────────────────────────────────────────

// Detect whether this file is being run directly (node src/server/index.ts)
// vs. imported by a test. In ESM, import.meta.url gives us the file URL.
const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  // Dynamic import for dotenv keeps it out of the test bundle.
  const dotenv = await import('dotenv');
  dotenv.config();

  const DB_PATH =
    process.env['DB_PATH'] ?? path.join(REPO_ROOT, 'db', 'runtime.db');
  const PORT = parseInt(process.env['PORT'] ?? '3000', 10);

  let db: Database.Database;
  try {
    db = openDb(DB_PATH);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[server] Failed to open database at "${DB_PATH}".\n` +
        `Run "npm run ingest" or "npm run demo:reset" to create it.\n` +
        `Error: ${msg}`,
    );
    process.exit(1);
  }

  const app = createApp({ db });

  app.listen(PORT, () => {
    console.log(`Teamville listening on http://localhost:${PORT}`);
    console.log(`  DB:     ${DB_PATH}`);
    console.log(`  Static: ${PUBLIC_DIR}`);
    console.log(`  Assets: ${ASSETS_DIR}`);
  });
}
