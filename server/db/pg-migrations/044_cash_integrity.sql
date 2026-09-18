-- The Postgres half of SQLite migration 053. Same columns, same indexes, same
-- rules; see that file for why each one exists.
DROP INDEX IF EXISTS idx_cash_commitments_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_commitments_key
  ON cash_commitments(project_id, idempotency_key);

ALTER TABLE cash_commitments ADD COLUMN IF NOT EXISTS spent_cents INTEGER;

ALTER TABLE cash_money_entries ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE cash_money_entries ADD COLUMN IF NOT EXISTS payload_fingerprint TEXT;
ALTER TABLE cash_money_entries ADD COLUMN IF NOT EXISTS commitment_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_money_key
  ON cash_money_entries(project_id, idempotency_key);

ALTER TABLE cash_modes ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'USD';
