-- The Postgres half of SQLite migration 080. See that file for why a generator
-- is code and can never be a row, why UNSUPPORTED is not PASS, why an instance
-- is immutable, why a cosmetic reskin is recorded and never counted, and why
-- nothing derivable is stored.
--
-- Every table here carries `seq BIGSERIAL`, which is the identity column
-- `dialect.ts` rewrites `rowid` to. §25 and §27 both record what its absence
-- costs: a tiebreak on a column only one dialect has passes the whole SQLite
-- suite and throws in production. §27 records a third instance at
-- `worker_sessions`, which is the one that took a hosted factory tick down.

CREATE TABLE IF NOT EXISTS puzzle_formats (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  slug            TEXT NOT NULL,
  name            TEXT NOT NULL,
  description     TEXT,
  origin          TEXT NOT NULL,
  source_claim_id TEXT REFERENCES research_claims(id),
  declared_by_ref TEXT,
  retired_at      TEXT,
  retired_reason  TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  seq             BIGSERIAL,
  CHECK (origin IN ('SEED', 'DISCOVERED')),
  CHECK (origin = 'SEED' OR source_claim_id IS NOT NULL),
  CHECK ((retired_at IS NULL) = (retired_reason IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_puzzle_formats_slug
  ON puzzle_formats(project_id, slug);


CREATE TABLE IF NOT EXISTS puzzle_masters (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id),
  format_id         TEXT NOT NULL REFERENCES puzzle_formats(id),
  name              TEXT NOT NULL,
  generator_key     TEXT NOT NULL,
  spec              TEXT NOT NULL,
  generator_version TEXT NOT NULL,
  rights_basis      TEXT NOT NULL,
  rights_statement  TEXT,
  rights_claim_id   TEXT REFERENCES research_claims(id),
  blocked_at        TEXT,
  blocked_reason    TEXT,
  retired_at        TEXT,
  retired_reason    TEXT,
  declared_by_ref   TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  seq               BIGSERIAL,
  CHECK (rights_basis IN ('PUBLIC_DOMAIN', 'OWN_WORK', 'LICENSED', 'UNESTABLISHED')),
  CHECK (rights_basis = 'UNESTABLISHED' OR rights_statement IS NOT NULL),
  CHECK ((blocked_at IS NULL) = (blocked_reason IS NULL)),
  CHECK ((retired_at IS NULL) = (retired_reason IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_puzzle_masters_name
  ON puzzle_masters(project_id, name);

CREATE INDEX IF NOT EXISTS idx_puzzle_masters_format
  ON puzzle_masters(format_id);


CREATE TABLE IF NOT EXISTS puzzle_instances (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id),
  master_id           TEXT NOT NULL REFERENCES puzzle_masters(id),
  format_id           TEXT NOT NULL REFERENCES puzzle_formats(id),
  generator_key       TEXT NOT NULL,
  generator_version   TEXT NOT NULL,
  seed                TEXT NOT NULL,
  payload             TEXT NOT NULL,
  content_hash        TEXT NOT NULL,
  solution_hash       TEXT NOT NULL,
  canonical_hash      TEXT NOT NULL,
  measured_difficulty INTEGER,
  difficulty_basis    TEXT,
  created_at          TEXT NOT NULL,
  seq                 BIGSERIAL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_puzzle_instances_canonical
  ON puzzle_instances(project_id, format_id, canonical_hash);

CREATE INDEX IF NOT EXISTS idx_puzzle_instances_master
  ON puzzle_instances(master_id, created_at);


CREATE TABLE IF NOT EXISTS puzzle_validations (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id),
  instance_id       TEXT NOT NULL REFERENCES puzzle_instances(id),
  check_key         TEXT NOT NULL,
  verdict           TEXT NOT NULL,
  detail            TEXT,
  validator_key     TEXT NOT NULL,
  validator_version TEXT NOT NULL,
  content_hash      TEXT NOT NULL,
  ran_at            TEXT NOT NULL,
  seq               BIGSERIAL,
  CHECK (verdict IN ('PASS', 'FAIL', 'UNSUPPORTED')),
  CHECK (verdict <> 'FAIL' OR detail IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_puzzle_validations_run
  ON puzzle_validations(instance_id, check_key, validator_version);

CREATE INDEX IF NOT EXISTS idx_puzzle_validations_instance
  ON puzzle_validations(instance_id);

CREATE INDEX IF NOT EXISTS idx_puzzle_validations_project
  ON puzzle_validations(project_id, verdict);


CREATE TABLE IF NOT EXISTS puzzle_editions (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id),
  master_id          TEXT NOT NULL REFERENCES puzzle_masters(id),
  name               TEXT NOT NULL,
  product_class      TEXT NOT NULL,
  distinctness_axis  TEXT NOT NULL,
  distinctness_value TEXT,
  rationale          TEXT NOT NULL,
  artifact_key       TEXT,
  artifact_hash      TEXT,
  compiled_at        TEXT,
  declared_by_ref    TEXT,
  retired_at         TEXT,
  retired_reason     TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  seq                BIGSERIAL,
  CHECK (product_class IN (
    'PRINTABLE_PDF', 'PRINT_BOOK', 'WEB_PLAY', 'APP', 'EMAIL_FEED',
    'SYNDICATED_FEED', 'WHITE_LABEL', 'INSTITUTIONAL_PACK', 'PHYSICAL_PRODUCT',
    'API_FEED')),
  CHECK (distinctness_axis IN (
    'DISTINCT_CONTENT', 'DIFFICULTY', 'AUDIENCE', 'LANGUAGE', 'PRODUCT_FORM',
    'USE_OCCASION', 'CHANNEL', 'MECHANIC', 'COSMETIC')),
  CHECK (distinctness_axis = 'DISTINCT_CONTENT' OR distinctness_value IS NOT NULL),
  CHECK ((compiled_at IS NULL) = (artifact_key IS NULL)),
  CHECK ((artifact_key IS NULL) = (artifact_hash IS NULL)),
  CHECK ((retired_at IS NULL) = (retired_reason IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_puzzle_editions_name
  ON puzzle_editions(project_id, name);

CREATE INDEX IF NOT EXISTS idx_puzzle_editions_master
  ON puzzle_editions(master_id);


CREATE TABLE IF NOT EXISTS puzzle_edition_instances (
  id          TEXT PRIMARY KEY,
  edition_id  TEXT NOT NULL REFERENCES puzzle_editions(id),
  instance_id TEXT NOT NULL REFERENCES puzzle_instances(id),
  position    INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  seq         BIGSERIAL,
  CHECK (position >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_puzzle_edition_instances_pair
  ON puzzle_edition_instances(edition_id, instance_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_puzzle_edition_instances_position
  ON puzzle_edition_instances(edition_id, position);

CREATE INDEX IF NOT EXISTS idx_puzzle_edition_instances_instance
  ON puzzle_edition_instances(instance_id);


CREATE TABLE IF NOT EXISTS puzzle_rounds (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  format_id    TEXT REFERENCES puzzle_formats(id),
  purpose      TEXT NOT NULL,
  round        INTEGER NOT NULL,
  candidate_id TEXT NOT NULL,
  state        TEXT NOT NULL,
  opened_at    TEXT NOT NULL,
  harvested_at TEXT,
  found        INTEGER,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  seq          BIGSERIAL,
  CHECK (purpose IN ('UNIVERSE', 'DEMAND', 'CHANNEL', 'RIGHTS', 'PRODUCTION')),
  CHECK (round >= 1),
  CHECK (state IN ('OPEN', 'HARVESTED', 'ABANDONED')),
  CHECK (state = 'OPEN' OR found IS NOT NULL),
  CHECK (purpose = 'UNIVERSE' OR format_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_puzzle_rounds_format_ask
  ON puzzle_rounds(project_id, format_id, purpose, round) WHERE format_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_puzzle_rounds_universe_ask
  ON puzzle_rounds(project_id, purpose, round) WHERE format_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_puzzle_rounds_candidate
  ON puzzle_rounds(candidate_id);

CREATE INDEX IF NOT EXISTS idx_puzzle_rounds_project
  ON puzzle_rounds(project_id, state);


ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS puzzle_finding TEXT;
ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS puzzle_subject TEXT;
ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS puzzle_qualifier TEXT;
ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS puzzle_price_cents INTEGER;

-- Plainly, and not inside a `DO $$ ... $$` block.
--
-- The first version of this file wrapped it in one, to make it re-runnable.
-- `migrate.ts` splits a file on semicolons, so a dollar-quoted body is cut at
-- its first internal `;` and Postgres is handed half a statement — which is
-- exactly what happened, and which no SQLite run could have shown: the SQLite
-- chain carries this as an inline column CHECK and never reaches this code
-- path at all. §25's argument in one line, at a *statement* rather than at a
-- column: a repository layer over two databases is true or merely compiling,
-- and only one of the two can tell you which.
--
-- It needs no guard. A migration is versioned, applied exactly once, and runs
-- in its own transaction — so a plain ADD CONSTRAINT cannot collide with
-- itself, and a partially-applied file rolls back whole. There is no `DO`
-- block anywhere else in this chain, and this one is not the place to
-- introduce the first.
ALTER TABLE research_claims
  ADD CONSTRAINT research_claims_puzzle_price_cents_check
  CHECK (puzzle_price_cents IS NULL OR puzzle_price_cents >= 0);
