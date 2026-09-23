-- The Postgres half of SQLite migration 092. See that file for why a lesson
-- is derived rather than stored, why a prediction is written at the moment of
-- the decision, and why every correction is append-only.
--
-- Every table carries `seq BIGSERIAL`, the identity column `dialect.ts`
-- rewrites `rowid` to.

CREATE TABLE IF NOT EXISTS outcome_predictions (
  seq BIGSERIAL,
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  approach      TEXT NOT NULL,
  subject_kind  TEXT NOT NULL,
  subject_id    TEXT NOT NULL,
  attempt       INTEGER NOT NULL CHECK (attempt >= 1),
  recommendation TEXT NOT NULL,
  expected      TEXT NOT NULL,
  basis         TEXT NOT NULL,
  provenance    TEXT NOT NULL CHECK (provenance IN ('RECORDED', 'RECONSTRUCTED')),
  decision_id   TEXT,
  decided_at    TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_outcome_predictions_subject
  ON outcome_predictions(approach, subject_id, attempt);

CREATE TABLE IF NOT EXISTS outcome_records (
  seq BIGSERIAL,
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  approach        TEXT NOT NULL,
  subject_kind    TEXT NOT NULL,
  subject_id      TEXT NOT NULL,
  attempt         INTEGER NOT NULL CHECK (attempt >= 1),
  goal_kind       TEXT NOT NULL,
  success_condition TEXT NOT NULL,
  result          TEXT NOT NULL
                  CHECK (result IN ('SUCCEEDED', 'PARTIAL', 'FAILED', 'NOT_ATTEMPTED', 'ONGOING', 'UNKNOWN')),
  work_performed  INTEGER NOT NULL CHECK (work_performed IN (0, 1)),
  blocker_class   TEXT,
  explanation     TEXT NOT NULL,
  measures        TEXT NOT NULL,
  conditions      TEXT NOT NULL,
  source_refs     TEXT NOT NULL,
  prediction_id   TEXT,
  observed_at     TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_outcome_records_result
  ON outcome_records(approach, subject_id, attempt, result);

CREATE INDEX IF NOT EXISTS idx_outcome_records_project
  ON outcome_records(project_id, approach, observed_at);

CREATE TABLE IF NOT EXISTS outcome_corrections (
  seq BIGSERIAL,
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  target_kind      TEXT NOT NULL CHECK (target_kind IN ('LESSON', 'OUTCOME')),
  target_key       TEXT NOT NULL,
  action           TEXT NOT NULL CHECK (action IN ('WITHDRAW', 'REINSTATE')),
  reason           TEXT NOT NULL,
  decided_by_id    TEXT,
  authority_channel TEXT NOT NULL DEFAULT 'SHELL'
                   CHECK (authority_channel IN ('BROWSER', 'SHELL')),
  created_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_outcome_corrections_target
  ON outcome_corrections(project_id, target_kind, target_key, created_at);

CREATE TABLE IF NOT EXISTS outcome_decisions (
  seq BIGSERIAL,
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id),
  decision           TEXT NOT NULL,
  subject_id         TEXT NOT NULL,
  default_choice     TEXT NOT NULL,
  chosen             TEXT NOT NULL,
  lesson_key         TEXT NOT NULL,
  lesson_fingerprint TEXT NOT NULL,
  outcome_ids        TEXT NOT NULL,
  reason             TEXT NOT NULL,
  context            TEXT NOT NULL DEFAULT '{}',
  created_at         TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_outcome_decisions_once
  ON outcome_decisions(decision, subject_id, lesson_fingerprint, chosen);

CREATE INDEX IF NOT EXISTS idx_outcome_decisions_lesson
  ON outcome_decisions(project_id, lesson_key, created_at);

CREATE TABLE IF NOT EXISTS outcome_watches (
  seq BIGSERIAL,
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  fact            TEXT NOT NULL,
  fact_ref        TEXT NOT NULL,
  why             TEXT NOT NULL,
  last_value      TEXT,
  last_checked_at TEXT,
  created_at      TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_outcome_watches_fact
  ON outcome_watches(project_id, fact, fact_ref);

CREATE TABLE IF NOT EXISTS outcome_watch_changes (
  seq BIGSERIAL,
  id           TEXT PRIMARY KEY,
  watch_id     TEXT NOT NULL REFERENCES outcome_watches(id),
  project_id   TEXT NOT NULL REFERENCES projects(id),
  from_value   TEXT,
  to_value     TEXT NOT NULL,
  what_changed TEXT NOT NULL,
  proposal     TEXT NOT NULL,
  observed_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_outcome_watch_changes_project
  ON outcome_watch_changes(project_id, observed_at);

CREATE TABLE IF NOT EXISTS capability_decisions (
  seq BIGSERIAL,
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id),
  blocker_key       TEXT NOT NULL,
  route             TEXT NOT NULL CHECK (route IN ('IMPLEMENT', 'CONNECT_SERVICE', 'PERSON', 'DECLINE')),
  reason            TEXT NOT NULL,
  change_request_id TEXT,
  landed_at         TEXT,
  decided_by_id     TEXT,
  authority_channel TEXT NOT NULL DEFAULT 'SHELL'
                    CHECK (authority_channel IN ('BROWSER', 'SHELL')),
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_capability_decisions_key
  ON capability_decisions(project_id, blocker_key, created_at);
