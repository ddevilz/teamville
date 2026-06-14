/**
 * Ingest orchestrator.
 *
 * Reads data/seed/people.json + data/seed/events.json,
 * expands events into per-participant memory texts,
 * batch-embeds + batch-scores importance,
 * inserts memories into db,
 * runs reflection pass per person,
 * writes embedding_model to meta,
 * precomputes ambient bubble lines into events.payload.
 *
 * Main exports:
 *   ingestAll(db, overrides?) — core function (accepts open DB + optional overrides for testing)
 *   runIngest({ dbPath })     — thin wrapper used by scripts/ingest.ts; opens DB, applies schema, calls ingestAll
 */

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { openDb, setMeta, getMeta } from '../memory/db.ts';
import { embed, embedderName } from './embedder.ts';
import { scoreImportance, type CopilotSession } from './importance.ts';
import { reflect } from './reflector.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_DIR = path.resolve(__dirname, '../../data/seed');
const DB_PATH  = path.resolve(__dirname, '../../db/seed.db');
const SCHEMA_PATH = path.resolve(__dirname, '../../db/schema.sql');

/** Max texts per importance-scoring batch (one LLM request per call). */
const IMPORTANCE_BATCH_SIZE = 20;

// ---------------------------------------------------------------------------
// Seed data shape interfaces (what comes from JSON files)
// ---------------------------------------------------------------------------

/** A single entry in persona.relationships — supports both id-keyed and name-keyed forms. */
interface RelationshipEntry {
  /** ID of the related person (spec/test-fixture form). */
  personId?: string;
  /** Display name of the related person (real people.json form). */
  name?: string;
  description: string;
}

interface PersonSeed {
  id: string;
  name: string;
  role: string;
  sprite?: string;
  desk_x?: number;
  desk_y?: number;
  persona?: {
    relationships?: RelationshipEntry[];
    [key: string]: unknown;
  };
}

interface EventSeed {
  id: number;
  sim_time: number;
  duration_min?: number;
  kind: string;
  location: string;
  participants?: string[];
  payload?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Internal memory record type (pre-insert)
// ---------------------------------------------------------------------------

interface MemoryRecord {
  personId: string;
  text: string;
  simTime: number;
  sourceRef: string;
}

// ---------------------------------------------------------------------------
// expandEvent: expand a single event into per-participant memory text strings
// ---------------------------------------------------------------------------

/**
 * Expand a single event seed into per-participant memory text strings.
 *
 * Each participant gets a first-person observation memory.
 * meeting:   "Attended <topic> in <location> with <others>"
 * message:   the message text itself
 * doc_edit:  description or title
 * ambient:   skip — handled as event payload bubble only
 * other:     generic description or fallback
 */
export function expandEvent(
  event: EventSeed,
  peopleMap: Map<string, PersonSeed>,
): MemoryRecord[] {
  const results: MemoryRecord[] = [];
  const participants = event.participants ?? [];
  const payload = event.payload ?? {};

  if (event.kind === 'ambient') return results; // ambient → bubbles only, no memory rows

  for (const personId of participants) {
    const person = peopleMap.get(personId);
    if (!person) continue;

    let text: string;
    if (event.kind === 'meeting') {
      const topic = (payload['topic'] as string | undefined) ?? 'a team meeting';
      const others = participants
        .filter(p => p !== personId)
        .map(p => peopleMap.get(p)?.name ?? p)
        .join(', ');
      const othersStr = others ? ` with ${others}` : '';
      text = `Attended ${topic} in ${event.location}${othersStr}.`;
    } else if (event.kind === 'message') {
      text = (payload['text'] as string | undefined) ??
             (payload['topic'] as string | undefined) ??
             `Sent a message in ${event.location}.`;
    } else if (event.kind === 'doc_edit') {
      text = (payload['description'] as string | undefined) ??
             `Edited a document: ${(payload['title'] as string | undefined) ?? 'untitled'}.`;
    } else {
      // focus, retro, 1:1, etc.
      text = (payload['description'] as string | undefined) ??
             (payload['topic'] as string | undefined) ??
             `Participated in ${event.kind} at ${event.location}.`;
    }

    results.push({
      personId,
      text,
      simTime: event.sim_time,
      sourceRef: `event://${event.id}`,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// expandRelationships: expand a person's relationships into observation memories
// ---------------------------------------------------------------------------

/**
 * Expand a person's persona.relationships array into observation-kind memory records.
 *
 * Each relationship description is stored as a first-person perspective observation
 * from `person`'s point of view about the named colleague. This ensures that when
 * Priya is asked about Dana, the retrieval pipeline surfaces Priya's own relationship
 * context — not only co-attendance facts from shared events.
 *
 * Records are timestamped at SIM_START (relationship context predates the sim week).
 *
 * Supports two relationship entry shapes:
 *   { personId: string, description: string }  — spec/test-fixture form
 *   { name: string, description: string }       — real people.json form (name→id lookup)
 *
 * @param person     The person whose relationships are being expanded.
 * @param peopleMap  Map keyed by person id → PersonSeed (used for name resolution + display names).
 * @returns Array of MemoryRecord-shaped objects ready to fold into the ingest batch.
 */
export function expandRelationships(
  person: Pick<PersonSeed, 'id' | 'name' | 'persona'>,
  peopleMap: Map<string, PersonSeed>,
): MemoryRecord[] {
  const SIM_START = Date.parse('2026-06-08T09:00:00Z');
  const relationships = person?.persona?.relationships;
  if (!Array.isArray(relationships) || relationships.length === 0) return [];

  // Build a reverse name→id lookup for the "name-keyed" real-data form.
  const nameToId = new Map<string, string>();
  for (const [id, p] of peopleMap) {
    nameToId.set(p.name, id);
    // Also index by first name (e.g. "Priya" → "priya") for partial-name matching.
    const firstName = p.name.split(' ')[0];
    if (firstName) nameToId.set(firstName, id);
  }

  const results: MemoryRecord[] = [];
  for (const rel of relationships) {
    // Resolve target person: prefer explicit personId, then look up by name.
    let otherId: string | undefined;
    if (rel.personId) {
      otherId = rel.personId;
    } else if (rel.name) {
      otherId = nameToId.get(rel.name);
    }

    if (!otherId) continue; // no resolvable target
    const other = peopleMap.get(otherId);
    if (!other) continue;   // target not in peopleMap — skip gracefully

    const text = `${person.name}'s perspective on ${other.name}: ${rel.description}`;
    results.push({
      personId: person.id,
      text,
      simTime: SIM_START,
      sourceRef: `relationship://${person.id}/${otherId}`,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// precomputeBubbles: precompute ambient bubble lines for events.payload
// ---------------------------------------------------------------------------

/**
 * Precompute ambient bubble lines for each event and write into events.payload.
 * For meetings and significant events, derives 1-3 short speech bubble strings
 * from the payload topic. Pure string logic — no LLM call.
 */
export function precomputeBubbles(db: import('better-sqlite3').Database): void {
  const events = db.prepare('SELECT * FROM events').all() as Array<{
    id: number;
    kind: string;
    payload: string;
  }>;
  const update = db.prepare('UPDATE events SET payload = ? WHERE id = ?');

  for (const event of events) {
    const payload = JSON.parse(event.payload || '{}') as Record<string, unknown>;
    if (payload['bubbles']) continue; // already set

    const bubbles: string[] = [];
    const topic = (payload['topic'] as string | undefined) ?? '';

    if (event.kind === 'meeting') {
      bubbles.push(
        `"${topic.slice(0, 40)}"`,
        '"Any blockers?"',
        '"Let\'s sync after."',
      );
    } else if (event.kind === 'message' && payload['text']) {
      bubbles.push(`"${(payload['text'] as string).slice(0, 40)}..."`);
    } else if (topic) {
      bubbles.push(`"${topic.slice(0, 40)}"`);
    }

    payload['bubbles'] = bubbles;
    update.run(JSON.stringify(payload), event.id);
  }
}

// ---------------------------------------------------------------------------
// ingestOverrides: the override bag passed in tests
// ---------------------------------------------------------------------------

export interface IngestOverrides {
  /** Skip reading people.json from disk; use this data instead. */
  peopleJson?: PersonSeed[];
  /** Skip reading events.json from disk; use this data instead. */
  eventsJson?: EventSeed[];
  /**
   * Inject a pre-built CopilotSession rather than calling getCheapSession().
   * Required for tests (getCheapSession lives in a not-yet-created module in Task 2.5).
   */
  session?: CopilotSession;
  /**
   * Inject a custom embed function (defaults to the real embedder).
   * Used in tests to avoid network calls.
   */
  embedFn?: (texts: string[]) => Promise<Float32Array[]>;
}

// ---------------------------------------------------------------------------
// ingestAll — core function
// ---------------------------------------------------------------------------

/**
 * Core ingest function. Accepts an already-open db so scripts/ingest.ts
 * can pass in the real db path and tests can pass ':memory:'.
 *
 * @param db        Open better-sqlite3 database (schema must already be applied).
 * @param overrides Optional overrides for testing: inject seed data, session, embedFn.
 */
export async function ingestAll(
  db: import('better-sqlite3').Database,
  overrides: IngestOverrides = {},
): Promise<void> {
  const log = (msg: string) => process.stdout.write(`[ingest] ${msg}\n`);

  log('Loading seed data...');

  // ---------------------------------------------------------------------------
  // Load + upsert people
  // ---------------------------------------------------------------------------
  let peopleData = overrides.peopleJson;
  if (!peopleData) {
    const raw = await readFile(path.join(SEED_DIR, 'people.json'), 'utf8');
    peopleData = JSON.parse(raw) as PersonSeed[];
  }

  const upsertPerson = db.prepare(`
    INSERT OR REPLACE INTO people (id, name, role, persona_json, sprite, desk_x, desk_y)
    VALUES (@id, @name, @role, @persona_json, @sprite, @desk_x, @desk_y)
  `);
  for (const p of peopleData) {
    upsertPerson.run({
      id: p.id,
      name: p.name,
      role: p.role,
      persona_json: JSON.stringify(p.persona ?? {}),
      sprite: p.sprite ?? p.id,
      desk_x: p.desk_x ?? 0,
      desk_y: p.desk_y ?? 0,
    });
  }
  log(`${peopleData.length} people loaded`);

  const peopleMap = new Map<string, PersonSeed>(peopleData.map(p => [p.id, p]));

  // ---------------------------------------------------------------------------
  // Expand persona.relationships into observation-kind memory records (S6).
  // These are folded into the same batch as event memories so they receive
  // importance scores and embeddings in the same batched LLM/embed calls.
  // ---------------------------------------------------------------------------
  const relationshipRecords: MemoryRecord[] = [];
  for (const p of peopleData) {
    const expanded = expandRelationships(p, peopleMap);
    relationshipRecords.push(...expanded);
  }
  if (relationshipRecords.length > 0) {
    log(`${relationshipRecords.length} relationship context records queued`);
  }

  // ---------------------------------------------------------------------------
  // Load + upsert events
  // ---------------------------------------------------------------------------
  let eventsData = overrides.eventsJson;
  if (!eventsData) {
    const raw = await readFile(path.join(SEED_DIR, 'events.json'), 'utf8');
    eventsData = JSON.parse(raw) as EventSeed[];
  }

  const upsertEvent = db.prepare(`
    INSERT OR REPLACE INTO events (id, sim_time, duration_min, kind, location, participants, payload)
    VALUES (@id, @sim_time, @duration_min, @kind, @location, @participants, @payload)
  `);
  for (const e of eventsData) {
    upsertEvent.run({
      id: e.id,
      sim_time: e.sim_time,
      duration_min: e.duration_min ?? 0,
      kind: e.kind,
      location: e.location,
      participants: JSON.stringify(e.participants ?? []),
      payload: JSON.stringify(e.payload ?? {}),
    });
  }

  // ---------------------------------------------------------------------------
  // Expand events → memory records
  // Seed with relationship context records first (S6 cross-agent retrieval).
  // ---------------------------------------------------------------------------
  log('Expanding events to memory texts...');
  const memoryRecords: MemoryRecord[] = [...relationshipRecords];
  for (const event of eventsData) {
    const expanded = expandEvent(event, peopleMap);
    for (const rec of expanded) {
      memoryRecords.push(rec);
    }
  }

  // ---------------------------------------------------------------------------
  // Acquire or build CopilotSession
  // ---------------------------------------------------------------------------
  let session: CopilotSession;
  if (overrides.session) {
    session = overrides.session;
  } else {
    // Lazy import — getCheapSession lives in Task 2.5's module (src/interview/copilot.ts).
    // The path is built at runtime so tsc does not try to resolve the not-yet-created module
    // (mirrors the same pattern used in scripts/ingest.ts).
    const copilotPath = new URL('../interview/copilot.ts', import.meta.url).href;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const copilotMod: any = await import(copilotPath);
    session = (await copilotMod.getCheapSession()) as CopilotSession;
  }

  // ---------------------------------------------------------------------------
  // Batch-score importance (IMPORTANCE_BATCH_SIZE texts per LLM call)
  // ---------------------------------------------------------------------------
  log('Scoring importance (batched)...');
  const allTexts = memoryRecords.map(r => r.text);
  const allImportances: number[] = [];

  for (let i = 0; i < allTexts.length; i += IMPORTANCE_BATCH_SIZE) {
    const batch = allTexts.slice(i, i + IMPORTANCE_BATCH_SIZE);
    const scores = await scoreImportance(session, batch);
    allImportances.push(...scores);
  }

  // ---------------------------------------------------------------------------
  // Batch-embed all memory texts (single batched request)
  // ---------------------------------------------------------------------------
  log('Embedding memory texts (batched)...');
  const embedFn = overrides.embedFn ?? embed;
  // Short-circuit: if no texts, skip the embed call entirely (preserves quota and spy counts).
  const embeddings: Float32Array[] = allTexts.length > 0 ? await embedFn(allTexts) : [];
  const activeModel = embedderName();

  // ---------------------------------------------------------------------------
  // Insert memory rows (transactional batch)
  // ---------------------------------------------------------------------------
  log('Inserting memories...');
  const insertStmt = db.prepare(`
    INSERT INTO memories (person_id, kind, text, sim_time, last_access, importance, embedding, source_ref, evidence_ids)
    VALUES (@person_id, @kind, @text, @sim_time, @last_access, @importance, @embedding, @source_ref, @evidence_ids)
  `);

  type MemRow = {
    person_id: string;
    kind: string;
    text: string;
    sim_time: number;
    last_access: number;
    importance: number;
    embedding: Buffer;
    source_ref: string;
    evidence_ids: null;
  };

  const rows: MemRow[] = memoryRecords.map((rec, i) => ({
    person_id: rec.personId,
    kind: 'observation',
    text: rec.text,
    sim_time: rec.simTime,
    last_access: rec.simTime,
    importance: allImportances[i] ?? 3,
    embedding: Buffer.from(embeddings[i].buffer),
    source_ref: rec.sourceRef,
    evidence_ids: null,
  }));

  const insertMany = db.transaction((records: MemRow[]) => {
    for (const r of records) {
      insertStmt.run(r as unknown as object);
    }
  });

  insertMany(rows);
  log(`${rows.length} memories inserted`);

  // ---------------------------------------------------------------------------
  // Reflection pass — per person
  // ---------------------------------------------------------------------------
  for (const person of peopleData) {
    log(`Running reflection pass for ${person.id}...`);
    await reflect(session, db, person.id, embedFn);
  }

  // ---------------------------------------------------------------------------
  // Precompute ambient bubble text into events.payload
  // ---------------------------------------------------------------------------
  log('Precomputing ambient bubble lines...');
  precomputeBubbles(db);

  // ---------------------------------------------------------------------------
  // Write meta
  // ---------------------------------------------------------------------------
  log('Writing embedding_model to meta...');
  setMeta(db, 'embedding_model', activeModel);
  setMeta(db, 'ingest_completed_at', String(Date.now()));
  setMeta(db, 'sim_start', String(Date.parse('2026-06-08T09:00:00Z')));
  setMeta(db, 'sim_end', String(Date.parse('2026-06-12T18:00:00Z')));

  const totalRow = db.prepare('SELECT COUNT(*) as n FROM memories').get() as { n: number };
  log(`Total memories in DB: ${totalRow.n}`);
  log('Done.');
}

// ---------------------------------------------------------------------------
// runIngest — thin wrapper for scripts/ingest.ts
// ---------------------------------------------------------------------------

/**
 * Entry point called by scripts/ingest.ts.
 * Opens (or creates) the DB at dbPath, applies the schema if tables are absent,
 * then delegates to ingestAll().
 *
 * @param opts.dbPath  Path to the SQLite database file (or ':memory:' for tests).
 */
export async function runIngest(opts: { dbPath: string }): Promise<void> {
  const start = Date.now();

  process.stdout.write(`[ingest] Opening DB at ${opts.dbPath}\n`);

  const db = openDb(opts.dbPath);

  // Apply schema if not yet applied (idempotent: CREATE TABLE IF NOT EXISTS alternative
  // is to check for tables and skip; since schema.sql uses CREATE TABLE without IF NOT EXISTS
  // we use a try/catch per table approach — simplest: check meta table existence).
  const schemaApplied = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'")
    .get();

  if (!schemaApplied) {
    process.stdout.write('[ingest] Applying schema...\n');
    const schema = await readFile(SCHEMA_PATH, 'utf8');
    db.exec(schema);
  }

  // Guard against double-ingest: memories have no uniqueness constraint, so a
  // second run would silently duplicate every memory row.
  const existing = db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number };
  if (existing.n > 0) {
    db.close();
    throw new Error(
      `[ingest] DB at ${opts.dbPath} already contains ${existing.n} memories. ` +
      'Re-running would duplicate them. Run npm run db:reset first (or delete the file).'
    );
  }

  await ingestAll(db, {});

  const duration = ((Date.now() - start) / 1000).toFixed(1);
  process.stdout.write(`[ingest] Done. Duration: ${duration}s\n`);

  db.close();
}
