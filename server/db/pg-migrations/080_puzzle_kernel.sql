-- The Postgres half of SQLite migration 089. See that file for why the
-- specification is stored and the puzzle is not, why a generator's belief is
-- never evidence, why a master and a product are two tables, why a reskin has
-- nowhere to be declared, why every researched fact traces to a gated claim,
-- and why nothing derivable is stored.
--
-- Every table here carries `seq BIGSERIAL`, which is the identity column
-- `dialect.ts` rewrites `rowid` to. §25 and §27 both record what its absence
-- costs: a tiebreak on a column only one dialect has passes the whole SQLite
-- suite and throws in production.

CREATE TABLE IF NOT EXISTS puzzle_formats (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  name             TEXT NOT NULL,
  format_key       TEXT NOT NULL,
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

CREATE UNIQUE INDEX IF NOT EXISTS puzzle_formats_unique
  ON puzzle_formats (project_id, format_key);


CREATE TABLE IF NOT EXISTS puzzle_masters (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id),
  title             TEXT NOT NULL,
  format_key        TEXT NOT NULL,
  corpus_id         TEXT NOT NULL,
  parameters        TEXT NOT NULL,
  difficulty        TEXT NOT NULL,
  generator_version TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  seq               BIGSERIAL,
  CHECK (difficulty IN ('EASY', 'MEDIUM', 'HARD', 'EXPERT'))
);

CREATE INDEX IF NOT EXISTS puzzle_masters_by_project
  ON puzzle_masters (project_id, format_key);


CREATE TABLE IF NOT EXISTS puzzle_instances (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id),
  master_id           TEXT NOT NULL REFERENCES puzzle_masters(id),
  seed                TEXT NOT NULL,
  content_hash        TEXT NOT NULL,
  canonical_hash      TEXT,
  validation_state    TEXT NOT NULL,
  measured_difficulty TEXT,
  checks              TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  seq                 BIGSERIAL,
  CHECK (validation_state IN ('PENDING', 'VALID', 'INVALID')),
  CHECK (measured_difficulty IS NULL
         OR measured_difficulty IN ('EASY', 'MEDIUM', 'HARD', 'EXPERT')),
  CHECK ((validation_state = 'PENDING') = (canonical_hash IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS puzzle_instances_unique
  ON puzzle_instances (master_id, seed);

CREATE INDEX IF NOT EXISTS puzzle_instances_by_canonical
  ON puzzle_instances (project_id, canonical_hash);


CREATE TABLE IF NOT EXISTS puzzle_products (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  master_id       TEXT NOT NULL REFERENCES puzzle_masters(id),
  title           TEXT NOT NULL,
  product_class   TEXT NOT NULL,
  audience        TEXT,
  use_occasion    TEXT,
  language        TEXT NOT NULL,
  difficulty      TEXT,
  channel         TEXT,
  buyer           TEXT,
  instance_count  INTEGER NOT NULL,
  opportunity_id  TEXT,
  retired_at      TEXT,
  retired_reason  TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  seq             BIGSERIAL,
  CHECK (product_class IN ('DIGITAL_DOWNLOAD', 'INTERACTIVE', 'RECURRING_FEED',
                           'LICENSE', 'PRINT_BOOK', 'CARD_OR_BOXED', 'SERVICE')),
  CHECK (difficulty IS NULL OR difficulty IN ('EASY', 'MEDIUM', 'HARD', 'EXPERT')),
  CHECK (instance_count > 0)
);

CREATE INDEX IF NOT EXISTS puzzle_products_by_master
  ON puzzle_products (master_id);

CREATE INDEX IF NOT EXISTS puzzle_products_by_project
  ON puzzle_products (project_id, product_class);


CREATE TABLE IF NOT EXISTS puzzle_product_instances (
  product_id   TEXT NOT NULL REFERENCES puzzle_products(id),
  instance_id  TEXT NOT NULL REFERENCES puzzle_instances(id),
  position     INTEGER NOT NULL,
  seq          BIGSERIAL,
  PRIMARY KEY (product_id, instance_id)
);

CREATE INDEX IF NOT EXISTS puzzle_product_instances_by_instance
  ON puzzle_product_instances (instance_id);


CREATE TABLE IF NOT EXISTS puzzle_demand (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  format_key       TEXT NOT NULL,
  buyer            TEXT NOT NULL,
  buyer_key        TEXT NOT NULL,
  statement        TEXT NOT NULL,
  publisher        TEXT,
  observed_on      TEXT,
  source_claim_id  TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  seq              BIGSERIAL
);

CREATE UNIQUE INDEX IF NOT EXISTS puzzle_demand_unique
  ON puzzle_demand (project_id, format_key, buyer_key);


CREATE TABLE IF NOT EXISTS puzzle_routes (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  kind             TEXT NOT NULL,
  format_key       TEXT NOT NULL,
  name             TEXT NOT NULL,
  name_key         TEXT NOT NULL,
  terms            TEXT NOT NULL,
  publisher        TEXT,
  observed_on      TEXT,
  source_claim_id  TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  seq              BIGSERIAL,
  CHECK (kind IN ('CHANNEL', 'PRODUCTION'))
);

CREATE UNIQUE INDEX IF NOT EXISTS puzzle_routes_unique
  ON puzzle_routes (project_id, kind, format_key, name_key);


CREATE TABLE IF NOT EXISTS puzzle_economics (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  format_key       TEXT NOT NULL,
  product_class    TEXT NOT NULL,
  component        TEXT NOT NULL,
  amount_cents     INTEGER NOT NULL,
  currency         TEXT NOT NULL,
  basis_note       TEXT NOT NULL,
  publisher        TEXT,
  observed_on      TEXT,
  source_claim_id  TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  seq              BIGSERIAL,
  CHECK (product_class IN ('DIGITAL_DOWNLOAD', 'INTERACTIVE', 'RECURRING_FEED',
                           'LICENSE', 'PRINT_BOOK', 'CARD_OR_BOXED', 'SERVICE')),
  CHECK (amount_cents >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS puzzle_economics_unique
  ON puzzle_economics (project_id, format_key, product_class, component, source_claim_id);

CREATE INDEX IF NOT EXISTS puzzle_economics_by_class
  ON puzzle_economics (project_id, format_key, product_class);


CREATE TABLE IF NOT EXISTS puzzle_constraints (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  kind             TEXT NOT NULL,
  subject          TEXT NOT NULL,
  statement        TEXT NOT NULL,
  authority        TEXT,
  source_claim_id  TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  seq              BIGSERIAL,
  CHECK (kind IN ('COPYRIGHT', 'TRADEMARK', 'PLATFORM_RULE', 'SAFETY_STANDARD',
                  'ACCESSIBILITY_RULE', 'CONTRACT_TERM'))
);

CREATE UNIQUE INDEX IF NOT EXISTS puzzle_constraints_unique
  ON puzzle_constraints (project_id, kind, subject, source_claim_id);


CREATE TABLE IF NOT EXISTS puzzle_rounds (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id),
  cash_mode_id   TEXT NOT NULL REFERENCES cash_modes(id),
  purpose        TEXT NOT NULL,
  format_key     TEXT,
  product_class  TEXT,
  candidate_id   TEXT NOT NULL,
  round          INTEGER NOT NULL,
  state          TEXT NOT NULL,
  found          INTEGER,
  created_at     TEXT NOT NULL,
  settled_at     TEXT,
  seq            BIGSERIAL,
  CHECK (purpose IN ('SEED_FORMATS', 'DEMAND', 'CHANNEL', 'PRODUCTION',
                     'ECONOMICS', 'RIGHTS')),
  CHECK (state IN ('OPEN', 'SETTLED')),
  CHECK (round >= 1),
  CHECK ((state = 'SETTLED') = (settled_at IS NOT NULL)),
  CHECK ((state = 'SETTLED') = (found IS NOT NULL)),
  CHECK (purpose = 'SEED_FORMATS' OR format_key IS NOT NULL),
  CHECK ((purpose = 'ECONOMICS') = (product_class IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS puzzle_rounds_unique
  ON puzzle_rounds (project_id, purpose, format_key, product_class, round);

CREATE UNIQUE INDEX IF NOT EXISTS puzzle_rounds_by_candidate
  ON puzzle_rounds (candidate_id);


CREATE TABLE IF NOT EXISTS puzzle_observations (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id),
  kind                TEXT NOT NULL,
  format_key          TEXT,
  product_id          TEXT,
  monetization_route  TEXT,
  statement           TEXT NOT NULL,
  recorded_by         TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  seq                 BIGSERIAL,
  CHECK (kind IN ('SUBMISSION_ACCEPTED', 'SUBMISSION_REJECTED', 'SALE', 'NO_SALE',
                  'CUSTOMER_COMPLAINT', 'DEFECT_FOUND', 'CHANNEL_TERMS_CHANGED',
                  'PRODUCTION_RESULT', 'ROUTE_REJECTED', 'HUMAN_EDIT_PASSED',
                  'HUMAN_EDIT_FAILED', 'PLAYTEST_RESULT'))
);

CREATE INDEX IF NOT EXISTS puzzle_observations_by_project
  ON puzzle_observations (project_id, created_at);


-- The fourth declaration axis on `research_claims`. See SQLite 088 for why it
-- is four columns rather than more values in an existing one.
ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS puzzle_finding TEXT;
ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS puzzle_subject TEXT;
ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS puzzle_format TEXT;
ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS puzzle_product_class TEXT;
ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS puzzle_value TEXT;
ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS puzzle_amount_cents INTEGER;
ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS puzzle_currency TEXT;

-- §45's backstop, on the backend that is deployed: the SQLite column carries
-- this inline and a Postgres column with nothing on it is the asymmetry that
-- section is written from.
--
-- Stated plainly rather than inside a `DO $$ … END $$` existence guard, which
-- is how this was first written and which **fails outright**: `splitStatements`
-- and `toPostgresSql` both walk a script character by character, neither knows
-- what a dollar-quoted body is, and the first `;` inside one ends the statement
-- — `unterminated dollar-quoted string at or near "$$"`, on a chain the whole
-- SQLite suite had just passed. §25 again, at a construct rather than a column.
--
-- The guard bought nothing in any case. A migration is applied exactly once,
-- in its own transaction, with its checksum recorded, so asking whether the
-- constraint is already there is asking the runner's own guarantee back.
ALTER TABLE research_claims
  ADD CONSTRAINT research_claims_puzzle_amount_check
  CHECK (puzzle_amount_cents IS NULL OR puzzle_amount_cents >= 0);
