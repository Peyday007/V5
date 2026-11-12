-- ---------------------------------------------------------------------------
-- INDUSTRY CONSTRUCTION: WHAT OPERATING TAUGHT (§92)
--
-- An industry construction prices every business it constructs from facts —
-- published figures, assumptions, and what this operation itself observed:
-- the price a buyer quoted, the rate an operator accepted, the payment terms a
-- contract set, a measured conversion, an unexpected cost. The first two kinds
-- come from the industry map and reference evidence; this table holds the
-- third, recorded by a person against one goal.
--
-- Append-only. A newer fact never overwrites an older one (invariant 17): the
-- construction resolves the strongest and keeps the rest as history, so a
-- quoted price that replaced an assumption still shows what was assumed.
-- ---------------------------------------------------------------------------
CREATE TABLE construction_facts (
  id            TEXT PRIMARY KEY,
  project_id    TEXT REFERENCES projects(id),
  workstream_id TEXT NOT NULL REFERENCES workstreams(id),
  fact_key      TEXT NOT NULL,
  segment       TEXT,
  low           DOUBLE PRECISION NOT NULL,
  high          DOUBLE PRECISION NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('OBSERVED', 'VERIFIED', 'ESTIMATE', 'ASSUMPTION')),
  measures      TEXT NOT NULL,
  source_title  TEXT NOT NULL,
  source_url    TEXT,
  recorded_by   TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE INDEX idx_construction_facts_goal ON construction_facts (workstream_id, created_at);
