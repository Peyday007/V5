-- ---------------------------------------------------------------------------
-- THE GOAL ENGINE'S MEMORY
--
-- How money is made (edges and variables), what several detectors said about
-- one organisation or place (combined signals), everything that did not fit an
-- active goal but is worth keeping (possibilities), and where the time went
-- (stage measurements). Additive only: nothing here alters an existing table.
--
-- Status vocabulary, used by edges and variables alike:
--   VERIFIED  a sourced claim states it (source_claim_id is required)
--   ESTIMATE  Brain or a person proposes it and states the basis
--   UNKNOWN   nobody has established it; an unknown is never a favourable value
--
-- `owner_user_id` NULL on an edge, variable or signal means general public
-- knowledge shared inside the project (the shared_findings boundary). Private
-- rows carry their owner and are never read for anybody else.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS economic_edges (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id),
  owner_user_id  TEXT REFERENCES users(id),
  from_kind      TEXT NOT NULL CHECK (from_kind IN ('NODE', 'ACTIVITY')),
  from_id        TEXT NOT NULL,
  to_kind        TEXT NOT NULL CHECK (to_kind IN ('NODE', 'ACTIVITY')),
  to_id          TEXT NOT NULL,
  relation       TEXT NOT NULL CHECK (relation IN
                   ('SUPPLIES', 'BUYS_FROM', 'ENABLES', 'REQUIRES', 'COMPLEMENTS', 'COMPETES')),
  status         TEXT NOT NULL CHECK (status IN ('VERIFIED', 'ESTIMATE', 'UNKNOWN')),
  source_claim_id TEXT,
  basis          TEXT,
  operator_kind  TEXT CHECK (operator_kind IN ('ESTABLISHED_OPERATOR', 'REPRODUCIBLE_BY_NEW_OPERATOR')),
  created_at     TEXT NOT NULL,
  retired_at     TEXT,
  CHECK (status <> 'VERIFIED' OR source_claim_id IS NOT NULL),
  CHECK (status <> 'ESTIMATE' OR basis IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_economic_edges_unique
  ON economic_edges(project_id, from_kind, from_id, to_kind, to_id, relation);
CREATE INDEX IF NOT EXISTS idx_economic_edges_from ON economic_edges(project_id, from_id);
CREATE INDEX IF NOT EXISTS idx_economic_edges_to ON economic_edges(project_id, to_id);

-- Append-only: a new reading supersedes the current one and the old row stays.
CREATE TABLE IF NOT EXISTS activity_variables (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id),
  owner_user_id  TEXT REFERENCES users(id),
  activity_id    TEXT NOT NULL,
  name           TEXT NOT NULL,
  value_number   DOUBLE PRECISION,
  value_text     TEXT,
  unit           TEXT,
  status         TEXT NOT NULL CHECK (status IN ('VERIFIED', 'ESTIMATE', 'UNKNOWN')),
  source_claim_id TEXT,
  basis          TEXT,
  operator_kind  TEXT NOT NULL CHECK (operator_kind IN ('ESTABLISHED_OPERATOR', 'REPRODUCIBLE_BY_NEW_OPERATOR')),
  created_at     TEXT NOT NULL,
  superseded_at  TEXT,
  CHECK (status <> 'VERIFIED' OR source_claim_id IS NOT NULL),
  CHECK (status <> 'ESTIMATE' OR basis IS NOT NULL),
  CHECK (status = 'UNKNOWN' OR value_number IS NOT NULL OR value_text IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_variables_current
  ON activity_variables(project_id, activity_id, name, operator_kind) WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_activity_variables_activity
  ON activity_variables(project_id, activity_id);

-- Several detections about one organisation or place. Always a SIGNAL, never
-- confirmed demand: the CHECK makes the label impossible to promote by a write.
CREATE TABLE IF NOT EXISTS combined_signals (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  owner_user_id   TEXT REFERENCES users(id),
  subject_kind    TEXT NOT NULL CHECK (subject_kind IN ('ORGANISATION', 'PLACE')),
  subject_key     TEXT NOT NULL,
  pattern_key     TEXT NOT NULL,
  member_detection_ids TEXT NOT NULL,
  industry_node_id TEXT REFERENCES industry_nodes(id),
  possible_need   TEXT,
  capture_methods TEXT NOT NULL,
  label           TEXT NOT NULL CHECK (label = 'SIGNAL'),
  created_at      TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_combined_signals_unique
  ON combined_signals(project_id, subject_kind, subject_key, pattern_key);
CREATE INDEX IF NOT EXISTS idx_combined_signals_node
  ON combined_signals(project_id, industry_node_id);

-- Everything useful that does not fit an active goal. Always one person's.
CREATE TABLE IF NOT EXISTS possibilities (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  owner_user_id   TEXT NOT NULL REFERENCES users(id),
  title           TEXT NOT NULL,
  requirements    TEXT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('KEPT', 'RECONSIDER', 'ADOPTED', 'RETIRED')),
  origin_ref      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_possibilities_owner ON possibilities(project_id, owner_user_id, state);

CREATE TABLE IF NOT EXISTS possibility_edges (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  owner_user_id   TEXT NOT NULL REFERENCES users(id),
  from_id         TEXT NOT NULL REFERENCES possibilities(id),
  to_id           TEXT NOT NULL REFERENCES possibilities(id),
  relation        TEXT NOT NULL CHECK (relation IN
                    ('REQUIRES', 'ENABLES', 'UNLOCKS_AFTER', 'SUPPLIES', 'COMPLEMENTS', 'CONFLICTS')),
  created_at      TEXT NOT NULL,
  CHECK (from_id <> to_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_possibility_edges_unique
  ON possibility_edges(project_id, owner_user_id, from_id, to_id, relation);
CREATE INDEX IF NOT EXISTS idx_possibility_edges_to ON possibility_edges(project_id, owner_user_id, to_id);

-- What would make a possibility worth reconsidering, by change-ref key, so a
-- change finds its possibilities by index rather than by scanning them all.
CREATE TABLE IF NOT EXISTS possibility_conditions (
  id              TEXT PRIMARY KEY,
  possibility_id  TEXT NOT NULL REFERENCES possibilities(id),
  project_id      TEXT NOT NULL REFERENCES projects(id),
  owner_user_id   TEXT NOT NULL REFERENCES users(id),
  condition_key   TEXT NOT NULL,
  detail          TEXT,
  met_at          TEXT,
  met_change_ref  TEXT,
  created_at      TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_possibility_conditions_unique
  ON possibility_conditions(possibility_id, condition_key);
CREATE INDEX IF NOT EXISTS idx_possibility_conditions_key
  ON possibility_conditions(project_id, owner_user_id, condition_key);

-- Where a goal's time and premium capacity went, by stage.
CREATE TABLE IF NOT EXISTS stage_measurements (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  owner_user_id   TEXT NOT NULL REFERENCES users(id),
  goal_id         TEXT NOT NULL,
  stage           TEXT NOT NULL CHECK (stage IN
                    ('CODE_SCREEN', 'TARGETED_INVESTIGATION', 'PLAN_CONSTRUCTION',
                     'DEEP_REASONING', 'EXECUTION')),
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  duration_ms     INTEGER,
  screened        INTEGER NOT NULL DEFAULT 0,
  rejected        INTEGER NOT NULL DEFAULT 0,
  advanced        INTEGER NOT NULL DEFAULT 0,
  research_jobs   INTEGER NOT NULL DEFAULT 0,
  premium_ai_jobs INTEGER NOT NULL DEFAULT 0,
  relevant_openings INTEGER NOT NULL DEFAULT 0,
  supported_plans INTEGER NOT NULL DEFAULT 0,
  bottleneck      TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stage_measurements_goal
  ON stage_measurements(project_id, owner_user_id, goal_id, stage);
