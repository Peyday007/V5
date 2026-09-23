-- The Postgres half of SQLite migration 090. See that file for why nothing
-- derivable is stored, why a possibility is enumerated or evidenced and never
-- invented, why a rank snapshot is an observation rather than a cache, and why
-- nothing in this ledger is ever deleted.
--
-- Every table here carries `seq BIGSERIAL`, which is the identity column
-- `dialect.ts` rewrites `rowid` to. §25 and §27 both record what its absence
-- costs: a tiebreak on a column only one dialect has passes the whole SQLite
-- suite and throws in production.

CREATE TABLE IF NOT EXISTS monetization_paths (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id),
  opportunity_id    TEXT REFERENCES cash_opportunities(id),
  industry_node_id  TEXT REFERENCES industry_nodes(id),
  method            TEXT NOT NULL,
  title             TEXT NOT NULL,
  thesis            TEXT,
  origin            TEXT NOT NULL,
  source_claim_id   TEXT REFERENCES research_claims(id),
  merged_into_id    TEXT REFERENCES monetization_paths(id),
  split_from_id     TEXT REFERENCES monetization_paths(id),
  last_evaluated_at TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  seq               BIGSERIAL,
  CHECK (origin IN ('SEED', 'ENUMERATED', 'EVIDENCED')),
  CHECK ((opportunity_id IS NULL) <> (industry_node_id IS NULL)),
  CHECK (origin <> 'EVIDENCED' OR source_claim_id IS NOT NULL),
  CHECK (merged_into_id IS NULL OR merged_into_id <> id),
  CHECK (split_from_id IS NULL OR split_from_id <> id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_monetization_paths_subject
  ON monetization_paths(project_id, COALESCE(opportunity_id, '-'),
                        COALESCE(industry_node_id, '-'), method);

CREATE INDEX IF NOT EXISTS idx_monetization_paths_project
  ON monetization_paths(project_id);

CREATE INDEX IF NOT EXISTS idx_monetization_paths_opportunity
  ON monetization_paths(opportunity_id);

CREATE INDEX IF NOT EXISTS idx_monetization_paths_node
  ON monetization_paths(industry_node_id);


CREATE TABLE IF NOT EXISTS monetization_path_facts (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  path_id       TEXT NOT NULL REFERENCES monetization_paths(id),
  attribute     TEXT NOT NULL,
  kind          TEXT NOT NULL,
  value         TEXT NOT NULL,
  amount_cents  INTEGER,
  days          INTEGER,
  claim_id      TEXT REFERENCES research_claims(id),
  basis         TEXT,
  assumptions   TEXT,
  uncertainty   TEXT,
  decided_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  seq           BIGSERIAL,
  CHECK (kind IN ('EVIDENCE', 'RECOMMENDATION', 'PERSON')),
  CHECK (amount_cents IS NULL OR amount_cents >= 0),
  CHECK (days IS NULL OR days >= 0),
  CHECK (kind <> 'EVIDENCE' OR claim_id IS NOT NULL),
  CHECK (kind <> 'RECOMMENDATION'
         OR (basis IS NOT NULL AND assumptions IS NOT NULL AND uncertainty IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_monetization_facts_attribute
  ON monetization_path_facts(path_id, attribute);

CREATE INDEX IF NOT EXISTS idx_monetization_facts_project
  ON monetization_path_facts(project_id, attribute);


CREATE TABLE IF NOT EXISTS monetization_path_judgments (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  path_id       TEXT NOT NULL REFERENCES monetization_paths(id),
  judgment      TEXT NOT NULL,
  reason        TEXT NOT NULL,
  decided_by_id TEXT REFERENCES users(id),
  channel       TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  seq           BIGSERIAL,
  CHECK (judgment IN ('WATCH', 'INVALIDATE', 'ARCHIVE', 'REVIVE')),
  CHECK (channel IN ('BROWSER_SESSION', 'DELEGATED_TERMINAL'))
);

CREATE INDEX IF NOT EXISTS idx_monetization_judgments_path
  ON monetization_path_judgments(path_id, created_at);

CREATE INDEX IF NOT EXISTS idx_monetization_judgments_project
  ON monetization_path_judgments(project_id, created_at);


CREATE TABLE IF NOT EXISTS monetization_path_edges (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  from_path_id    TEXT NOT NULL REFERENCES monetization_paths(id),
  to_path_id      TEXT NOT NULL REFERENCES monetization_paths(id),
  kind            TEXT NOT NULL,
  rationale       TEXT NOT NULL,
  source          TEXT NOT NULL,
  source_claim_id TEXT REFERENCES research_claims(id),
  decided_by_id   TEXT REFERENCES users(id),
  created_at      TEXT NOT NULL,
  seq             BIGSERIAL,
  CHECK (kind IN ('ENABLES', 'REQUIRES', 'COMPETES_WITH', 'COEXISTS_WITH',
                  'PRODUCES_DATA_FOR', 'PRODUCES_RELATIONSHIPS_FOR',
                  'STEPPING_STONE_TO', 'VIABLE_ONLY_AT_SCALE_OF')),
  CHECK (source IN ('PERSON', 'EVIDENCED')),
  CHECK (from_path_id <> to_path_id),
  CHECK (source <> 'EVIDENCED' OR source_claim_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_monetization_edges_pair
  ON monetization_path_edges(from_path_id, to_path_id, kind);

CREATE INDEX IF NOT EXISTS idx_monetization_edges_project
  ON monetization_path_edges(project_id);

CREATE INDEX IF NOT EXISTS idx_monetization_edges_to
  ON monetization_path_edges(to_path_id);


CREATE TABLE IF NOT EXISTS monetization_rank_snapshots (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id),
  path_id        TEXT NOT NULL REFERENCES monetization_paths(id),
  rank           INTEGER NOT NULL,
  previous_rank  INTEGER,
  reason         TEXT NOT NULL,
  status         TEXT NOT NULL,
  criterion      TEXT,
  evaluated_at   TEXT NOT NULL,
  seq            BIGSERIAL,
  CHECK (rank >= 1),
  CHECK (previous_rank IS NULL OR previous_rank >= 1),
  CHECK (reason IN ('ENTERED_THE_LEDGER', 'ITS_OWN_EVIDENCE_CHANGED',
                    'ITS_STATUS_CHANGED', 'THE_FIELD_AROUND_IT_CHANGED',
                    'A_PERSON_DECIDED'))
);

CREATE INDEX IF NOT EXISTS idx_monetization_snapshots_path
  ON monetization_rank_snapshots(path_id, evaluated_at);

CREATE INDEX IF NOT EXISTS idx_monetization_snapshots_project
  ON monetization_rank_snapshots(project_id, evaluated_at);


ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS monetization_method TEXT;
