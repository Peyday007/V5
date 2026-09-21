-- The Postgres half of SQLite migration 088. See that file for why one
-- validated production system compiling into many qualified outputs is an axis
-- nothing above it can express, why this repository contains no list of puzzle
-- formats, why a generator is an implementation and a format is not, why an
-- instance with no PASSED current validation is something this kernel does not
-- have, why "nobody looked" needed a posture of its own, and why nothing
-- derivable is stored.
--
-- Every table here carries `seq BIGSERIAL`, which is the identity column
-- `dialect.ts` rewrites `rowid` to. §25 and §27 both record what its absence
-- costs: a tiebreak on a column only one dialect has passes the whole SQLite
-- suite and throws in production.
--
-- Every CHECK in 088 is restated here rather than assumed. §45 records the
-- fifth instance of the same defect: a `CHECK (amount >= 0)` that existed on
-- the SQLite column and on nothing else, so every SQLite run in the world
-- reported the constraint installed and the backend production runs had none.

CREATE TABLE IF NOT EXISTS puzzle_formats (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  name             TEXT NOT NULL,
  format_key       TEXT NOT NULL,
  audience         TEXT,
  note             TEXT,
  origin           TEXT NOT NULL,
  source_claim_id  TEXT,
  retired_at       TEXT,
  retired_reason   TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  seq              BIGSERIAL,
  CHECK (origin IN ('SEED', 'DISCOVERED')),
  CHECK (origin = 'SEED' OR source_claim_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_puzzle_formats_identity
  ON puzzle_formats(project_id, format_key);


CREATE TABLE IF NOT EXISTS puzzle_standards (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  format_key       TEXT NOT NULL,
  check_kind       TEXT NOT NULL,
  statement        TEXT NOT NULL,
  authority        TEXT,
  source_claim_id  TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  seq              BIGSERIAL,
  CHECK (check_kind IN (
    'SOLUTION_UNIQUENESS',
    'SOLVABILITY',
    'ANSWER_KEY_AGREEMENT',
    'COORDINATE_AGREEMENT',
    'GRID_LEGALITY',
    'CONNECTIVITY',
    'CLUE_AGREEMENT',
    'REACHABILITY',
    'DUPLICATE_DETECTION',
    'DIFFICULTY_CALIBRATION',
    'PROHIBITED_CONTENT'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_puzzle_standards_identity
  ON puzzle_standards(project_id, format_key, check_kind, source_claim_id);

CREATE INDEX IF NOT EXISTS idx_puzzle_standards_format
  ON puzzle_standards(project_id, format_key);


CREATE TABLE IF NOT EXISTS puzzle_rights (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  format_key       TEXT NOT NULL,
  rights_kind      TEXT NOT NULL,
  statement        TEXT NOT NULL,
  authority        TEXT,
  source_claim_id  TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  seq              BIGSERIAL,
  CHECK (rights_kind IN (
    'COPYRIGHT',
    'TRADEMARK',
    'LICENSE_REQUIRED',
    'PUBLIC_DOMAIN',
    'PLATFORM_POLICY',
    'CONTENT_RULE'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_puzzle_rights_identity
  ON puzzle_rights(project_id, format_key, rights_kind, source_claim_id);

CREATE INDEX IF NOT EXISTS idx_puzzle_rights_format
  ON puzzle_rights(project_id, format_key);


-- `rights_basis` is NOT NULL here as it is in 088, and that is the directive's
-- rights standard made structural: there is nowhere in this schema to put a
-- generator whose source material nobody has accounted for.
CREATE TABLE IF NOT EXISTS puzzle_masters (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  format_key       TEXT NOT NULL,
  name             TEXT NOT NULL,
  engine_id        TEXT NOT NULL,
  engine_version   TEXT NOT NULL,
  params_json      TEXT NOT NULL,
  corpus_ref       TEXT,
  rights_basis     TEXT NOT NULL,
  reviewed_at      TEXT,
  reviewed_by_id   TEXT REFERENCES users(id),
  reviewed_note    TEXT,
  retired_at       TEXT,
  retired_reason   TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  seq              BIGSERIAL,
  CHECK ((reviewed_at IS NULL) = (reviewed_by_id IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_puzzle_masters_identity
  ON puzzle_masters(project_id, name);

CREATE INDEX IF NOT EXISTS idx_puzzle_masters_format
  ON puzzle_masters(project_id, format_key);


CREATE TABLE IF NOT EXISTS puzzle_instances (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  master_id        TEXT NOT NULL REFERENCES puzzle_masters(id),
  format_key       TEXT NOT NULL,
  seed             TEXT NOT NULL,
  engine_id        TEXT NOT NULL,
  engine_version   TEXT NOT NULL,
  payload_json     TEXT NOT NULL,
  content_hash     TEXT NOT NULL,
  difficulty       TEXT,
  expected_solve_seconds INTEGER,
  locale           TEXT,
  created_at       TEXT NOT NULL,
  seq              BIGSERIAL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_puzzle_instances_content
  ON puzzle_instances(project_id, content_hash);

CREATE INDEX IF NOT EXISTS idx_puzzle_instances_master
  ON puzzle_instances(master_id);


CREATE TABLE IF NOT EXISTS puzzle_validations (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  instance_id      TEXT NOT NULL REFERENCES puzzle_instances(id),
  validator_id     TEXT NOT NULL,
  validator_version TEXT NOT NULL,
  verdict          TEXT NOT NULL,
  checks_json      TEXT NOT NULL,
  failed_check     TEXT,
  superseded_at    TEXT,
  created_at       TEXT NOT NULL,
  seq              BIGSERIAL,
  CHECK (verdict IN ('PASSED', 'FAILED', 'UNCHECKED'))
);

CREATE INDEX IF NOT EXISTS idx_puzzle_validations_current
  ON puzzle_validations(instance_id, superseded_at);

CREATE INDEX IF NOT EXISTS idx_puzzle_validations_defect
  ON puzzle_validations(project_id, failed_check, superseded_at);


-- There is no delete path to this table anywhere in the kernel, and no
-- `DELETED` disposition, because the directive says in as many words never to
-- delete or hide a slower, blocked or long-term route.
CREATE TABLE IF NOT EXISTS puzzle_routes (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id),
  name               TEXT NOT NULL,
  route_key          TEXT NOT NULL,
  route_class        TEXT NOT NULL,
  note               TEXT,
  disposition        TEXT NOT NULL,
  disposition_reason TEXT,
  disposition_by_id  TEXT REFERENCES users(id),
  disposition_at     TEXT,
  origin             TEXT NOT NULL,
  source_claim_id    TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  seq                BIGSERIAL,
  CHECK (route_class IN (
    'DIGITAL_SALE',
    'SUBSCRIPTION',
    'ADVERTISING',
    'SYNDICATION',
    'CUSTOM_COMMISSION',
    'INSTITUTIONAL',
    'WHITE_LABEL',
    'PRINT_PRODUCT',
    'PHYSICAL_PRODUCT',
    'SOFTWARE',
    'ACQUISITION',
    'CONTRACT_PRODUCTION')),
  CHECK (disposition IN ('ACTIVE', 'WATCHLIST', 'BLOCKED', 'ARCHIVED', 'REJECTED')),
  CHECK (origin IN ('SEED', 'DISCOVERED')),
  CHECK (origin = 'SEED' OR source_claim_id IS NOT NULL),
  CHECK (disposition = 'ACTIVE' OR (disposition_by_id IS NOT NULL AND disposition_reason IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_puzzle_routes_identity
  ON puzzle_routes(project_id, route_key);


CREATE TABLE IF NOT EXISTS puzzle_route_evidence (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  route_id         TEXT NOT NULL REFERENCES puzzle_routes(id),
  posture          TEXT NOT NULL,
  buyer            TEXT NOT NULL,
  format_key       TEXT,
  statement        TEXT NOT NULL,
  observed_on      TEXT,
  source_claim_id  TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  seq              BIGSERIAL,
  CHECK (posture IN ('DEMAND_FOUND', 'NONE_FOUND')),
  CHECK (posture = 'NONE_FOUND' OR observed_on IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_puzzle_route_evidence_route
  ON puzzle_route_evidence(route_id, posture);


-- `side` is absent here exactly as it is in 088: it is derived from the
-- component by a lookup in code. A caller that could declare a retailer share
-- as revenue would be able to make a run look profitable.
CREATE TABLE IF NOT EXISTS puzzle_economics (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  route_id         TEXT REFERENCES puzzle_routes(id),
  format_key       TEXT,
  output_id        TEXT,
  component        TEXT NOT NULL,
  basis            TEXT NOT NULL,
  amount_minor     BIGINT NOT NULL,
  currency         TEXT NOT NULL,
  statement        TEXT NOT NULL,
  observed_on      TEXT,
  source_claim_id  TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  seq              BIGSERIAL,
  CHECK (amount_minor >= 0),
  CHECK (component IN (
    'RETAIL_PRICE',
    'NET_RECEIPTS',
    'LICENSE_FEE',
    'SYNDICATION_FEE',
    'SUBSCRIPTION_PRICE',
    'CUSTOM_COMMISSION',
    'EDITORIAL_COST',
    'PLATFORM_FEE',
    'RETAILER_SHARE',
    'PREPRESS_COST',
    'TOOLING_SETUP',
    'PRINTING_COST',
    'MATERIALS_COST',
    'PACKAGING_COST',
    'FREIGHT_COST',
    'FULFILLMENT_COST',
    'STORAGE_COST',
    'RETURNS_ALLOWANCE',
    'LABOR_COST',
    'ROYALTY'))
);

CREATE INDEX IF NOT EXISTS idx_puzzle_economics_route
  ON puzzle_economics(project_id, route_id, component);

CREATE INDEX IF NOT EXISTS idx_puzzle_economics_format
  ON puzzle_economics(project_id, format_key, component);


CREATE TABLE IF NOT EXISTS puzzle_outputs (
  id                   TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL REFERENCES projects(id),
  master_id            TEXT NOT NULL REFERENCES puzzle_masters(id),
  title                TEXT NOT NULL,
  production_class     TEXT NOT NULL,
  differentiators_json TEXT NOT NULL,
  target_buyer         TEXT,
  route_id             TEXT REFERENCES puzzle_routes(id),
  released_at          TEXT,
  released_by_id       TEXT REFERENCES users(id),
  opportunity_id       TEXT REFERENCES cash_opportunities(id),
  retired_at           TEXT,
  retired_reason       TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  seq                  BIGSERIAL,
  CHECK (production_class IN (
    'DIGITAL_ONLY',
    'PRINTABLE',
    'BOOK',
    'ACTIVITY_PAD',
    'CARD',
    'JIGSAW',
    'BOXED_KIT',
    'MECHANICAL',
    'FEED')),
  CHECK ((released_at IS NULL) = (released_by_id IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_puzzle_outputs_identity
  ON puzzle_outputs(project_id, title);

CREATE INDEX IF NOT EXISTS idx_puzzle_outputs_master
  ON puzzle_outputs(master_id);


CREATE TABLE IF NOT EXISTS puzzle_output_members (
  id               TEXT PRIMARY KEY,
  output_id        TEXT NOT NULL REFERENCES puzzle_outputs(id),
  instance_id      TEXT NOT NULL REFERENCES puzzle_instances(id),
  position         INTEGER NOT NULL,
  created_at       TEXT NOT NULL,
  seq              BIGSERIAL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_puzzle_output_members_identity
  ON puzzle_output_members(output_id, instance_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_puzzle_output_members_position
  ON puzzle_output_members(output_id, position);


-- `found` is nullable and NULL while a round is OPEN. §33 records what a
-- `NOT NULL DEFAULT 0` cost one kernel along: every live round published the
-- default as a measurement.
CREATE TABLE IF NOT EXISTS puzzle_rounds (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  purpose          TEXT NOT NULL,
  subject_key      TEXT,
  subject_label    TEXT,
  round            INTEGER NOT NULL,
  candidate_id     TEXT NOT NULL REFERENCES russell_candidates(id),
  why              TEXT NOT NULL,
  state            TEXT NOT NULL,
  found            INTEGER,
  settled_at       TEXT,
  settled_reason   TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  seq              BIGSERIAL,
  CHECK (purpose IN (
    'UNIVERSE',
    'DEMAND',
    'ROUTE',
    'ECONOMICS',
    'RIGHTS',
    'STANDARD',
    'CHEAP_BOOK')),
  CHECK (state IN ('OPEN', 'HARVESTED', 'ABANDONED')),
  CHECK (state = 'OPEN' OR settled_at IS NOT NULL),
  CHECK (state = 'OPEN' OR found IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_puzzle_rounds_live
  ON puzzle_rounds(project_id, purpose, subject_key)
  WHERE state = 'OPEN' AND subject_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_puzzle_rounds_live_open
  ON puzzle_rounds(project_id, purpose)
  WHERE state = 'OPEN' AND subject_key IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_puzzle_rounds_candidate
  ON puzzle_rounds(candidate_id);

CREATE INDEX IF NOT EXISTS idx_puzzle_rounds_project
  ON puzzle_rounds(project_id, state);


CREATE TABLE IF NOT EXISTS puzzle_observations (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  kind             TEXT NOT NULL,
  subject_key      TEXT,
  statement        TEXT NOT NULL,
  observer         TEXT NOT NULL,
  observer_id      TEXT REFERENCES users(id),
  master_id        TEXT REFERENCES puzzle_masters(id),
  output_id        TEXT REFERENCES puzzle_outputs(id),
  source_claim_id  TEXT,
  created_at       TEXT NOT NULL,
  seq              BIGSERIAL,
  CHECK (kind IN (
    'GENERATOR_DEFECT',
    'VALIDATION_FAILURE',
    'PLAYTEST_RESULT',
    'BUYER_RESPONSE',
    'PRICING_RESULT',
    'CHANNEL_ECONOMICS',
    'VENDOR_PERFORMANCE',
    'PRODUCTION_RESULT',
    'CUSTOMER_COMPLAINT',
    'RIGHTS_ISSUE')),
  CHECK (observer IN ('BRAIN', 'PERSON')),
  CHECK (observer = 'BRAIN' OR observer_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_puzzle_observations_group
  ON puzzle_observations(project_id, kind, subject_key);


ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS puzzle_finding TEXT;
ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS puzzle_subject TEXT;
ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS puzzle_format TEXT;
ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS puzzle_value TEXT;
ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS puzzle_basis TEXT;
ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS puzzle_amount_minor BIGINT;
ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS puzzle_currency TEXT;
ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS puzzle_observed_on TEXT;

CREATE INDEX IF NOT EXISTS idx_research_claims_puzzle
  ON research_claims(puzzle_finding);
