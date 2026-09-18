-- The Postgres half of SQLite migration 065. See that file for why the signal
-- is kept on the piece rather than re-read from the claim, and why the rows
-- that already exist are reconciled on the tick rather than backfilled here.
ALTER TABLE cash_opportunities ADD COLUMN IF NOT EXISTS opportunity_signal TEXT;

ALTER TABLE cash_opportunities ADD COLUMN IF NOT EXISTS validation_rounds INTEGER;
