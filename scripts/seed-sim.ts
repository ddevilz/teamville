#!/usr/bin/env node
/**
 * Sim-only seed: populate a DB with the 6 people + 56 events from the seed
 * JSONs, WITHOUT embeddings/importance/reflection. This is enough to drive
 * GET /sim/state (which reads only people + events) for visual verification
 * of the village (scenarios S1/S2/S3) without needing Copilot auth or an
 * embedding model.
 *
 * The full interview path still requires `npm run ingest` (memories + embeddings).
 *
 * Usage:
 *   node scripts/seed-sim.ts                 # writes db/sim.db
 *   DB_PATH=db/sim.db node scripts/seed-sim.ts
 */

import path from 'node:path';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { openDb } from '../src/memory/db.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SEED_DIR = path.join(ROOT, 'data', 'seed');
const SCHEMA_PATH = path.join(ROOT, 'db', 'schema.sql');
const dbPath = process.env['DB_PATH'] ?? path.join(ROOT, 'db', 'sim.db');

interface PersonSeed {
  id: string;
  name: string;
  role: string;
  sprite?: string;
  desk_x?: number;
  desk_y?: number;
  persona?: unknown;
}
interface EventSeed {
  id: number;
  sim_time: number;
  duration_min?: number;
  kind: string;
  location: string;
  participants?: string[];
  payload?: unknown;
}

// Fresh DB each run so the sim seed is deterministic.
if (existsSync(dbPath)) rmSync(dbPath);

const db = openDb(dbPath);
db.exec(readFileSync(SCHEMA_PATH, 'utf8'));

const people = JSON.parse(readFileSync(path.join(SEED_DIR, 'people.json'), 'utf8')) as PersonSeed[];
const events = JSON.parse(readFileSync(path.join(SEED_DIR, 'events.json'), 'utf8')) as EventSeed[];

const insPerson = db.prepare(
  `INSERT INTO people (id, name, role, persona_json, sprite, desk_x, desk_y)
   VALUES (@id, @name, @role, @persona_json, @sprite, @desk_x, @desk_y)`,
);
for (const p of people) {
  insPerson.run({
    id: p.id,
    name: p.name,
    role: p.role,
    persona_json: JSON.stringify(p.persona ?? {}),
    sprite: p.sprite ?? p.id,
    desk_x: p.desk_x ?? 0,
    desk_y: p.desk_y ?? 0,
  });
}

const insEvent = db.prepare(
  `INSERT INTO events (id, sim_time, duration_min, kind, location, participants, payload)
   VALUES (@id, @sim_time, @duration_min, @kind, @location, @participants, @payload)`,
);
for (const e of events) {
  insEvent.run({
    id: e.id,
    sim_time: e.sim_time,
    duration_min: e.duration_min ?? 0,
    kind: e.kind,
    location: e.location,
    participants: JSON.stringify(e.participants ?? []),
    payload: JSON.stringify(e.payload ?? {}),
  });
}

const np = (db.prepare('SELECT COUNT(*) AS n FROM people').get() as { n: number }).n;
const ne = (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
db.close();

process.stdout.write(`[seed-sim] ${np} people, ${ne} events → ${dbPath}\n`);
process.stdout.write('[seed-sim] sim-only (no memories/embeddings). Drives /sim/state for S1/S2/S3.\n');
