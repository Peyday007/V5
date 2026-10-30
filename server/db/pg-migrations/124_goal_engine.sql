-- ---------------------------------------------------------------------------
-- GOAL ENGINE: HOW MONEY IS MADE, WHAT COMBINES, AND WHAT IS KEPT FOR LATER
-- ---------------------------------------------------------------------------
--
-- Additive only. Every row belongs to a project and, when it is private, to one
-- user (`owner_user_id`); NULL means shared inside the project. Reads are
-- scoped by both, so one user's private rows never answer another's.
--
--   economic_edges      typed relationships between industry nodes and activities
--   activity_variables  open-set economic variables per activity; each VERIFIED
--                       (a sourced claim), ESTIMATE (basis stated) or UNKNOWN
--   combined_signals    detections for one organisation or place, linked; the
--                       label is always SIGNAL, never confirmed demand
--   possibilities       everything kept for later, with requirements, dependency
--                       edges and the conditions that would reopen it
--   stage_measurements  time and counts per goal and stage, as measured
CREATE TABLE economic_edges (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL,
  owner_user_id  TEXT,
  from_kind      TEXT NOT NULL CHECK (from_kind IN ('NODE', 'ACTIVITY')),
  from_ref       TEXT NOT NULL,
  relation       TEXT NOT NULL CHECK (relation IN ('SUPPLIES', 'BUYS_FROM', 'ENABLES', 'REQUIRES', 'COMPLEMENTS', 'COMPETES')),
  to_kind        TEXT NOT NULL CHECK (to_kind IN ('NODE', 'ACTIVITY')),
  to_ref         TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('VERIFIED', 'ESTIMATE', 'UNKNOWN')),
  claim_id       TEXT,
  basis          TEXT,
  operator_kind  TEXT NOT NULL CHECK (operator_kind IN ('ESTABLISHED_OPERATOR', 'REPRODUCIBLE_BY_NEW_OPERATOR')),
  created_at     TEXT NOT NULL,
  CHECK (status <> 'VERIFIED' OR claim_id IS NOT NULL),
  CHECK (status <> 'ESTIMATE' OR basis IS NOT NULL),
  UNIQUE (project_id, from_kind, from_ref, relation, to_kind, to_ref, operator_kind)
);
CREATE INDEX idx_economic_edges_from ON economic_edges (project_id, from_kind, from_ref);
CREATE INDEX idx_economic_edges_to ON economic_edges (project_id, to_kind, to_ref);

CREATE TABLE activity_variables (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL,
  owner_user_id  TEXT,
  activity_ref   TEXT NOT NULL,
  name           TEXT NOT NULL,
  value_num      DOUBLE PRECISION,
  value_text     TEXT,
  unit           TEXT,
  status         TEXT NOT NULL CHECK (status IN ('VERIFIED', 'ESTIMATE', 'UNKNOWN')),
  claim_id       TEXT,
  basis          TEXT,
  operator_kind  TEXT NOT NULL CHECK (operator_kind IN ('ESTABLISHED_OPERATOR', 'REPRODUCIBLE_BY_NEW_OPERATOR')),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  CHECK (status <> 'VERIFIED' OR claim_id IS NOT NULL),
  CHECK (status <> 'ESTIMATE' OR basis IS NOT NULL),
  CHECK (status <> 'UNKNOWN' OR (value_num IS NULL AND value_text IS NULL)),
  UNIQUE (project_id, activity_ref, name, operator_kind)
);
CREATE INDEX idx_activity_variables_activity ON activity_variables (project_id, activity_ref);

CREATE TABLE combined_signals (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL,
  owner_user_id    TEXT,
  subject_kind     TEXT NOT NULL CHECK (subject_kind IN ('ORGANISATION', 'PLACE')),
  subject_key      TEXT NOT NULL,
  combo_key        TEXT NOT NULL,
  detection_ids    TEXT NOT NULL,
  industry_node_id TEXT,
  possible_need    TEXT,
  capture_methods  TEXT NOT NULL,
  label            TEXT NOT NULL DEFAULT 'SIGNAL' CHECK (label = 'SIGNAL'),
  created_at       TEXT NOT NULL,
  UNIQUE (project_id, combo_key)
);
CREATE INDEX idx_combined_signals_subject ON combined_signals (project_id, subject_kind, subject_key);

CREATE TABLE possibilities (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL,
  owner_user_id  TEXT,
  title          TEXT NOT NULL,
  kind           TEXT NOT NULL,
  requirements   TEXT NOT NULL,
  state          TEXT NOT NULL DEFAULT 'KEPT' CHECK (state IN ('KEPT', 'RECONSIDERING', 'PURSUED', 'RETIRED')),
  source_ref     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX idx_possibilities_project ON possibilities (project_id, state);

CREATE TABLE possibility_edges (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  from_id         TEXT NOT NULL,
  to_id           TEXT NOT NULL,
  relation        TEXT NOT NULL CHECK (relation IN ('REQUIRES', 'ENABLES', 'UNLOCKS_AFTER', 'SUPPLIES', 'COMPLEMENTS', 'CONFLICTS')),
  created_at      TEXT NOT NULL,
  UNIQUE (from_id, to_id, relation)
);
CREATE INDEX idx_possibility_edges_to ON possibility_edges (to_id, relation);

-- The condition key is what a change looks up: one indexed read per change, no rescan.
CREATE TABLE possibility_conditions (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  possibility_id  TEXT NOT NULL,
  condition_key   TEXT NOT NULL,
  description     TEXT NOT NULL,
  met_change_ref  TEXT,
  met_at          TEXT,
  created_at      TEXT NOT NULL,
  UNIQUE (possibility_id, condition_key)
);
CREATE INDEX idx_possibility_conditions_key ON possibility_conditions (project_id, condition_key, met_at);

CREATE TABLE stage_measurements (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  owner_user_id   TEXT,
  goal_id         TEXT NOT NULL,
  stage           TEXT NOT NULL CHECK (stage IN ('CODE_SCREEN', 'TARGETED_INVESTIGATION', 'SIMULATION', 'DEEP_REASONING', 'EXECUTION')),
  duration_ms     INTEGER,
  screened        INTEGER,
  rejected        INTEGER,
  advanced        INTEGER,
  research_jobs   INTEGER,
  premium_jobs    INTEGER,
  note            TEXT,
  recorded_at     TEXT NOT NULL
);
CREATE INDEX idx_stage_measurements_goal ON stage_measurements (project_id, goal_id, stage, recorded_at);
