-- brain:rebuild-without-foreign-keys
--
-- ---------------------------------------------------------------------------
-- CONSTRUCTION FACTS FROM RESEARCH, WITH TIME (W-5, W-6, W-10, W-13; §92)
-- ---------------------------------------------------------------------------
--
-- Until now `construction_facts` held only what a person recorded against one
-- goal, so a gated research claim stating a price, a take rate or payment
-- terms never reached the economics. A claim-derived fact belongs to the
-- project (the economy it describes is not one goal's), so `workstream_id`
-- becomes nullable — and SQLite cannot relax a NOT NULL, so the table is
-- rebuilt with every column 139 wrote, restated exactly, plus:
--
--   * `node_id`, the industry-map subject the fact was established under, so
--     a goal reads only facts about its own industry's subtree;
--   * `source_claim_id`, the lineage: one fact per claim, unique, which also
--     makes filing a claim twice a no-op;
--   * `source_kind`, PRIMARY / SECONDARY for a claim, OPERATOR / OUTCOME for a
--     person's record;
--   * `role_id` and `occupant`, for role findings (W-6) — an id no seed lists
--     is stored as given, never dropped;
--   * `observed_at` and `valid_until` (W-10): when the figure was observed and
--     when it stops being current. Existing rows are dated by when they were
--     recorded; their validity is derived from the key at read time.
--
-- A project-level fact must name its claim: nothing writes one by hand.
--
-- `industry_nodes` gains `payer` and `supplier` (W-13): a TRANSACTION_TYPE
-- finding declares who pays and who supplies, by name, and the construction
-- resolves each to a BUYER_TYPE or FULFILMENT_SOURCE sibling.
-- Nothing references construction_facts; the runner checks foreign keys
-- before committing.
-- ---------------------------------------------------------------------------

CREATE TABLE construction_facts_rebuilt (
  id              TEXT PRIMARY KEY,
  project_id      TEXT REFERENCES projects(id),
  workstream_id   TEXT REFERENCES workstreams(id),
  fact_key        TEXT NOT NULL,
  segment         TEXT,
  low             REAL NOT NULL,
  high            REAL NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('OBSERVED', 'VERIFIED', 'ESTIMATE', 'ASSUMPTION')),
  measures        TEXT NOT NULL,
  source_title    TEXT NOT NULL,
  source_url      TEXT,
  recorded_by     TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  node_id         TEXT REFERENCES industry_nodes(id),
  source_claim_id TEXT,
  source_kind     TEXT CHECK (source_kind IS NULL OR source_kind IN ('PRIMARY', 'SECONDARY', 'OPERATOR', 'OUTCOME')),
  role_id         TEXT,
  occupant        TEXT,
  observed_at     TEXT,
  valid_until     TEXT,
  CHECK (workstream_id IS NOT NULL OR (project_id IS NOT NULL AND source_claim_id IS NOT NULL))
);

INSERT INTO construction_facts_rebuilt
  (id, project_id, workstream_id, fact_key, segment, low, high, status, measures,
   source_title, source_url, recorded_by, created_at, observed_at)
SELECT id, project_id, workstream_id, fact_key, segment, low, high, status, measures,
       source_title, source_url, recorded_by, created_at, created_at
  FROM construction_facts;

DROP TABLE construction_facts;
ALTER TABLE construction_facts_rebuilt RENAME TO construction_facts;

CREATE INDEX idx_construction_facts_goal ON construction_facts (workstream_id, created_at);
CREATE INDEX idx_construction_facts_project ON construction_facts (project_id, workstream_id, created_at);
CREATE UNIQUE INDEX idx_construction_facts_claim ON construction_facts (source_claim_id) WHERE source_claim_id IS NOT NULL;

ALTER TABLE industry_nodes ADD COLUMN payer TEXT;
ALTER TABLE industry_nodes ADD COLUMN supplier TEXT;
