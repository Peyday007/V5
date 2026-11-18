-- The Postgres half of SQLite migration 157 (§113): deadline task outcomes and deadline reviews.
CREATE TABLE deadline_task_outcomes (
  id            TEXT PRIMARY KEY,
  deadline_ref  TEXT NOT NULL,
  task_id       TEXT NOT NULL,
  kind          TEXT NOT NULL,
  estimate_min  DOUBLE PRECISION,
  actual_min    DOUBLE PRECISION NOT NULL CHECK (actual_min >= 0),
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
  avoidable_wait_min   DOUBLE PRECISION NOT NULL DEFAULT 0,
  allocation_mistakes  TEXT NOT NULL DEFAULT '[]',
  delays               TEXT NOT NULL DEFAULT '[]',
  improvements         TEXT NOT NULL DEFAULT '[]',
  causes               TEXT NOT NULL DEFAULT '[]',
  recorded_by          TEXT NOT NULL,
  recorded_at          TEXT NOT NULL
);
