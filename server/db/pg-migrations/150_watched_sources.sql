-- The Postgres half of SQLite migration 159: watched sources (a page Brain
-- re-reads with a conditional fetch because a blocker key or need waits on it)
-- and the append-only changes seen on them. A change asks for a re-read
-- through the claim gate; it is never a fact.
CREATE TABLE IF NOT EXISTS watched_sources (
  id                     TEXT PRIMARY KEY,
  project_id             TEXT NOT NULL REFERENCES projects(id),
  url                    TEXT NOT NULL,
  reason                 TEXT NOT NULL,
  blocker_key            TEXT,
  check_interval_minutes INTEGER NOT NULL,
  etag                   TEXT,
  last_modified          TEXT,
  body_hash              TEXT,
  text_hash              TEXT,
  last_text              TEXT,
  fetched_at             TEXT,
  next_check_at          TEXT NOT NULL,
  last_error             TEXT,
  created_by             TEXT NOT NULL,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_watched_sources_url ON watched_sources (project_id, url);
CREATE INDEX IF NOT EXISTS idx_watched_sources_due ON watched_sources (project_id, next_check_at);
CREATE INDEX IF NOT EXISTS idx_watched_sources_key ON watched_sources (project_id, blocker_key) WHERE blocker_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS source_changes (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id),
  watched_source_id   TEXT NOT NULL REFERENCES watched_sources(id),
  url                 TEXT NOT NULL,
  blocker_key         TEXT,
  old_hash            TEXT NOT NULL,
  new_hash            TEXT NOT NULL,
  previous_fetched_at TEXT NOT NULL,
  fetched_at          TEXT NOT NULL,
  diff_excerpt        TEXT NOT NULL,
  reread_candidate_id TEXT,
  created_at          TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_source_changes_read ON source_changes (watched_source_id, fetched_at);
CREATE INDEX IF NOT EXISTS idx_source_changes_project ON source_changes (project_id, created_at);
