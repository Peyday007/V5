-- ---------------------------------------------------------------------------
-- THE GOAL ENGINE'S STORES: ECONOMIC RELATIONSHIPS, COMBINED SIGNALS,
-- THE POSSIBILITY STORE AND STAGE MEASUREMENTS
-- ---------------------------------------------------------------------------
--
-- Additive only: nothing existing changes meaning. Every row is scoped by
-- project, and the stores a person's goals touch also carry owner_user_id, so a
-- read is always (project, user). Nothing here holds a derived verdict: a
-- chain, a stage and a ranking are computed on the read path.

-- Typed relationships between industry nodes and activities. An endpoint is a
-- ref (an industry node id, or an activity key) with its kind stated.
CREATE TABLE IF NOT EXISTS economic_edges (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id),
  from_kind      TEXT NOT NULL CHECK (from_kind IN ('NODE', 'ACTIVITY')),
  from_ref       TEXT NOT NULL,
  to_kind        TEXT NOT NULL CHECK (to_kind IN ('NODE', 'ACTIVITY')),
  to_ref         TEXT NOT NULL,
  relation       TEXT NOT NULL CHECK (relation IN
                   ('SUPPLIES', 'BUYS_FROM', 'ENABLES', 'REQUIRES', 'COMPLEMENTS', 'COMPETES')),
  status         TEXT NOT NULL CHECK (status IN ('VERIFIED', 'ESTIMATE', 'UNKNOWN')),
  source_claim_id TEXT REFERENCES research_claims(id),
  basis          TEXT,
  operator_kind  TEXT NOT NULL CHECK (operator_kind IN
                   ('ESTABLISHED_OPERATOR', 'REPRODUCIBLE_BY_NEW_OPERATOR')),
  created_at     TEXT NOT NULL,
  CHECK (status <> 'VERIFIED' OR source_claim_id IS NOT NULL),
  CHECK (status <> 'ESTIMATE' OR (basis IS NOT NULL AND basis <> ''))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_economic_edges_identity
  ON economic_edges(project_id, from_kind, from_ref, relation, to_kind, to_ref, operator_kind);
CREATE INDEX IF NOT EXISTS idx_economic_edges_from ON economic_edges(project_id, from_ref);
CREATE INDEX IF NOT EXISTS idx_economic_edges_to ON economic_edges(project_id, to_ref);

-- Per-activity economic variables. The name is an open set; the shape is not.
-- A newer reading is a new row: the latest per (activity, name, operator_kind)
-- is the current one, and the older rows stay as history.
CREATE TABLE IF NOT EXISTS activity_variables (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id),
  activity_ref   TEXT NOT NULL,
  name           TEXT NOT NULL,
  value          REAL,
  unit           TEXT,
  status         TEXT NOT NULL CHECK (status IN ('VERIFIED', 'ESTIMATE', 'UNKNOWN')),
  source_claim_id TEXT REFERENCES research_claims(id),
  basis          TEXT,
  operator_kind  TEXT NOT NULL CHECK (operator_kind IN
                   ('ESTABLISHED_OPERATOR', 'REPRODUCIBLE_BY_NEW_OPERATOR')),
  created_at     TEXT NOT NULL,
  CHECK (status <> 'VERIFIED' OR source_claim_id IS NOT NULL),
  CHECK (status <> 'ESTIMATE' OR (basis IS NOT NULL AND basis <> '')),
  CHECK (status <> 'UNKNOWN' OR value IS NULL),
  CHECK (status = 'UNKNOWN' OR value IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_activity_variables_read
  ON activity_variables(project_id, activity_ref, name, created_at);

-- Detector outputs and trigger findings for one organisation or place, linked.
-- The label is always SIGNAL: a combination is never confirmed demand.
CREATE TABLE IF NOT EXISTS combined_signals (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  subject_kind    TEXT NOT NULL CHECK (subject_kind IN ('ORGANISATION', 'PLACE')),
  subject_key     TEXT NOT NULL,
  pattern         TEXT NOT NULL,
  member_detection_ids TEXT NOT NULL,
  industry_node_id TEXT REFERENCES industry_nodes(id),
  possible_need   TEXT,
  capture_methods TEXT NOT NULL,
  label           TEXT NOT NULL CHECK (label = 'SIGNAL'),
  created_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_combined_signals_identity
  ON combined_signals(project_id, subject_kind, subject_key, pattern);
CREATE INDEX IF NOT EXISTS idx_combined_signals_node
  ON combined_signals(project_id, industry_node_id);

-- Everything that does not fit an active goal, kept with what it needs.
CREATE TABLE IF NOT EXISTS possibilities (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id),
  owner_user_id  TEXT NOT NULL REFERENCES users(id),
  kind           TEXT NOT NULL CHECK (kind IN ('OPPORTUNITY', 'ACTIVITY', 'VENTURE')),
  title          TEXT NOT NULL,
  requirements   TEXT NOT NULL,
  source_ref     TEXT,
  parked_reason  TEXT,
  shared         INTEGER NOT NULL DEFAULT 0 CHECK (shared IN (0, 1)),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_possibilities_source
  ON possibilities(project_id, owner_user_id, source_ref) WHERE source_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_possibilities_owner ON possibilities(project_id, owner_user_id);

CREATE TABLE IF NOT EXISTS possibility_edges (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id),
  from_id        TEXT NOT NULL REFERENCES possibilities(id),
  to_id          TEXT NOT NULL REFERENCES possibilities(id),
  relation       TEXT NOT NULL CHECK (relation IN
                   ('REQUIRES', 'ENABLES', 'UNLOCKS_AFTER', 'SUPPLIES', 'COMPLEMENTS', 'CONFLICTS')),
  created_at     TEXT NOT NULL,
  CHECK (from_id <> to_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_possibility_edges_identity
  ON possibility_edges(from_id, relation, to_id);
CREATE INDEX IF NOT EXISTS idx_possibility_edges_to ON possibility_edges(to_id);

-- The conditions that would make a possibility worth another look. Looked up
-- by condition_key, never by scanning possibilities.
CREATE TABLE IF NOT EXISTS possibility_conditions (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id),
  possibility_id TEXT NOT NULL REFERENCES possibilities(id),
  condition_key  TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  triggered_at   TEXT,
  trigger_change_ref TEXT,
  CHECK ((triggered_at IS NULL) = (trigger_change_ref IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_possibility_conditions_key
  ON possibility_conditions(project_id, condition_key) WHERE triggered_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_possibility_conditions_one_live
  ON possibility_conditions(possibility_id, condition_key) WHERE triggered_at IS NULL;

-- Where the time went, per goal and stage. Appended once per reading.
CREATE TABLE IF NOT EXISTS stage_measurements (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id),
  owner_user_id  TEXT NOT NULL REFERENCES users(id),
  goal_id        TEXT NOT NULL,
  stage          TEXT NOT NULL CHECK (stage IN
                   ('CODE_SCREEN', 'TARGETED_INVESTIGATION', 'PLAN_CONSTRUCTION',
                    'DEEP_REASONING', 'EXECUTION')),
  duration_ms    INTEGER NOT NULL CHECK (duration_ms >= 0),
  screened       INTEGER NOT NULL DEFAULT 0 CHECK (screened >= 0),
  rejected       INTEGER NOT NULL DEFAULT 0 CHECK (rejected >= 0),
  advanced       INTEGER NOT NULL DEFAULT 0 CHECK (advanced >= 0),
  research_jobs  INTEGER NOT NULL DEFAULT 0 CHECK (research_jobs >= 0),
  premium_ai_jobs INTEGER NOT NULL DEFAULT 0 CHECK (premium_ai_jobs >= 0),
  note           TEXT,
  measured_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stage_measurements_goal
  ON stage_measurements(project_id, owner_user_id, goal_id, stage, measured_at);
