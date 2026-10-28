-- ---------------------------------------------------------------------------
-- GOAL TARGETS, PLAN READINGS AND OUTCOMES
-- ---------------------------------------------------------------------------
--
-- A goal (a workstream) may carry a measurable target a person stated: which
-- figure, how much, in which currency, counted from which project's ledger,
-- and the capital and hours the plan may use. Progress is never stored: it is
-- read from `cash_money_entries` on every read, counted from `target_set_at`,
-- and a targeted goal is complete only when that reading reaches the target —
-- `SETTLED_CASH` counts settled money, never a promise, quote or invoice.
ALTER TABLE workstreams ADD COLUMN target_metric TEXT;
ALTER TABLE workstreams ADD COLUMN target_amount_cents INTEGER;
ALTER TABLE workstreams ADD COLUMN target_currency TEXT;
ALTER TABLE workstreams ADD COLUMN target_project_id TEXT;
ALTER TABLE workstreams ADD COLUMN capital_ceiling_cents INTEGER;
ALTER TABLE workstreams ADD COLUMN hours_ceiling INTEGER;
ALTER TABLE workstreams ADD COLUMN target_set_at TEXT;

-- What Brain concluded about a goal's strategies, each time the conclusion
-- changed: the scenario run it rested on, the verdict per strategy, the
-- evidence for each link of the causal chain, what is still unknown, and the
-- forecast it made. Append-only: a later reading never edits an earlier one,
-- so a forecast can be compared with what happened.
CREATE TABLE goal_plan_readings (
  id                 TEXT PRIMARY KEY,
  workstream_id      TEXT NOT NULL,
  digest             TEXT NOT NULL,
  scenario_model_id  TEXT,
  scenario_run_id    TEXT,
  verdict            TEXT NOT NULL,
  chosen_strategy    TEXT,
  strategies         TEXT NOT NULL,
  next_test          TEXT,
  forecast           TEXT,
  created_at         TEXT NOT NULL
);
CREATE INDEX idx_goal_plan_readings_goal ON goal_plan_readings (workstream_id, created_at);

-- What actually happened against a reading, recorded once per (reading, kind).
CREATE TABLE goal_outcomes (
  id              TEXT PRIMARY KEY,
  workstream_id   TEXT NOT NULL,
  reading_id      TEXT NOT NULL,
  kind            TEXT NOT NULL,
  achieved_cents  INTEGER NOT NULL,
  target_cents    INTEGER NOT NULL,
  detail          TEXT NOT NULL,
  observed_at     TEXT NOT NULL,
  UNIQUE (reading_id, kind)
);
CREATE INDEX idx_goal_outcomes_goal ON goal_outcomes (workstream_id, observed_at);
