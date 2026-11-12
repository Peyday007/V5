-- ---------------------------------------------------------------------------
-- THE OPERATOR (§106). The Postgres half of SQLite migration 146.
--
-- Brain's general operator is Hermes Agent (Nous Research, MIT), running in
-- its own private app and acting only through Brain's MCP door with a
-- short-lived worker credential Brain mints for each run. These tables are
-- Brain's record of what it did and what it learned, so the agent's memory is
-- Brain's rows rather than a file on a machine that stops when idle.
--
--   operator_runs       one row per run: when, which model, what it concluded,
--                       which tools it called. Written by the tick that starts
--                       the run and by the run's result.
--   operator_memory     the agent's current memory files (MEMORY.md, USER.md)
--                       and the skills it wrote, keyed by name. Sent with every
--                       run and replaced by what the run returns.
--   operator_learnings  append-only: a lesson the operator recorded about a
--                       goal, with the evidence it rests on, so a failure is
--                       not rediscovered on the next run.
-- ---------------------------------------------------------------------------
CREATE TABLE operator_runs (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('RUNNING', 'DONE', 'FAILED')),
  model TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  summary TEXT,
  tool_calls TEXT NOT NULL DEFAULT '[]',
  error TEXT
);

CREATE INDEX idx_operator_runs_started ON operator_runs (started_at);

CREATE TABLE operator_memory (
  name TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  run_id TEXT
);

CREATE TABLE operator_learnings (
  id TEXT PRIMARY KEY,
  goal_id TEXT,
  run_id TEXT,
  lesson TEXT NOT NULL,
  evidence TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);

CREATE INDEX idx_operator_learnings_goal ON operator_learnings (goal_id, recorded_at);
