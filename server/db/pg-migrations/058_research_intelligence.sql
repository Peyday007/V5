-- The Postgres half of SQLite migration 067. See that file for why each column
-- exists; this one differs only in `seq`, which exists because `dialect.ts`
-- rewrites `rowid` to `seq`, and a tiebreak on a column only one backend has is
-- the easiest way to write an ORDER BY that is true in one dialect and throws
-- in the other.
CREATE TABLE IF NOT EXISTS research_problem_models (
  id                    TEXT PRIMARY KEY,
  seq                   BIGSERIAL,
  orchestration_id      TEXT NOT NULL REFERENCES research_orchestrations(id) ON DELETE CASCADE,
  project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  boundary_contract_id  TEXT REFERENCES boundary_contracts(id) ON DELETE SET NULL,

  version               INTEGER NOT NULL,

  outcome_sought        TEXT NOT NULL,
  decision_supported    TEXT,
  why_it_matters        TEXT,

  stakes                TEXT NOT NULL DEFAULT 'MODERATE',
  reversibility         TEXT NOT NULL DEFAULT 'REVERSIBLE',
  consequence_if_wrong  TEXT,
  time_horizon          TEXT,

  success_criteria      TEXT NOT NULL DEFAULT '[]',
  constraints           TEXT NOT NULL DEFAULT '[]',
  preferences           TEXT NOT NULL DEFAULT '[]',
  examples              TEXT NOT NULL DEFAULT '[]',
  assumptions           TEXT NOT NULL DEFAULT '[]',
  non_goals             TEXT NOT NULL DEFAULT '[]',
  useless_if            TEXT NOT NULL DEFAULT '[]',
  authority_granted     TEXT NOT NULL DEFAULT '[]',

  derived_from          TEXT NOT NULL,
  rationale             TEXT,
  revised_from_version  INTEGER,
  revision_reason       TEXT,

  created_at            TEXT NOT NULL,

  CHECK (stakes IN ('CRITICAL','HIGH','MODERATE','LOW')),
  CHECK (reversibility IN ('REVERSIBLE','COSTLY','IRREVERSIBLE')),
  CHECK (derived_from IN ('COMPILED','CONTRACT','ASSIGNMENT','PROPOSAL','PERSON')),
  CHECK (version >= 1),
  CHECK (revised_from_version IS NULL OR revision_reason IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_problem_models_version
  ON research_problem_models (orchestration_id, version);
CREATE INDEX IF NOT EXISTS idx_problem_models_project
  ON research_problem_models (project_id, created_at);

CREATE TABLE IF NOT EXISTS research_uncertainties (
  id                    TEXT PRIMARY KEY,
  seq                   BIGSERIAL,
  orchestration_id      TEXT NOT NULL REFERENCES research_orchestrations(id) ON DELETE CASCADE,
  project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  problem_model_id      TEXT REFERENCES research_problem_models(id) ON DELETE SET NULL,

  uncertainty_key       TEXT NOT NULL,
  question              TEXT NOT NULL,
  why_it_matters        TEXT NOT NULL,

  consumer_kind         TEXT NOT NULL,
  consumer_ref          TEXT,

  current_belief        TEXT,
  belief_basis          TEXT NOT NULL DEFAULT 'UNKNOWN',

  consequence           TEXT NOT NULL DEFAULT 'MODERATE',
  reversibility         TEXT NOT NULL DEFAULT 'REVERSIBLE',
  change_rate           TEXT NOT NULL DEFAULT 'SLOW',
  uncertainty_level     INTEGER NOT NULL DEFAULT 100,

  invalidating          INTEGER NOT NULL DEFAULT 0,

  stopping_condition    TEXT NOT NULL,

  disposition           TEXT NOT NULL DEFAULT 'OPEN',
  disposition_reason    TEXT,
  resolved_by_fragment_id TEXT REFERENCES research_fragments(id) ON DELETE SET NULL,
  resolved_at           TEXT,

  depth                 TEXT NOT NULL DEFAULT 'CORROBORATED',
  depth_basis           TEXT,

  origin                TEXT NOT NULL DEFAULT 'PLAN',
  origin_ref            TEXT,
  plan_version          INTEGER NOT NULL DEFAULT 1,

  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,

  CHECK (consumer_kind IN ('DECISION','CONCLUSION','CALCULATION','FRAGMENT','REQUIREMENT')),
  CHECK (belief_basis IN ('UNKNOWN','ASSUMED','ARCHIVE','EVIDENCE','PERSON')),
  CHECK (consequence IN ('CRITICAL','HIGH','MODERATE','LOW')),
  CHECK (reversibility IN ('REVERSIBLE','COSTLY','IRREVERSIBLE')),
  CHECK (change_rate IN ('STABLE','SLOW','VOLATILE')),
  CHECK (uncertainty_level BETWEEN 0 AND 100),
  CHECK (invalidating IN (0,1)),
  CHECK (disposition IN ('OPEN','INVESTIGATING','RESOLVED','REFUTED','UNRESOLVABLE',
                         'RETIRED','DEFERRED','PERSON_ONLY')),
  CHECK (depth IN ('SINGLE_PRIMARY','CORROBORATED','CONTESTED_DEEP')),
  CHECK (origin IN ('PLAN','FINDING','CONTRADICTION','COVERAGE_GAP','ARCHIVE','PERSON')),
  CHECK (disposition IN ('OPEN','INVESTIGATING') OR disposition_reason IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_uncertainties_key
  ON research_uncertainties (orchestration_id, uncertainty_key);
CREATE INDEX IF NOT EXISTS idx_uncertainties_open
  ON research_uncertainties (orchestration_id, disposition);
CREATE INDEX IF NOT EXISTS idx_uncertainties_project
  ON research_uncertainties (project_id, created_at);

CREATE TABLE IF NOT EXISTS research_uncertainty_links (
  id                TEXT PRIMARY KEY,
  seq               BIGSERIAL,
  orchestration_id  TEXT NOT NULL REFERENCES research_orchestrations(id) ON DELETE CASCADE,
  from_key          TEXT NOT NULL,
  to_key            TEXT NOT NULL,
  kind              TEXT NOT NULL,
  reason            TEXT,
  created_at        TEXT NOT NULL,

  CHECK (kind IN ('HARD_PREREQUISITE','CONDITIONAL','EVIDENTIARY','COMPARATIVE',
                  'FOLLOW_UP','CHALLENGES')),
  CHECK (from_key <> to_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_uncertainty_links_edge
  ON research_uncertainty_links (orchestration_id, from_key, to_key, kind);
CREATE INDEX IF NOT EXISTS idx_uncertainty_links_to
  ON research_uncertainty_links (orchestration_id, to_key);

CREATE TABLE IF NOT EXISTS research_plan_revisions (
  id                TEXT PRIMARY KEY,
  seq               BIGSERIAL,
  orchestration_id  TEXT NOT NULL REFERENCES research_orchestrations(id) ON DELETE CASCADE,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version           INTEGER NOT NULL,

  reason            TEXT NOT NULL,
  summary           TEXT NOT NULL,
  decisions         TEXT NOT NULL DEFAULT '[]',
  applied           TEXT NOT NULL DEFAULT '[]',
  actor_kind        TEXT NOT NULL DEFAULT 'BRAIN',
  actor_ref         TEXT,
  created_at        TEXT NOT NULL,

  CHECK (reason IN ('INITIAL_PLAN','EVIDENCE_ARRIVED','CONTRADICTION','BRANCH_RETIRED',
                    'COVERAGE_GAP','SUFFICIENCY','PERSON')),
  CHECK (actor_kind IN ('BRAIN','PERSON','WORKER')),
  CHECK (version >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_revisions_version
  ON research_plan_revisions (orchestration_id, version);

CREATE TABLE IF NOT EXISTS research_retrospectives (
  id                TEXT PRIMARY KEY,
  seq               BIGSERIAL,
  orchestration_id  TEXT NOT NULL REFERENCES research_orchestrations(id) ON DELETE CASCADE,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  lesson_key        TEXT NOT NULL,
  scope             TEXT NOT NULL,
  abstraction       TEXT NOT NULL,
  lesson            TEXT NOT NULL,
  evidence          TEXT NOT NULL DEFAULT '[]',
  metrics           TEXT NOT NULL DEFAULT '{}',
  created_at        TEXT NOT NULL,

  CHECK (scope IN ('CAMPAIGN_CLOSED','OUTCOME_OBSERVED')),
  CHECK (abstraction IN ('CAMPAIGN','DOMAIN','GENERAL'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_retrospectives_lesson
  ON research_retrospectives (orchestration_id, lesson_key);
CREATE INDEX IF NOT EXISTS idx_retrospectives_project
  ON research_retrospectives (project_id, created_at);
