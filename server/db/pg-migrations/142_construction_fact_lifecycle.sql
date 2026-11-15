-- ---------------------------------------------------------------------------
-- CONSTRUCTION FACTS FROM RESEARCH, WITH TIME (W-5, W-6, W-10, W-13; §92)
--
-- The Postgres half of SQLite 151. A claim-derived fact belongs to the
-- project, so `workstream_id` becomes nullable; the new columns carry the
-- map subject, the claim lineage (one fact per claim), the source kind, the
-- role a role finding is about, and when the figure was observed and stops
-- being current. Existing rows are dated by when they were recorded.
-- `industry_nodes` gains the payer and supplier a TRANSACTION_TYPE declares.
-- ---------------------------------------------------------------------------

ALTER TABLE construction_facts ALTER COLUMN workstream_id DROP NOT NULL;
ALTER TABLE construction_facts ADD COLUMN node_id TEXT REFERENCES industry_nodes(id);
ALTER TABLE construction_facts ADD COLUMN source_claim_id TEXT;
ALTER TABLE construction_facts ADD COLUMN source_kind TEXT CHECK (source_kind IS NULL OR source_kind IN ('PRIMARY', 'SECONDARY', 'OPERATOR', 'OUTCOME'));
ALTER TABLE construction_facts ADD COLUMN role_id TEXT;
ALTER TABLE construction_facts ADD COLUMN occupant TEXT;
ALTER TABLE construction_facts ADD COLUMN observed_at TEXT;
ALTER TABLE construction_facts ADD COLUMN valid_until TEXT;
ALTER TABLE construction_facts ADD CONSTRAINT construction_facts_owner_check
  CHECK (workstream_id IS NOT NULL OR (project_id IS NOT NULL AND source_claim_id IS NOT NULL));

UPDATE construction_facts SET observed_at = created_at WHERE observed_at IS NULL;

CREATE INDEX idx_construction_facts_project ON construction_facts (project_id, workstream_id, created_at);
CREATE UNIQUE INDEX idx_construction_facts_claim ON construction_facts (source_claim_id) WHERE source_claim_id IS NOT NULL;

ALTER TABLE industry_nodes ADD COLUMN payer TEXT;
ALTER TABLE industry_nodes ADD COLUMN supplier TEXT;
