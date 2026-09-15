-- The Postgres half of SQLite migration 057. See that file for why.
CREATE TABLE IF NOT EXISTS cash_discovery_rounds (
  id            TEXT PRIMARY KEY,
  seq           BIGSERIAL,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  cash_mode_id  TEXT NOT NULL,

  bucket_id     TEXT NOT NULL,
  mechanism     TEXT NOT NULL,
  round         INTEGER NOT NULL CHECK (round >= 1),
  candidate_id  TEXT NOT NULL,

  state         TEXT NOT NULL CHECK (state IN ('OPEN', 'HARVESTED', 'ABANDONED')),

  opened_at     TEXT NOT NULL,
  harvested_at  TEXT,
  found         INTEGER NOT NULL DEFAULT 0,

  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_rounds_bucket
  ON cash_discovery_rounds(project_id, bucket_id, round);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_rounds_candidate
  ON cash_discovery_rounds(candidate_id);

CREATE INDEX IF NOT EXISTS idx_cash_rounds_project
  ON cash_discovery_rounds(project_id, state);
