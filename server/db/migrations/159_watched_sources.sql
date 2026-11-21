-- ---------------------------------------------------------------------------
-- WATCHED SOURCES AND THE CHANGES SEEN ON THEM (§65, invariants 17 and 32)
-- ---------------------------------------------------------------------------
--
-- A watched source is a page Brain re-reads on a schedule with a conditional
-- fetch (`services/feeds/access.ts`), because something waits on it: a blocker
-- key (`REGULATION:…`, `COST:…`) or a stated need. Its validators, the hash of
-- its normalised text and the text itself (bounded) are the position the next
-- read compares against; `fetched_at` is the source's own position, and a
-- read is applied only if it is newer than it and starts from the hash it
-- read, in the statement that applies it — a late, older read never regresses
-- a newer one, and the same read delivered twice lands once.
--
-- `source_changes` is append-only: one row per observed change of the
-- normalised text, with both hashes, both read times and a short excerpt. A
-- change is a reason to look again, never a fact: it asks for a re-read
-- through the research pipeline and the claim gate (`reread_candidate_id`),
-- and where its watch names a blocker key the reconsideration pass consumes it
-- as that key's change.
-- ---------------------------------------------------------------------------

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

-- One change per read of one source: the same read delivered twice is one row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_source_changes_read ON source_changes (watched_source_id, fetched_at);
CREATE INDEX IF NOT EXISTS idx_source_changes_project ON source_changes (project_id, created_at);
