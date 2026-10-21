-- ---------------------------------------------------------------------------
-- THE COMMERCE KERNEL (§73)
--
-- Products consumers are buying now, the suppliers that would ship them, and
-- what one order is worth after every cost a source published. It is the
-- research half of a dropshipping operation, and it needs no account anywhere:
-- every row here is either a person's decision or a fact a gated claim
-- established from a published source.
--
-- Four rules decided every column.
--
-- 1. A PERSON STARTS IT. `commerce_programmes` is the one row that lets the
--    kernel ask anything, and pressing start is the authorization: read-only
--    research, inside a Cash Mode sprint's own discovery grant. There is no
--    path by which Brain starts one for itself.
--
-- 2. THE PRODUCTS ARE DISCOVERED, NEVER DECLARED. There is no list of products
--    in this repository. A product exists because a gated claim named it or a
--    person seeded it, and `SEED` is the one origin Brain may never write.
--
-- 3. EVERY FACT TRACES TO A CLAIM THAT CLEARED THE GATE. `source_claim_id` is
--    NOT NULL and unique on `commerce_facts`, so one claim is one fact and a
--    re-read writes nothing.
--
-- 4. WHAT CAN BE DERIVED IS NOT STORED. There is no margin, no maturity, no
--    rank and no verdict column. Every one is read from these rows on the read
--    path, because a stored verdict is stale the moment a new figure arrives.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS commerce_programmes (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  objective   TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('ACTIVE', 'PAUSED')),
  -- Who started it. A person's user id; never 'BRAIN'.
  started_by  TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS commerce_programmes_by_project
  ON commerce_programmes (project_id);


CREATE TABLE IF NOT EXISTS commerce_products (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  name             TEXT NOT NULL,
  -- Case and whitespace only. Products converge because every follow-up
  -- question names one verbatim from these rows, not because a matcher guesses.
  product_key      TEXT NOT NULL,
  note             TEXT,
  origin           TEXT NOT NULL CHECK (origin IN ('SEED', 'DISCOVERED')),
  source_claim_id  TEXT,
  -- Retired, never deleted: a deleted product arrives again on the next round
  -- as a fresh discovery and the allowance is spent learning it twice.
  retired_at       TEXT,
  retired_reason   TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  CHECK (origin = 'SEED' OR source_claim_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS commerce_products_unique
  ON commerce_products (project_id, product_key);


-- One row per gated claim that declared something about a product. One table
-- rather than one per finding, because every finding has the same shape — a
-- product, a named subject, an optional closed value and an optional figure —
-- and `finding` is the closed set that says which half of the arithmetic a row
-- belongs to.
CREATE TABLE IF NOT EXISTS commerce_facts (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  product_id       TEXT NOT NULL REFERENCES commerce_products(id),
  finding          TEXT NOT NULL
                     CHECK (finding IN ('PRODUCT_DEMAND', 'RETAIL_PRICE', 'SUPPLIER_OFFER',
                                        'COST_LINE', 'COMPETITOR', 'CUSTOMER_COMPLAINT',
                                        'NICHE_SIGNAL', 'RESTRICTION')),
  subject          TEXT NOT NULL,
  value            TEXT,
  amount_cents     INTEGER CHECK (amount_cents IS NULL OR amount_cents >= 0),
  rate_bps         INTEGER CHECK (rate_bps IS NULL OR (rate_bps >= 0 AND rate_bps <= 10000)),
  currency         TEXT,
  days             INTEGER CHECK (days IS NULL OR days >= 0),
  statement        TEXT NOT NULL,
  publisher        TEXT,
  observed_on      TEXT,
  source_claim_id  TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  -- A figure and a percentage are never both on one row.
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
  purpose        TEXT NOT NULL
                   CHECK (purpose IN ('DISCOVER', 'SOURCE', 'PRICE', 'COSTS', 'NICHE')),
  product_key    TEXT,
  candidate_id   TEXT NOT NULL,
  round          INTEGER NOT NULL CHECK (round >= 1),
  state          TEXT NOT NULL CHECK (state IN ('OPEN', 'SETTLED', 'ABANDONED')),
  found          INTEGER,
  created_at     TEXT NOT NULL,
  settled_at     TEXT,
  CHECK ((state = 'OPEN') = (settled_at IS NULL)),
  CHECK ((state = 'OPEN') = (found IS NULL)),
  -- Only the broad question names no product; its whole job is to find them.
  CHECK (purpose = 'DISCOVER' OR product_key IS NOT NULL)
);

-- COALESCE, because a unique index over a NULL column constrains nothing:
-- two DISCOVER rounds with the same number would otherwise both commit.
CREATE UNIQUE INDEX IF NOT EXISTS commerce_rounds_unique
  ON commerce_rounds (project_id, purpose, COALESCE(product_key, ''), round);

CREATE UNIQUE INDEX IF NOT EXISTS commerce_rounds_by_candidate
  ON commerce_rounds (candidate_id);


-- The declaration a worker makes on a claim, validated exactly on submission
-- by `domain/commerce.ts` at both doors. Its own columns, for invariant 31:
-- a column with two masters is a column nobody can trust.
ALTER TABLE research_claims ADD COLUMN commerce_finding TEXT;
ALTER TABLE research_claims ADD COLUMN commerce_product TEXT;
ALTER TABLE research_claims ADD COLUMN commerce_subject TEXT;
ALTER TABLE research_claims ADD COLUMN commerce_value TEXT;
ALTER TABLE research_claims ADD COLUMN commerce_amount_cents INTEGER
  CHECK (commerce_amount_cents IS NULL OR commerce_amount_cents >= 0);
ALTER TABLE research_claims ADD COLUMN commerce_rate_bps INTEGER
  CHECK (commerce_rate_bps IS NULL OR (commerce_rate_bps >= 0 AND commerce_rate_bps <= 10000));
ALTER TABLE research_claims ADD COLUMN commerce_currency TEXT;
ALTER TABLE research_claims ADD COLUMN commerce_days INTEGER
  CHECK (commerce_days IS NULL OR commerce_days >= 0);
