-- ---------------------------------------------------------------------------
-- SEARCH INTELLIGENCE: WHAT EXISTS, HOW TO FIND IT, AND WHAT EARNED TRUST
-- ---------------------------------------------------------------------------
--
-- Additive only. A subject Brain discovers is kept as a row (`learned_subjects`)
-- so it can become a future search lens; a way of searching is a record
-- (`search_methods`) whose trust state moves only on measured runs
-- (`search_method_runs`); a repeatable method may be compiled into data
-- (`learned_detectors`) that starts in SHADOW and is promoted or demoted from
-- measured precision (`detector_examples`). Nothing here is deleted.
--
-- `scope` is PROJECT, USER or GENERAL. A PROJECT row names its project and a
-- USER row names its user; a GENERAL row names neither and carries no private
-- fact. Reads are filtered by scope in the repository.
CREATE TABLE learned_subjects (
  id            TEXT PRIMARY KEY,
  scope         TEXT NOT NULL CHECK (scope IN ('PROJECT', 'USER', 'GENERAL')),
  project_id    TEXT,
  user_id       TEXT,
  subject_key   TEXT NOT NULL,
  label         TEXT NOT NULL,
  description   TEXT,
  origin        TEXT NOT NULL,
  source_ref    TEXT,
  state         TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'RETIRED')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  CHECK ((scope = 'PROJECT' AND project_id IS NOT NULL)
      OR (scope = 'USER' AND user_id IS NOT NULL)
      OR (scope = 'GENERAL' AND project_id IS NULL AND user_id IS NULL))
);
CREATE UNIQUE INDEX idx_learned_subjects_key
  ON learned_subjects (scope, COALESCE(project_id, ''), COALESCE(user_id, ''), subject_key);

CREATE TABLE search_methods (
  id              TEXT PRIMARY KEY,
  scope           TEXT NOT NULL CHECK (scope IN ('PROJECT', 'USER', 'GENERAL')),
  project_id      TEXT,
  user_id         TEXT,
  method_key      TEXT NOT NULL,
  subject_id      TEXT,
  finds           TEXT NOT NULL,
  useful_when     TEXT,
  sources         TEXT NOT NULL,
  required_inputs TEXT NOT NULL,
  query           TEXT,
  check_procedure TEXT NOT NULL,
  limits          TEXT,
  trust_state     TEXT NOT NULL DEFAULT 'PROPOSED'
                  CHECK (trust_state IN ('PROPOSED', 'TESTING', 'PROVEN', 'DEMOTED', 'RETIRED')),
  trust_reason    TEXT,
  version         INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  CHECK ((scope = 'PROJECT' AND project_id IS NOT NULL)
      OR (scope = 'USER' AND user_id IS NOT NULL)
      OR (scope = 'GENERAL' AND project_id IS NULL AND user_id IS NULL))
);
CREATE UNIQUE INDEX idx_search_methods_key
  ON search_methods (scope, COALESCE(project_id, ''), COALESCE(user_id, ''), method_key, version);
CREATE INDEX idx_search_methods_trust ON search_methods (trust_state, updated_at);

-- One row per execution of a method. `outcome` separates a source that could
-- not be read from a search that found nothing suitable from one that found
-- too many false positives; `executor` says whether code, the cheap lane or
-- Claude ran it.
CREATE TABLE search_method_runs (
  id               TEXT PRIMARY KEY,
  method_id        TEXT NOT NULL,
  executor         TEXT NOT NULL CHECK (executor IN ('CODE', 'CHEAP_LANE', 'CLAUDE')),
  outcome          TEXT NOT NULL CHECK (outcome IN
                   ('FOUND', 'NOTHING_SUITABLE', 'SOURCE_UNAVAILABLE', 'FALSE_POSITIVES', 'ERROR')),
  failure_cause    TEXT,
  examined         INTEGER NOT NULL DEFAULT 0,
  surfaced         INTEGER NOT NULL DEFAULT 0,
  confirmed        INTEGER NOT NULL DEFAULT 0,
  rejected         INTEGER NOT NULL DEFAULT 0,
  started_at       TEXT NOT NULL,
  finished_at      TEXT NOT NULL
);
CREATE INDEX idx_search_method_runs_method ON search_method_runs (method_id, finished_at);

CREATE TABLE learned_detectors (
  id               TEXT PRIMARY KEY,
  scope            TEXT NOT NULL CHECK (scope IN ('PROJECT', 'USER', 'GENERAL')),
  project_id       TEXT,
  user_id          TEXT,
  method_id        TEXT,
  detector_key     TEXT NOT NULL,
  version          INTEGER NOT NULL DEFAULT 1,
  definition       TEXT NOT NULL,
  mode             TEXT NOT NULL DEFAULT 'SHADOW' CHECK (mode IN ('SHADOW', 'ACTIVE')),
  threshold        DOUBLE PRECISION NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  CHECK ((scope = 'PROJECT' AND project_id IS NOT NULL)
      OR (scope = 'USER' AND user_id IS NOT NULL)
      OR (scope = 'GENERAL' AND project_id IS NULL AND user_id IS NULL))
);
CREATE UNIQUE INDEX idx_learned_detectors_key
  ON learned_detectors (scope, COALESCE(project_id, ''), COALESCE(user_id, ''), detector_key, version);

-- A labelled example a detector fired on: whether a reader confirmed it.
-- Precision is read from these rows and stored nowhere.
CREATE TABLE detector_examples (
  id           TEXT PRIMARY KEY,
  detector_id  TEXT NOT NULL,
  item_ref     TEXT NOT NULL,
  fired        INTEGER NOT NULL,
  verdict      TEXT NOT NULL CHECK (verdict IN ('CONFIRMED', 'REJECTED')),
  labelled_by  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  UNIQUE (detector_id, item_ref)
);
