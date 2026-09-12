-- Step 12B — the Capability Lab.
--
-- §15 asks Brain to discover how much one Routine can safely hold, which
-- layout of work performs best, where quality starts slipping, and what fails
-- first. An experiment is the durable record of one attempt at one of those
-- questions, and three properties are what make it a record rather than a log.
--
-- **A test declares its envelope before it runs.** Scope, pressure ceiling,
-- duration, stop conditions, cleanup and rollback are written at creation and
-- are not amendable by the run. A test that could widen its own limits while
-- running is not bounded; it is a test with a preamble.
--
-- **What a result is grounded in travels with it.** Every threshold carries
-- MEASURED, INFERRED, UNKNOWN or PROVIDER_ENFORCED — the same vocabulary
-- `bin_events` already uses — so "tested safely through 500" can never be read
-- back as "maximum 500".
--
-- **An experiment cannot contaminate anything.** `project_id` is the isolated
-- testing scope, and a scope whose `purpose` is TECHNICAL is already excluded
-- from ordinary totals, maps, briefings and lists. Nothing here writes a
-- claim, a document or a knowledge row.

CREATE TABLE capability_experiments (
  id                  TEXT PRIMARY KEY,

  -- The isolated scope this runs in. Required: a test with no scope is a test
  -- that could touch live work.
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- HEALTH_CHECK | CALIBRATION | PUSH_TO_FAILURE | LAYOUT_TOURNAMENT |
  -- ONE_ROUTINE_FIT | QUALITY_UNDER_PRESSURE | FLEET_PROVIDER | RECOVERY_DRILL
  mode                TEXT NOT NULL,

  -- What is being tested, in the words a person would use.
  title               TEXT NOT NULL,

  -- The declared envelope, as JSON: ceiling, duration, stop conditions,
  -- cleanup, rollback, and the workload class. Frozen at creation.
  envelope            TEXT NOT NULL,

  -- The applicability manifest: Routine version, account, model, workload
  -- class, layout, date, authorization. A result read outside the conditions
  -- it was measured under is a result about something else.
  manifest            TEXT NOT NULL DEFAULT '{}',

  -- DECLARED | REFUSED | RUNNING | COMPLETE | FAILED | CANCELLED
  state               TEXT NOT NULL DEFAULT 'DECLARED',

  -- Why it was refused, when it was. A refusal with no reason is not a
  -- refusal, it is a silence.
  refusal_reason      TEXT,

  -- The structured result: what was tested, what happened, where degradation
  -- began, the bottleneck, the recommendation, the tradeoff, confidence,
  -- sample size, and what remains untested — each with its evidence class.
  result              TEXT,

  -- Whether the numbers in `result` came from a real run or a projection.
  -- A projection can never be read back as a measurement.
  simulated           INTEGER NOT NULL DEFAULT 0,

  -- Who declared it, and what made it stale.
  actor               TEXT NOT NULL,
  stale_reason        TEXT,

  -- The policy version this was applied as, when a finding was applied, so a
  -- rollback has a target that is a row rather than a memory.
  applied_policy_id   TEXT,
  applied_at          TEXT,
  rolled_back_at      TEXT,

  version             INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  started_at          TEXT,
  ended_at            TEXT,

  CHECK (mode IN ('HEALTH_CHECK','CALIBRATION','PUSH_TO_FAILURE','LAYOUT_TOURNAMENT',
                  'ONE_ROUTINE_FIT','QUALITY_UNDER_PRESSURE','FLEET_PROVIDER','RECOVERY_DRILL')),
  CHECK (state IN ('DECLARED','REFUSED','RUNNING','COMPLETE','FAILED','CANCELLED')),
  CHECK (simulated IN (0,1))
);

CREATE INDEX idx_capability_experiments_project
  ON capability_experiments (project_id, created_at);
CREATE INDEX idx_capability_experiments_mode
  ON capability_experiments (mode, state);
