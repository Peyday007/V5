-- The Postgres half of migration 034. See that file for why.
CREATE TABLE bin_session_refusals (
  bin_id       TEXT NOT NULL REFERENCES bins(id),
  session_ref  TEXT NOT NULL,
  first_at     TEXT NOT NULL,
  last_at      TEXT NOT NULL,
  refusals     INTEGER NOT NULL DEFAULT 1,
  retry_at     TEXT NOT NULL,
  reason       TEXT NOT NULL,
  PRIMARY KEY (bin_id, session_ref)
);

CREATE INDEX IF NOT EXISTS idx_bin_session_refusals_retry
  ON bin_session_refusals (bin_id, retry_at);

ALTER TABLE bins ADD COLUMN dispatch_not_before TEXT NULL;
