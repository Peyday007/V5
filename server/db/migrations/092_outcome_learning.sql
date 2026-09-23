-- ---------------------------------------------------------------------------
-- WHAT BRAIN EXPECTED, WHAT HAPPENED, AND WHICH LATER DECISIONS THE DIFFERENCE
-- CHANGED
--
-- Brain has preserved history for a long time and learned from almost none of
-- it. `research_retrospectives`, `deal_observations` and the puzzle lessons
-- are all derived carefully and all end the same way: "shown to a reader,
-- never applied". Production made the cost of that concrete: twenty-two Cash
-- deep dives in a row ended without a single research pass, and the launcher
-- kept starting two more every six hours, because nothing it read had ever
-- heard of the twenty-two before them.
--
-- These tables are the missing path, and they are deliberately narrow.
--
-- * `outcome_predictions` is what Brain expected at the moment it decided —
--   written then, because reconstructing an expectation after the result is
--   known is how a record flatters the one who kept it.
-- * `outcome_records` is what was observed, one row per (approach, subject,
--   attempt, result). A result that changes appends a row rather than editing
--   one, so an attempt that parked on a person and later completed keeps both.
--   Each measure says which of MEASURED, ESTIMATE, WORKER_CLAIM, JUDGMENT or
--   UNKNOWN it is, because those are not the same kind of fact.
-- * `outcome_corrections` is a person saying a lesson or an observation is
--   wrong or not representative. Append-only; the latest row per target wins,
--   and withdrawing never deletes the evidence underneath.
-- * `outcome_decisions` is the trace: which decision a lesson changed, what it
--   would have done without it, what it did instead, and the outcome ids it
--   rested on. It is written only when the lesson actually changed something.
-- * `outcome_watches` / `outcome_watch_changes` recheck facts a live goal
--   depends on, and record what changed and what Brain proposes.
-- * `capability_decisions` is a person's answer to a proposal Brain derived
--   from a recurring blocker. The proposal itself is derived, never stored.
--
-- Lessons themselves are NOT stored. A stored rule is a generalization nobody
-- can see the sample behind (§45); every lesson is recomputed from these rows
-- with its sample printed beside it.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS outcome_predictions (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  approach      TEXT NOT NULL,
  subject_kind  TEXT NOT NULL,
  subject_id    TEXT NOT NULL,
  attempt       INTEGER NOT NULL CHECK (attempt >= 1),
  -- What Brain recommended and what it expected to follow, as it said it then.
  recommendation TEXT NOT NULL,
  expected      TEXT NOT NULL,
  basis         TEXT NOT NULL,
  -- RECORDED when written at the decision; RECONSTRUCTED when read back later
  -- from a row the decision left behind (a cash event). Never presented alike.
  provenance    TEXT NOT NULL CHECK (provenance IN ('RECORDED', 'RECONSTRUCTED')),
  -- The decision trace row, when a lesson shaped this recommendation.
  decision_id   TEXT,
  decided_at    TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_outcome_predictions_subject
  ON outcome_predictions(approach, subject_id, attempt);

CREATE TABLE IF NOT EXISTS outcome_records (
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
  -- Whether the approach touched the subject at all. An attempt that failed
  -- before any work is evidence about the conditions, never about the subject.
  work_performed  INTEGER NOT NULL CHECK (work_performed IN (0, 1)),
  -- Why it ended this way, as a class from a closed set, plus the words.
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
  -- The conditions the decision was made under (the serving revision, the
  -- slots held), so a later reader can tell whether they have since changed.
  context            TEXT NOT NULL DEFAULT '{}',
  created_at         TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_outcome_decisions_once
  ON outcome_decisions(decision, subject_id, lesson_fingerprint, chosen);

CREATE INDEX IF NOT EXISTS idx_outcome_decisions_lesson
  ON outcome_decisions(project_id, lesson_key, created_at);

CREATE TABLE IF NOT EXISTS outcome_watches (
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
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id),
  blocker_key       TEXT NOT NULL,
  route             TEXT NOT NULL CHECK (route IN ('IMPLEMENT', 'CONNECT_SERVICE', 'PERSON', 'DECLINE')),
  reason            TEXT NOT NULL,
  change_request_id TEXT,
  -- When the approved change became live. Verification counts the blocker's
  -- occurrences after this instant and nothing before it.
  landed_at         TEXT,
  decided_by_id     TEXT,
  authority_channel TEXT NOT NULL DEFAULT 'SHELL'
                    CHECK (authority_channel IN ('BROWSER', 'SHELL')),
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_capability_decisions_key
  ON capability_decisions(project_id, blocker_key, created_at);
