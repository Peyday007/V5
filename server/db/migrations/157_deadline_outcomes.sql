-- ---------------------------------------------------------------------------
-- DEADLINE INTELLIGENCE LEARNS FROM EVERY DEADLINE (§113)
--
-- §112 enforced a deadline but never measured one: every estimate was typed by
-- a session, and nothing compared it with what happened. These two tables are
-- the measurement `domain/deadlinePlan.ts` reads before it estimates anything.
--
--   deadline_task_outcomes  one row per finished task of a deadline-bound
--                           assignment: its kind, the minutes it was planned
--                           at, the minutes it took, whether it had to be
--                           repeated. Keyed by (deadline_ref, task_id), so a
--                           retried recording is the same row (§20).
--   deadline_reviews        one per deadline, completed or missed: the original
--                           forecast, the actual completion, blockers, avoidable
--                           waiting, allocation mistakes, verification and
--                           deployment delays, and what would have shortened it.
--                           A cause seen in two reviews is a recurring pattern
--                           the next plan is told about.
-- ---------------------------------------------------------------------------
CREATE TABLE deadline_task_outcomes (
  id            TEXT PRIMARY KEY,
  deadline_ref  TEXT NOT NULL,
  task_id       TEXT NOT NULL,
  kind          TEXT NOT NULL,
  estimate_min  REAL,
  actual_min    REAL NOT NULL CHECK (actual_min >= 0),
  failed        INTEGER NOT NULL DEFAULT 0 CHECK (failed IN (0, 1)),
  cause         TEXT,
  source        TEXT NOT NULL,
  recorded_by   TEXT NOT NULL,
  recorded_at   TEXT NOT NULL,
  UNIQUE (deadline_ref, task_id)
);

CREATE INDEX idx_deadline_task_outcomes_kind ON deadline_task_outcomes (kind, recorded_at);

CREATE TABLE deadline_reviews (
  id                   TEXT PRIMARY KEY,
  deadline_ref         TEXT NOT NULL UNIQUE,
  deadline_at          TEXT NOT NULL,
  forecast_at          TEXT,
  completed_at         TEXT,
  met                  INTEGER NOT NULL CHECK (met IN (0, 1)),
  verdict_at_accept    TEXT,
  blockers             TEXT NOT NULL DEFAULT '[]',
  avoidable_wait_min   REAL NOT NULL DEFAULT 0,
  allocation_mistakes  TEXT NOT NULL DEFAULT '[]',
  delays               TEXT NOT NULL DEFAULT '[]',
  improvements         TEXT NOT NULL DEFAULT '[]',
  causes               TEXT NOT NULL DEFAULT '[]',
  recorded_by          TEXT NOT NULL,
  recorded_at          TEXT NOT NULL
);
