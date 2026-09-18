-- The Postgres half of SQLite migration 061. See that file for why a job
-- exists and what it deliberately does not own.
--
-- `seq` exists because `dialect.ts` rewrites `rowid` to `seq`, and a tiebreak
-- on a column only one backend has is the easiest way to write an ORDER BY that
-- is true in one dialect and throws in the other.
CREATE TABLE IF NOT EXISTS cash_jobs (
  id                TEXT PRIMARY KEY,
  seq               BIGSERIAL,

  opportunity_id    TEXT NOT NULL REFERENCES cash_opportunities(id) ON DELETE CASCADE,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  state             TEXT NOT NULL,
  owner_user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  visibility        TEXT NOT NULL DEFAULT 'PRIVATE',

  budget_cents      BIGINT,
  currency          TEXT NOT NULL,
  note              TEXT,

  assigned_at       TEXT,
  released_at       TEXT,
  release_reason    TEXT,
  created_by        TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- At most one live job per opportunity. A released or collected job keeps its
-- row; what this forbids is two people simultaneously believing the work is
-- theirs.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_jobs_live
  ON cash_jobs (opportunity_id)
  WHERE state NOT IN ('RELEASED', 'COLLECTED');

CREATE INDEX IF NOT EXISTS idx_cash_jobs_owner ON cash_jobs (owner_user_id, state);
CREATE INDEX IF NOT EXISTS idx_cash_jobs_project ON cash_jobs (project_id, state);

CREATE TABLE IF NOT EXISTS cash_job_participants (
  job_id     TEXT NOT NULL REFERENCES cash_jobs(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by   TEXT NOT NULL,
  added_at   TEXT NOT NULL,
  PRIMARY KEY (job_id, user_id)
);
