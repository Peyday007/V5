-- The Postgres half of migration 023. See that file for the reasoning; this
-- chain is numbered independently and the two versions do not mean the same
-- thing.
ALTER TABLE research_claims ADD COLUMN retrieval_state TEXT NOT NULL DEFAULT 'RETRIEVED';
ALTER TABLE research_fragments ADD COLUMN next_retry_at TEXT;
