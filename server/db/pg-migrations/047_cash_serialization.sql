-- The Postgres half of SQLite migration 056. See that file for why — and note
-- that this is the backend the serialization finding is actually about: plain
-- BEGIN on a pooled client is READ COMMITTED, so a ranked sum cannot see a
-- concurrent transaction's uncommitted hold.
CREATE TABLE IF NOT EXISTS cash_locks (
  project_id  TEXT NOT NULL,
  currency    TEXT NOT NULL,
  ticket      BIGINT NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (project_id, currency)
);

ALTER TABLE cash_commitments ADD COLUMN IF NOT EXISTS payload_fingerprint TEXT;
