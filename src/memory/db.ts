/**
 * SQLite access layer — thin wrappers over better-sqlite3.
 *
 * All functions are synchronous (better-sqlite3 is sync-only).
 * The caller is responsible for opening the DB with the correct path.
 *
 * Schema is frozen in db/schema.sql. This module does NOT create tables —
 * the ingest script (scripts/ingest.ts) applies schema.sql before writing.
 */

import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Row shape interfaces — columns match db/schema.sql exactly.
// ---------------------------------------------------------------------------

export interface PersonRow {
  id: string;
  name: string;
  role: string;
  persona_json: string;
  sprite: string;
  desk_x: number;
  desk_y: number;
}

export interface MemoryRow {
  id: number;
  person_id: string;
  kind: 'observation' | 'chat' | 'thought';
  text: string;
  sim_time: number;
  last_access: number;
  importance: number;
  embedding: Buffer | null;
  source_ref: string | null;
  evidence_ids: string | null;
}

export interface EventRow {
  id: number;
  sim_time: number;
  duration_min: number;
  kind: string;
  location: string;
  participants: string;
  payload: string;
}

export interface InterviewRow {
  id?: number;
  person_id: string;
  q: string;
  a: string | null;
  cited_memory_ids: string | null;
  created_at: number;
}

// ---------------------------------------------------------------------------
// Input shape for insertMemory (id is auto-assigned by SQLite)
// ---------------------------------------------------------------------------

export interface InsertMemoryInput {
  person_id: string;
  kind: 'observation' | 'chat' | 'thought';
  text: string;
  sim_time: number;
  last_access: number;
  importance: number;
  embedding: Buffer | null;
  source_ref: string | null;
  evidence_ids: string | null;
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Open (or create) a SQLite database at the given path.
 * ':memory:' is supported for tests.
 * WAL mode is enabled for better concurrent read performance.
 */
export function openDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  // WAL mode: readers don't block writers; write-ahead log is safer on crash.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

/**
 * Return all people rows, ordered by id.
 */
export function getPeople(db: Database.Database): PersonRow[] {
  return db.prepare('SELECT * FROM people ORDER BY id').all() as PersonRow[];
}

/**
 * Return all memory rows for a given person, ordered by sim_time ascending.
 * Embeddings are returned as Buffer (SQLite BLOB).
 */
export function getMemoriesForPerson(db: Database.Database, personId: string): MemoryRow[] {
  return db
    .prepare('SELECT * FROM memories WHERE person_id = ? ORDER BY sim_time ASC')
    .all(personId) as MemoryRow[];
}

/**
 * Insert a single memory row.
 * `embedding` must be a Buffer wrapping a Float32Array (4 bytes per element).
 *
 * Returns the auto-assigned rowid.
 */
export function insertMemory(db: Database.Database, mem: InsertMemoryInput): number {
  const stmt = db.prepare(`
    INSERT INTO memories
      (person_id, kind, text, sim_time, last_access, importance, embedding, source_ref, evidence_ids)
    VALUES
      (@person_id, @kind, @text, @sim_time, @last_access, @importance, @embedding, @source_ref, @evidence_ids)
  `);
  const info = stmt.run(mem as unknown as object);
  return info.lastInsertRowid as number;
}

/**
 * Return all event rows, ordered by sim_time ascending.
 */
export function getEvents(db: Database.Database): EventRow[] {
  return db.prepare('SELECT * FROM events ORDER BY sim_time ASC').all() as EventRow[];
}

/**
 * Insert a completed interview record.
 * Returns the rowid.
 */
export function insertInterview(db: Database.Database, row: Omit<InterviewRow, 'id'>): number {
  const stmt = db.prepare(`
    INSERT INTO interviews (person_id, q, a, cited_memory_ids, created_at)
    VALUES (@person_id, @q, @a, @cited_memory_ids, @created_at)
  `);
  const info = stmt.run(row as unknown as object);
  return info.lastInsertRowid as number;
}

/**
 * Upsert a key/value pair in the meta table.
 */
export function setMeta(db: Database.Database, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
}

/**
 * Retrieve a value from the meta table. Returns null if key is absent.
 */
export function getMeta(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

/**
 * Update `last_access` for a list of memory IDs to `nowSimTime`.
 * This is called by the retrieval pipeline after surfacing memories so that
 * recently-recalled items stay sticky in future retrievals (Park et al. §3.2).
 */
export function touchMemories(
  db: Database.Database,
  ids: number[],
  nowSimTime: number,
): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  db
    .prepare(`UPDATE memories SET last_access = ? WHERE id IN (${placeholders})`)
    .run(nowSimTime, ...ids);
}
