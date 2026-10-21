-- The commerce kernel (§73). SQLite's 124_commerce_kernel.sql has the
-- reasoning for every column; this is the same schema in this dialect, with
-- the `seq` identity column `dialect.ts` rewrites `rowid` to and the CHECKs
-- written at the end of each table.

CREATE TABLE IF NOT EXISTS commerce_programmes (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  objective   TEXT NOT NULL,
  state       TEXT NOT NULL,
  started_by  TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  seq         BIGSERIAL,
  CHECK (state IN ('ACTIVE', 'PAUSED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS commerce_programmes_by_project
  ON commerce_programmes (project_id);


CREATE TABLE IF NOT EXISTS commerce_products (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  name             TEXT NOT NULL,
  product_key      TEXT NOT NULL,
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

CREATE UNIQUE INDEX IF NOT EXISTS commerce_products_unique
  ON commerce_products (project_id, product_key);


CREATE TABLE IF NOT EXISTS commerce_facts (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  product_id       TEXT NOT NULL REFERENCES commerce_products(id),
  finding          TEXT NOT NULL,
  subject          TEXT NOT NULL,
  value            TEXT,
  amount_cents     INTEGER,
  rate_bps         INTEGER,
  currency         TEXT,
  days             INTEGER,
  statement        TEXT NOT NULL,
  publisher        TEXT,
  observed_on      TEXT,
  source_claim_id  TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  seq              BIGSERIAL,
  CHECK (finding IN ('PRODUCT_DEMAND', 'RETAIL_PRICE', 'SUPPLIER_OFFER', 'COST_LINE',
                     'COMPETITOR', 'CUSTOMER_COMPLAINT', 'NICHE_SIGNAL', 'RESTRICTION')),
  CHECK (amount_cents IS NULL OR amount_cents >= 0),
  CHECK (rate_bps IS NULL OR (rate_bps >= 0 AND rate_bps <= 10000)),
  CHECK (days IS NULL OR days >= 0),
  CHECK (amount_cents IS NULL OR rate_bps IS NULL),
  CHECK (amount_cents IS NULL OR currency IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS commerce_facts_by_claim
  ON commerce_facts (source_claim_id);

CREATE INDEX IF NOT EXISTS commerce_facts_by_product
  ON commerce_facts (project_id, product_id, finding);


CREATE TABLE IF NOT EXISTS commerce_rounds (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id),
  cash_mode_id   TEXT NOT NULL REFERENCES cash_modes(id),
  purpose        TEXT NOT NULL,
  product_key    TEXT,
  candidate_id   TEXT NOT NULL,
  round          INTEGER NOT NULL,
  state          TEXT NOT NULL,
  found          INTEGER,
  created_at     TEXT NOT NULL,
  settled_at     TEXT,
  seq            BIGSERIAL,
  CHECK (purpose IN ('DISCOVER', 'SOURCE', 'PRICE', 'COSTS', 'NICHE')),
  CHECK (state IN ('OPEN', 'SETTLED', 'ABANDONED')),
  CHECK (round >= 1),
  CHECK ((state = 'OPEN') = (settled_at IS NULL)),
  CHECK ((state = 'OPEN') = (found IS NULL)),
  CHECK (purpose = 'DISCOVER' OR product_key IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS commerce_rounds_unique
  ON commerce_rounds (project_id, purpose, COALESCE(product_key, ''), round);

CREATE UNIQUE INDEX IF NOT EXISTS commerce_rounds_by_candidate
  ON commerce_rounds (candidate_id);


ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS commerce_finding TEXT;
ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS commerce_product TEXT;
ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS commerce_subject TEXT;
ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS commerce_value TEXT;
ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS commerce_amount_cents INTEGER;
ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS commerce_rate_bps INTEGER;
ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS commerce_currency TEXT;
ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS commerce_days INTEGER;

-- The same backstops the SQLite columns carry inline (§45: a constraint that
-- exists only on the backend nobody deploys is not a backstop).
ALTER TABLE research_claims
  ADD CONSTRAINT research_claims_commerce_amount_check
  CHECK (commerce_amount_cents IS NULL OR commerce_amount_cents >= 0);
ALTER TABLE research_claims
  ADD CONSTRAINT research_claims_commerce_rate_check
  CHECK (commerce_rate_bps IS NULL OR (commerce_rate_bps >= 0 AND commerce_rate_bps <= 10000));
ALTER TABLE research_claims
  ADD CONSTRAINT research_claims_commerce_days_check
  CHECK (commerce_days IS NULL OR commerce_days >= 0);
