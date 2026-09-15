-- The Postgres half of SQLite migration 059. See that file for why.
ALTER TABLE cash_needs ADD COLUMN IF NOT EXISTS occurrence INTEGER NOT NULL DEFAULT 1;
ALTER TABLE cash_needs ADD COLUMN IF NOT EXISTS verified_by TEXT;
ALTER TABLE cash_needs ADD COLUMN IF NOT EXISTS continuation_claimed_at TEXT;
ALTER TABLE cash_needs ADD COLUMN IF NOT EXISTS continuation_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cash_needs ADD COLUMN IF NOT EXISTS continuation_not_before TEXT;

DROP INDEX IF EXISTS idx_cash_needs_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_needs_key
  ON cash_needs(project_id, request_key, occurrence);
