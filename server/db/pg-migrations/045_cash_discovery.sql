-- The Postgres half of SQLite migration 054. See that file for why.
ALTER TABLE cash_opportunities ADD COLUMN IF NOT EXISTS source_claim_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_opportunities_claim
  ON cash_opportunities(project_id, source_claim_id);

ALTER TABLE cash_opportunities ADD COLUMN IF NOT EXISTS discovered_by_candidate_id TEXT;
