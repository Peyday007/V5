-- The Postgres half of SQLite migration 158: a claim's fact is superseded by a
-- new row naming it (`supersedes_fact_id`), never rewritten; readers resolve
-- the current fact at read time.
ALTER TABLE construction_facts ADD COLUMN supersedes_fact_id TEXT;

DROP INDEX idx_construction_facts_claim;
CREATE UNIQUE INDEX idx_construction_facts_claim ON construction_facts (source_claim_id) WHERE source_claim_id IS NOT NULL AND supersedes_fact_id IS NULL;
CREATE UNIQUE INDEX idx_construction_facts_supersedes ON construction_facts (supersedes_fact_id) WHERE supersedes_fact_id IS NOT NULL;
