-- The Postgres half of SQLite migration 075. See that file for why a capability
-- a product teaches is not a capability we hold, why demand pulls manufacturing,
-- why the ladder is discovered rather than declared, and why nothing derivable
-- is stored.
--
-- Every table here carries `seq BIGSERIAL`, which is the identity column
-- `dialect.ts` rewrites `rowid` to. §25, §27 and §34 all record what its absence
-- costs: a tiebreak on a column only one dialect has passes the whole SQLite
-- suite and throws in production.

CREATE TABLE IF NOT EXISTS manufacturing_programs (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id),
  objective          TEXT NOT NULL,
  state              TEXT NOT NULL,
  owner_user_id      TEXT NOT NULL REFERENCES users(id),
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  seq                BIGSERIAL,
  CHECK (state IN ('ACTIVE', 'PAUSED', 'ARCHIVED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_manufacturing_programs_project
  ON manufacturing_programs(project_id);


CREATE TABLE IF NOT EXISTS machine_categories (
  id              TEXT PRIMARY KEY,
  program_id      TEXT NOT NULL REFERENCES manufacturing_programs(id),
  project_id      TEXT NOT NULL REFERENCES projects(id),
  parent_id       TEXT REFERENCES machine_categories(id),
  kind            TEXT NOT NULL,
  name            TEXT NOT NULL,
  description     TEXT,
  origin          TEXT NOT NULL,
  source_claim_id TEXT REFERENCES research_claims(id),
  retired_at      TEXT,
  retired_reason  TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  seq             BIGSERIAL,
  CHECK (kind IN ('PRODUCT_CATEGORY', 'ADJACENT_CATEGORY')),
  CHECK (origin IN ('SEED', 'BOOTSTRAP', 'DISCOVERED')),
  CHECK (origin = 'SEED' OR source_claim_id IS NOT NULL),
  CHECK ((retired_at IS NULL) = (retired_reason IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_machine_categories_child
  ON machine_categories(program_id, parent_id, name) WHERE parent_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_machine_categories_root
  ON machine_categories(program_id, name) WHERE parent_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_machine_categories_program
  ON machine_categories(program_id, kind);

CREATE INDEX IF NOT EXISTS idx_machine_categories_parent
  ON machine_categories(parent_id);


CREATE TABLE IF NOT EXISTS capabilities (
  id              TEXT PRIMARY KEY,
  program_id      TEXT NOT NULL REFERENCES manufacturing_programs(id),
  project_id      TEXT NOT NULL REFERENCES projects(id),
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL,
  description     TEXT,
  origin          TEXT NOT NULL,
  source_claim_id TEXT REFERENCES research_claims(id),
  held_at         TEXT,
  held_evidence   TEXT,
  held_by         TEXT,
  held_note       TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  seq             BIGSERIAL,
  CHECK (origin IN ('SEED', 'DISCOVERED')),
  CHECK (held_evidence IS NULL OR held_evidence IN ('DECLARED')),
  CHECK (origin = 'SEED' OR source_claim_id IS NOT NULL),
  CHECK ((held_at IS NULL) = (held_evidence IS NULL)),
  CHECK ((held_at IS NULL) = (held_by IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_capabilities_slug
  ON capabilities(program_id, slug);

CREATE INDEX IF NOT EXISTS idx_capabilities_held
  ON capabilities(program_id, held_at);


CREATE TABLE IF NOT EXISTS capability_edges (
  id              TEXT PRIMARY KEY,
  program_id      TEXT NOT NULL REFERENCES manufacturing_programs(id),
  category_id     TEXT NOT NULL REFERENCES machine_categories(id),
  capability_id   TEXT NOT NULL REFERENCES capabilities(id),
  relation        TEXT NOT NULL,
  statement       TEXT NOT NULL,
  source_claim_id TEXT NOT NULL REFERENCES research_claims(id),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  seq             BIGSERIAL,
  CHECK (relation IN ('REQUIRES', 'TEACHES'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_capability_edges_unique
  ON capability_edges(category_id, capability_id, relation);

CREATE INDEX IF NOT EXISTS idx_capability_edges_capability
  ON capability_edges(capability_id, relation);

CREATE INDEX IF NOT EXISTS idx_capability_edges_program
  ON capability_edges(program_id, relation);


CREATE TABLE IF NOT EXISTS category_evidence (
  id              TEXT PRIMARY KEY,
  program_id      TEXT NOT NULL REFERENCES manufacturing_programs(id),
  category_id     TEXT NOT NULL REFERENCES machine_categories(id),
  kind            TEXT NOT NULL,
  subject         TEXT NOT NULL,
  statement       TEXT NOT NULL,
  observed_on     TEXT,
  source_claim_id TEXT NOT NULL REFERENCES research_claims(id),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  seq             BIGSERIAL,
  CHECK (kind IN ('DEMAND_EVIDENCE', 'DISTRIBUTION_CHANNEL',
                  'INCUMBENT_WEAKNESS', 'ENTRY_BARRIER', 'BOUGHT_IN_COMPONENT')),
  CHECK (kind <> 'DEMAND_EVIDENCE' OR observed_on IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_category_evidence_claim
  ON category_evidence(source_claim_id, kind);

CREATE INDEX IF NOT EXISTS idx_category_evidence_category
  ON category_evidence(category_id, kind);


CREATE TABLE IF NOT EXISTS manufacturing_rounds (
  id            TEXT PRIMARY KEY,
  program_id    TEXT NOT NULL REFERENCES manufacturing_programs(id),
  project_id    TEXT NOT NULL REFERENCES projects(id),
  category_id   TEXT REFERENCES machine_categories(id),
  purpose       TEXT NOT NULL,
  round         INTEGER NOT NULL,
  candidate_id  TEXT NOT NULL,
  state         TEXT NOT NULL,
  opened_at     TEXT NOT NULL,
  harvested_at  TEXT,
  found         INTEGER,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  seq           BIGSERIAL,
  CHECK (purpose IN ('BOOTSTRAP', 'MAP', 'DEMAND', 'CAPABILITY', 'INTEGRATION')),
  CHECK (state IN ('OPEN', 'HARVESTED', 'ABANDONED')),
  CHECK (round >= 1),
  CHECK ((purpose = 'BOOTSTRAP') = (category_id IS NULL)),
  CHECK (state = 'OPEN' OR found IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_manufacturing_rounds_ask
  ON manufacturing_rounds(program_id, COALESCE(category_id, '-'), purpose, round);

CREATE UNIQUE INDEX IF NOT EXISTS idx_manufacturing_rounds_candidate
  ON manufacturing_rounds(candidate_id);

CREATE INDEX IF NOT EXISTS idx_manufacturing_rounds_program
  ON manufacturing_rounds(program_id, state);


ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS capability_finding TEXT;
ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS capability_subject TEXT;
ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS capability_observed_on TEXT;


CREATE UNIQUE INDEX IF NOT EXISTS idx_russell_goals_one_live_manufacturing
  ON russell_goals (project_id)
  WHERE state = 'ACTIVE' AND name = 'Manufacturing programme research';
