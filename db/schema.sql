CREATE TABLE people (
  id TEXT PRIMARY KEY,
  name TEXT,
  role TEXT,
  persona_json TEXT,
  sprite TEXT,
  desk_x INT,
  desk_y INT
);

CREATE TABLE memories (
  id INTEGER PRIMARY KEY,
  person_id TEXT REFERENCES people(id),
  kind TEXT CHECK(kind IN ('observation','chat','thought')),
  text TEXT,
  sim_time INT,
  last_access INT,
  importance INT,
  embedding BLOB,
  source_ref TEXT,
  evidence_ids TEXT
);

CREATE INDEX mem_person ON memories(person_id, sim_time);

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  sim_time INT,
  duration_min INT,
  kind TEXT,
  location TEXT,
  participants TEXT,
  payload TEXT
);

CREATE TABLE interviews (
  id INTEGER PRIMARY KEY,
  person_id TEXT,
  q TEXT,
  a TEXT,
  cited_memory_ids TEXT,
  created_at INT
);

-- Stores embedding_model used at ingest; query path asserts same model.
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
