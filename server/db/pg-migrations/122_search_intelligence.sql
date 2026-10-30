-- ---------------------------------------------------------------------------
-- SEARCH INTELLIGENCE: WHAT EXISTS, HOW TO FIND IT, AND WHAT EARNED TRUST
-- ---------------------------------------------------------------------------
--
-- Additive only. Five tables:
--   learned_subjects    a subject Brain discovered, kept as a future search lens
--   search_methods      a reusable way of finding real examples of something
--   search_method_runs  one execution of a method, with measured results
--   learned_detectors   a repeatable method as data, SHADOW before ACTIVE
--   detector_examples   labelled items a learned detector was measured against
--
-- `scope` says who may read a row: PROJECT (project_id), USER (owner_user_id)
-- or GENERAL (shared). Trust is earned from measured runs and never declared.
-- Rows are never deleted: a method is RETIRED or DEMOTED, with its history.
CREATE TABLE learned_subjects (
  id             TEXT PRIMARY KEY,
  scope          TEXT NOT NULL CHECK (scope IN ('PROJECT', 'USER', 'GENERAL')),
  project_id     TEXT,
  owner_user_id  TEXT,
  scope_key      TEXT NOT NULL,
  subject_key    TEXT NOT NULL,
  label          TEXT NOT NULL,
  description    TEXT,
  origin         TEXT NOT NULL,
  source_ref     TEXT,
  state          TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'RETIRED')),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (scope_key, subject_key)
);
CREATE INDEX idx_learned_subjects_project ON learned_subjects (project_id, state);

CREATE TABLE search_methods (
  id               TEXT PRIMARY KEY,
  scope            TEXT NOT NULL CHECK (scope IN ('PROJECT', 'USER', 'GENERAL')),
  project_id       TEXT,
  owner_user_id    TEXT,
  subject_id       TEXT,
  name             TEXT NOT NULL,
  finds            TEXT NOT NULL,
  useful_when      TEXT,
  sources          TEXT NOT NULL,
  required_inputs  TEXT NOT NULL,
  query_filter     TEXT,
  check_procedure  TEXT,
  observed_limits  TEXT NOT NULL,
  trust_state      TEXT NOT NULL DEFAULT 'PROPOSED'
                   CHECK (trust_state IN ('PROPOSED', 'TESTING', 'PROVEN', 'DEMOTED', 'RETIRED')),
  trust_reason     TEXT,
  trust_changed_at TEXT,
  version          INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_search_methods_scope ON search_methods (scope, project_id, trust_state);

CREATE TABLE search_method_runs (
  id               TEXT PRIMARY KEY,
  method_id        TEXT NOT NULL,
  method_version   INTEGER NOT NULL,
  executor         TEXT NOT NULL CHECK (executor IN ('CODE', 'CHEAP_LANE', 'CLAUDE')),
  started_at       TEXT NOT NULL,
  finished_at      TEXT,
  items_examined   INTEGER NOT NULL DEFAULT 0,
  items_found      INTEGER NOT NULL DEFAULT 0,
  items_accepted   INTEGER NOT NULL DEFAULT 0,
  false_positives  INTEGER NOT NULL DEFAULT 0,
  outcome          TEXT NOT NULL DEFAULT 'RUNNING'
                   CHECK (outcome IN ('RUNNING', 'FOUND', 'NOTHING_SUITABLE',
                                      'SOURCE_UNAVAILABLE', 'TOO_MANY_FALSE_POSITIVES', 'ERROR')),
  failure_note     TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX idx_search_method_runs_method ON search_method_runs (method_id, started_at);

CREATE TABLE learned_detectors (
  id            TEXT PRIMARY KEY,
  method_id     TEXT,
  scope         TEXT NOT NULL CHECK (scope IN ('PROJECT', 'USER', 'GENERAL')),
  project_id    TEXT,
  owner_user_id TEXT,
  rule_key      TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  definition    TEXT NOT NULL,
  mode          TEXT NOT NULL DEFAULT 'SHADOW' CHECK (mode IN ('SHADOW', 'ACTIVE', 'DEMOTED')),
  threshold     DOUBLE PRECISION NOT NULL DEFAULT 0.9,
  mode_reason   TEXT,
  mode_changed_at TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (rule_key, version)
);
CREATE INDEX idx_learned_detectors_mode ON learned_detectors (mode, scope, project_id);

CREATE TABLE detector_examples (
  id           TEXT PRIMARY KEY,
  detector_id  TEXT NOT NULL,
  item_ref     TEXT NOT NULL,
  label        TEXT NOT NULL CHECK (label IN ('POSITIVE', 'NEGATIVE')),
  predicted    INTEGER NOT NULL,
  labelled_by  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  UNIQUE (detector_id, item_ref)
);
CREATE INDEX idx_detector_examples_detector ON detector_examples (detector_id);
