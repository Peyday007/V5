-- The Postgres half of SQLite migration 154 (lens W, W-11/W-12): a claim's
-- measurement method, sample size, limitations, validity window and
-- invalidation condition, and the record that the condition was met.
ALTER TABLE research_claims ADD COLUMN measurement_method TEXT;
ALTER TABLE research_claims ADD COLUMN sample_size INTEGER;
ALTER TABLE research_claims ADD COLUMN limitations TEXT;
ALTER TABLE research_claims ADD COLUMN valid_until TEXT;
ALTER TABLE research_claims ADD COLUMN invalidated_by TEXT;
ALTER TABLE research_claims ADD COLUMN invalidation_met_at TEXT;
ALTER TABLE research_claims ADD COLUMN invalidation_note TEXT;
