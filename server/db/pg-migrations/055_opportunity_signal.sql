-- The Postgres half of SQLite migration 064. See that file for why the bridge
-- from an accepted claim to a piece of the portfolio is a typed signal rather
-- than a string match against one lane id, and why provenance is written at
-- promotion rather than walked backwards through a mission row.
ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS opportunity_signal TEXT;

ALTER TABLE cash_opportunities ADD COLUMN IF NOT EXISTS orchestration_id TEXT;
ALTER TABLE cash_opportunities ADD COLUMN IF NOT EXISTS fragment_id TEXT;
ALTER TABLE cash_opportunities ADD COLUMN IF NOT EXISTS discovery_round_id TEXT;

ALTER TABLE cash_opportunities ADD COLUMN IF NOT EXISTS validation_orchestration_id TEXT;
ALTER TABLE cash_opportunities ADD COLUMN IF NOT EXISTS validation_state TEXT;
ALTER TABLE cash_opportunities ADD COLUMN IF NOT EXISTS validation_started_at TEXT;
ALTER TABLE cash_opportunities ADD COLUMN IF NOT EXISTS validation_settled_at TEXT;

CREATE INDEX IF NOT EXISTS idx_cash_opportunities_validation
  ON cash_opportunities(project_id, validation_state);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_opportunities_one_per_claim
  ON cash_opportunities(project_id, source_claim_id)
  WHERE source_claim_id IS NOT NULL;
