-- ---------------------------------------------------------------------------
-- SEARCH INTELLIGENCE: WHAT EXISTS, HOW TO FIND IT, AND HOW MUCH TO TRUST THAT
-- ---------------------------------------------------------------------------
--
-- A subject Brain discovers is kept as a future search lens. A search method is
-- a record of how real examples of a subject were found, and its trust state
-- moves only on recorded, verified results — a PROPOSED method is never PROVEN.
-- A repeatable method may be compiled into a data-defined detector that starts
-- in SHADOW and is promoted on measured precision. Findings are scoped: PROJECT
-- and USER rows are readable only inside that project or by that user, and only
-- a GENERAL method (whose definition holds nothing private) is shared.
CREATE TABLE IF NOT EXISTS learned_subjects (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  user_id TEXT,
  scope TEXT NOT NULL CHECK (scope IN ('PROJECT', 'USER', 'GENERAL')),
  target_kind TEXT NOT NULL,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  source TEXT NOT NULL,
  discovered_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (scope, project_id, user_id, name_key)
);
CREATE INDEX IF NOT EXISTS idx_learned_subjects_project ON learned_subjects (project_id, scope);

CREATE TABLE IF NOT EXISTS search_methods (
  id TEXT PRIMARY KEY,
  subject_id TEXT REFERENCES learned_subjects(id),
  project_id TEXT REFERENCES projects(id),
  user_id TEXT,
  scope TEXT NOT NULL CHECK (scope IN ('PROJECT', 'USER', 'GENERAL')),
  name TEXT NOT NULL,
  finds TEXT NOT NULL,
  useful_when TEXT,
  sources TEXT NOT NULL DEFAULT '[]',
  required_inputs TEXT NOT NULL DEFAULT '[]',
  query_filter TEXT,
  check_procedure TEXT,
  observed_limits TEXT,
  trust_state TEXT NOT NULL DEFAULT 'PROPOSED'
    CHECK (trust_state IN ('PROPOSED', 'TESTING', 'PROVEN', 'DEMOTED', 'RETIRED')),
  paused_until TEXT,
  pause_cause TEXT CHECK (pause_cause IS NULL OR pause_cause IN
    ('SOURCE_UNAVAILABLE', 'NO_SUITABLE_RESULTS', 'HIGH_FALSE_POSITIVES', 'STALE')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_search_methods_subject ON search_methods (subject_id, trust_state);

CREATE TABLE IF NOT EXISTS search_method_runs (
  id TEXT PRIMARY KEY,
  method_id TEXT NOT NULL REFERENCES search_methods(id),
  ran_at TEXT NOT NULL,
  relevant INTEGER NOT NULL DEFAULT 0,
  verified INTEGER NOT NULL DEFAULT 0,
  duplicates INTEGER NOT NULL DEFAULT 0,
  false_positives INTEGER NOT NULL DEFAULT 0,
  search_ms INTEGER,
  ai_jobs_used INTEGER NOT NULL DEFAULT 0,
  ai_jobs_avoided INTEGER NOT NULL DEFAULT 0,
  validated_opportunities INTEGER NOT NULL DEFAULT 0,
  failure_cause TEXT CHECK (failure_cause IS NULL OR failure_cause IN
    ('SOURCE_UNAVAILABLE', 'NO_SUITABLE_RESULTS', 'HIGH_FALSE_POSITIVES', 'STALE')),
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_search_method_runs_method ON search_method_runs (method_id, ran_at);

CREATE TABLE IF NOT EXISTS learned_detectors (
  id TEXT PRIMARY KEY,
  method_id TEXT REFERENCES search_methods(id),
  name TEXT NOT NULL,
  definition TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'SHADOW' CHECK (mode IN ('SHADOW', 'ACTIVE')),
  precision_threshold DOUBLE PRECISION NOT NULL CHECK (precision_threshold > 0 AND precision_threshold <= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS detector_examples (
  id TEXT PRIMARY KEY,
  detector_id TEXT NOT NULL REFERENCES learned_detectors(id),
  feed_item_id TEXT,
  positive INTEGER NOT NULL CHECK (positive IN (0, 1)),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_detector_examples_detector ON detector_examples (detector_id);
