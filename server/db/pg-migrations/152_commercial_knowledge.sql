-- ---------------------------------------------------------------------------
-- COMMERCIAL KNOWLEDGE: PUBLIC DATASETS READ INTO THE WORLD MODEL (§121)
-- ---------------------------------------------------------------------------
--
-- Brain acquires public commercial datasets itself (Census County Business
-- Patterns, Statistics of U.S. Businesses, Nonemployer Statistics, SEC XBRL
-- frames), reads them deterministically into classified facts, derives
-- per-industry economics from them, and files what a plan reads as
-- construction facts on the buyer nodes of the industry map (§92, W-5).
--
--   knowledge_sources       one dataset Brain reads: where, why, its validators
--                           and retry position. Discovery adds rows; a newer
--                           vintage supersedes an older one, which stays.
--   knowledge_acquisitions  append-only: every read and what it changed.
--   knowledge_facts         one classified figure: metric, industry (NAICS),
--                           geography, period, and whether it is a published
--                           FACT, a derived ESTIMATE, a model INFERENCE or a
--                           recorded UNKNOWN. A changed figure is a new row
--                           naming the one it supersedes (invariant 17).
--   knowledge_industries    what Brain understands about one industry: its
--                           activity, customer category, mechanisms and the
--                           GPU's interpretation, each with how it was decided.
--   knowledge_links         which industries a map node (a buyer type) is.
--   knowledge_contradictions two figures for one subject that disagree, and
--                           how the disagreement was resolved.
--   knowledge_applications  append-only: where knowledge reached a plan — a
--                           construction fact filed, a research question it
--                           answered, an assumption it replaced.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS knowledge_sources (
  id                   TEXT PRIMARY KEY,
  source_key           TEXT NOT NULL,
  family               TEXT NOT NULL,
  title                TEXT NOT NULL,
  publisher            TEXT NOT NULL,
  url                  TEXT NOT NULL,
  period               TEXT NOT NULL,
  format               TEXT NOT NULL,
  origin               TEXT NOT NULL CHECK (origin IN ('CATALOG', 'DISCOVERED')),
  discovered_from      TEXT,
  value_reason         TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (status IN ('ACTIVE', 'SUPERSEDED', 'FAILING', 'CANDIDATE')),
  etag                 TEXT,
  last_modified        TEXT,
  content_hash         TEXT,
  attempts             INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error           TEXT,
  last_attempt_at      TEXT,
  last_success_at      TEXT,
  next_due_at          TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_sources_key ON knowledge_sources (source_key);
CREATE INDEX IF NOT EXISTS idx_knowledge_sources_due ON knowledge_sources (status, next_due_at);

CREATE TABLE IF NOT EXISTS knowledge_acquisitions (
  id              TEXT PRIMARY KEY,
  source_id       TEXT NOT NULL REFERENCES knowledge_sources(id),
  started_at      TEXT NOT NULL,
  finished_at     TEXT NOT NULL,
  outcome         TEXT NOT NULL CHECK (outcome IN ('MODIFIED', 'NOT_MODIFIED', 'FAILED')),
  http_status     INTEGER,
  content_hash    TEXT,
  bytes           INTEGER NOT NULL DEFAULT 0,
  rows_read       INTEGER NOT NULL DEFAULT 0,
  facts_written   INTEGER NOT NULL DEFAULT 0,
  facts_unchanged INTEGER NOT NULL DEFAULT 0,
  error           TEXT
);

CREATE INDEX IF NOT EXISTS idx_knowledge_acquisitions_source ON knowledge_acquisitions (source_id, started_at);
CREATE INDEX IF NOT EXISTS idx_knowledge_acquisitions_time ON knowledge_acquisitions (started_at);

CREATE TABLE IF NOT EXISTS knowledge_facts (
  id              TEXT PRIMARY KEY,
  subject_key     TEXT NOT NULL,
  metric          TEXT NOT NULL,
  value           REAL NOT NULL,
  unit            TEXT NOT NULL,
  metric_class    TEXT NOT NULL,
  epistemic       TEXT NOT NULL CHECK (epistemic IN ('FACT', 'ESTIMATE', 'INFERENCE', 'UNKNOWN')),
  naics           TEXT NOT NULL,
  naics_level     INTEGER NOT NULL,
  industry_label  TEXT,
  geo_code        TEXT NOT NULL,
  geo_label       TEXT NOT NULL,
  size_class      TEXT NOT NULL,
  period          TEXT NOT NULL,
  basis           TEXT NOT NULL,
  inputs          TEXT,
  source_id       TEXT REFERENCES knowledge_sources(id),
  acquisition_id  TEXT,
  source_title    TEXT NOT NULL,
  source_url      TEXT,
  quality         TEXT NOT NULL CHECK (quality IN ('PRIMARY', 'DERIVED', 'MODEL')),
  observed_at     TEXT NOT NULL,
  valid_until     TEXT NOT NULL,
  supersedes_id   TEXT,
  created_at      TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_facts_subject ON knowledge_facts (subject_key) WHERE supersedes_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_facts_supersedes ON knowledge_facts (supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_knowledge_facts_naics ON knowledge_facts (naics, metric, geo_code);
CREATE INDEX IF NOT EXISTS idx_knowledge_facts_source ON knowledge_facts (source_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_facts_created ON knowledge_facts (created_at);

CREATE TABLE IF NOT EXISTS knowledge_industries (
  naics               TEXT PRIMARY KEY,
  label               TEXT NOT NULL,
  naics_level         INTEGER NOT NULL,
  sector              TEXT NOT NULL,
  activity            TEXT NOT NULL,
  customer_category   TEXT NOT NULL,
  mechanisms          TEXT NOT NULL,
  classified_by       TEXT NOT NULL CHECK (classified_by IN ('DETERMINISTIC', 'MODEL')),
  interpretation      TEXT,
  principles          TEXT,
  requirements        TEXT,
  unknowns            TEXT,
  interpreted_model   TEXT,
  interpreted_served_by TEXT,
  interpreted_at      TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_knowledge_industries_interpreted ON knowledge_industries (interpreted_at);

CREATE TABLE IF NOT EXISTS knowledge_links (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  node_id       TEXT NOT NULL REFERENCES industry_nodes(id),
  node_name     TEXT NOT NULL,
  naics         TEXT NOT NULL,
  method        TEXT NOT NULL CHECK (method IN ('LEXICAL', 'MODEL', 'NONE')),
  score         REAL NOT NULL,
  size_class    TEXT NOT NULL,
  geo_code      TEXT NOT NULL,
  rationale     TEXT NOT NULL,
  served_by     TEXT,
  created_at    TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_links_node ON knowledge_links (project_id, node_id);

CREATE TABLE IF NOT EXISTS knowledge_contradictions (
  id            TEXT PRIMARY KEY,
  subject       TEXT NOT NULL,
  fact_a_ref    TEXT NOT NULL,
  fact_b_ref    TEXT NOT NULL,
  a_value       REAL NOT NULL,
  b_value       REAL NOT NULL,
  relative_gap  REAL NOT NULL,
  resolution    TEXT NOT NULL CHECK (resolution IN ('PREFER_A', 'PREFER_B', 'RECONCILED', 'UNRESOLVED')),
  reason        TEXT NOT NULL,
  project_id    TEXT,
  created_at    TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_contradictions_pair ON knowledge_contradictions (fact_a_ref, fact_b_ref);

CREATE TABLE IF NOT EXISTS knowledge_applications (
  id                 TEXT PRIMARY KEY,
  kind               TEXT NOT NULL CHECK (kind IN ('CONSTRUCTION_FACT', 'ROUND_ANSWERED', 'UNCERTAINTY_RESOLVED', 'ASSUMPTION_REPLACED', 'PLAN_INPUT_CHANGED')),
  project_id         TEXT NOT NULL,
  node_id            TEXT,
  knowledge_fact_id  TEXT NOT NULL,
  target_ref         TEXT NOT NULL,
  detail             TEXT NOT NULL,
  before_text        TEXT,
  after_text         TEXT,
  created_at         TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_applications_once ON knowledge_applications (kind, target_ref, knowledge_fact_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_applications_project ON knowledge_applications (project_id, created_at);
