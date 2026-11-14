-- ---------------------------------------------------------------------------
-- OBJECTIVE PLAN READINGS (§101, §92, invariants 39 and 43)
--
-- A goal with no cash target (a business to build, a rate to cut, a launch)
-- is planned by `services/goals/objectivePlan.ts`: an interpretation, four or
-- more strategies from the free-lane models, an independent critique, one
-- revision, and a verdict decided by code. One row per reading.
--
-- Not `goal_plan_readings`: every reader of that table parses a cash
-- forecast, a scenario and RECOMMENDABLE strategies, and a reading of another
-- shape there would be misread by each of them.
--
-- `reading_key` is the goal's input digest and its refresh window, so a
-- restart, or two processes, reading the same goal on the same inputs write
-- one row. The model's words are the reading's content; nothing here is a
-- state change (§8).
-- ---------------------------------------------------------------------------

CREATE TABLE goal_objective_readings (
  id              TEXT PRIMARY KEY,
  workstream_id   TEXT NOT NULL,
  reading_key     TEXT NOT NULL,
  inputs_digest   TEXT NOT NULL,
  verdict         TEXT NOT NULL CHECK (verdict IN ('PLAN_READY', 'NEEDS_EVIDENCE', 'NOT_SUPPORTED', 'DEGRADED')),
  chosen_strategy TEXT,
  interpretation  TEXT NOT NULL DEFAULT '{}',
  strategies      TEXT NOT NULL DEFAULT '[]',
  critique        TEXT NOT NULL DEFAULT '[]',
  decision        TEXT NOT NULL DEFAULT '{}',
  calls           TEXT NOT NULL DEFAULT '{}',
  error           TEXT,
  created_at      TEXT NOT NULL,
  UNIQUE (workstream_id, reading_key)
);
CREATE INDEX idx_goal_objective_readings_goal ON goal_objective_readings (workstream_id, created_at);
