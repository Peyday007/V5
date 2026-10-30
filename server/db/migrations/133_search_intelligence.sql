-- ---------------------------------------------------------------------------
-- SEARCH INTELLIGENCE: WHAT EXISTS, HOW TO FIND IT, AND WHAT HAS BEEN EARNED
-- ---------------------------------------------------------------------------
--
-- Subjects Brain learns, search methods kept as records that earn trust only
-- from measured runs, the runs themselves (with why one found nothing), and
-- detectors defined as data with the examples they were judged on. Additive.
--
-- Scope decides who may read a row: PROJECT is one project's, USER one
-- person's, GENERAL a method or public fact that may be shared. A CHECK ties
-- each scope to the key it needs, so a private row can never be stored without
-- an owner and a GENERAL row can never carry one.

CREATE TABLE learned_subjects (
  id          TEXT PRIMARY KEY,
  scope       TEXT NOT NULL CHECK (scope IN ('PROJECT', 'USER', 'GENERAL')),
  project_id  TEXT,
  user_id     TEXT,
  subject     TEXT NOT NULL,
  learned_from TEXT,
  created_at  TEXT NOT NULL,
  CHECK ((scope = 'PROJECT' AND project_id IS NOT NULL AND user_id IS NULL)
      OR (scope = 'USER' AND user_id IS NOT NULL AND project_id IS NULL)
      OR (scope = 'GENERAL' AND project_id IS NULL AND user_id IS NULL))
);
CREATE UNIQUE INDEX idx_learned_subjects_key ON learned_subjects (scope, COALESCE(project_id, ''), COALESCE(user_id, ''), subject);

CREATE TABLE search_methods (
  id               TEXT PRIMARY KEY,
  scope            TEXT NOT NULL CHECK (scope IN ('PROJECT', 'USER', 'GENERAL')),
  project_id       TEXT,
  user_id          TEXT,
  name             TEXT NOT NULL,
  finds            TEXT NOT NULL,
  useful_when      TEXT,
  sources          TEXT NOT NULL DEFAULT '[]',
  required_inputs  TEXT NOT NULL DEFAULT '[]',
  query_filter     TEXT,
  check_procedure  TEXT,
  observed_limits  TEXT,
  trust_state      TEXT NOT NULL DEFAULT 'PROPOSED' CHECK (trust_state IN ('PROPOSED', 'TESTING', 'PROVEN', 'DEMOTED', 'RETIRED')),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  CHECK ((scope = 'PROJECT' AND project_id IS NOT NULL AND user_id IS NULL)
      OR (scope = 'USER' AND user_id IS NOT NULL AND project_id IS NULL)
      OR (scope = 'GENERAL' AND project_id IS NULL AND user_id IS NULL))
);
CREATE INDEX idx_search_methods_scope ON search_methods (scope, project_id, user_id);

CREATE TABLE search_method_runs (
  id             TEXT PRIMARY KEY,
  method_id      TEXT NOT NULL REFERENCES search_methods(id),
  project_id     TEXT,
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  examined       INTEGER,
  kept           INTEGER,
  false_positives INTEGER,
  -- Three different facts that must never read as one: the source could not be
  -- reached, it was searched and nothing suitable exists, it returned too much noise.
  outcome        TEXT CHECK (outcome IS NULL OR outcome IN ('FOUND', 'NOTHING_SUITABLE', 'SOURCE_UNAVAILABLE', 'TOO_MANY_FALSE_POSITIVES')),
  failure_cause  TEXT
);
CREATE INDEX idx_search_method_runs_method ON search_method_runs (method_id, started_at);

CREATE TABLE learned_detectors (
  id          TEXT PRIMARY KEY,
  method_id   TEXT REFERENCES search_methods(id),
  scope       TEXT NOT NULL CHECK (scope IN ('PROJECT', 'USER', 'GENERAL')),
  project_id  TEXT,
  user_id     TEXT,
  definition  TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  mode        TEXT NOT NULL DEFAULT 'SHADOW' CHECK (mode IN ('SHADOW', 'ACTIVE')),
  threshold   REAL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  CHECK ((scope = 'PROJECT' AND project_id IS NOT NULL AND user_id IS NULL)
      OR (scope = 'USER' AND user_id IS NOT NULL AND project_id IS NULL)
      OR (scope = 'GENERAL' AND project_id IS NULL AND user_id IS NULL))
);

CREATE TABLE detector_examples (
  id           TEXT PRIMARY KEY,
  detector_id  TEXT NOT NULL REFERENCES learned_detectors(id),
  item_ref     TEXT NOT NULL,
  label        TEXT NOT NULL CHECK (label IN ('POSITIVE', 'NEGATIVE')),
  created_at   TEXT NOT NULL,
  UNIQUE (detector_id, item_ref)
);
