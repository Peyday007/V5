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

-- ---------------------------------------------------------------------------
-- THE LAUNCH (§74): what Brain did in the owner's own store, ad account and
-- supplier account for a qualified product.
--
-- These rows hold external identities and the state of external processes —
-- a listing's product id, a campaign's id, a supplier order's id — which no
-- derivation could recover. Nothing here holds a credential, and no customer's
-- address is stored: an order's address is read from the store at the moment
-- the supplier order is placed.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS commerce_launches (
  id                       TEXT PRIMARY KEY,
  project_id               TEXT NOT NULL REFERENCES projects(id),
  product_id               TEXT NOT NULL REFERENCES commerce_products(id),
  supplier_product_id      TEXT,
  supplier_variant_id      TEXT,
  supplier_name            TEXT,
  supplier_unit_cents      INTEGER CHECK (supplier_unit_cents IS NULL OR supplier_unit_cents > 0),
  supplier_shipping_cents  INTEGER CHECK (supplier_shipping_cents IS NULL OR supplier_shipping_cents >= 0),
  supplier_logistic        TEXT,
  supplier_max_days        INTEGER,
  supplier_image_url       TEXT,
  matched_at               TEXT,
  price_cents              INTEGER CHECK (price_cents IS NULL OR price_cents > 0),
  currency                 TEXT,
  store_product_id         TEXT,
  store_variant_id         TEXT,
  store_handle             TEXT,
  listed_at                TEXT,
  published_at             TEXT,
  -- What stands in the way right now, in a sentence the server composed.
  problem                  TEXT,
  stopped_at               TEXT,
  stop_reason              TEXT,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS commerce_launches_by_product
  ON commerce_launches (product_id);

CREATE TABLE IF NOT EXISTS commerce_ad_tests (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id),
  launch_id           TEXT NOT NULL REFERENCES commerce_launches(id),
  round               INTEGER NOT NULL CHECK (round >= 1),
  commitment_id       TEXT,
  daily_budget_cents  INTEGER NOT NULL CHECK (daily_budget_cents > 0),
  days                INTEGER NOT NULL CHECK (days > 0),
  campaign_id         TEXT,
  started_at          TEXT,
  ends_at             TEXT,
  spend_cents         INTEGER,
  state               TEXT NOT NULL CHECK (state IN ('PENDING', 'RUNNING', 'STOPPED', 'ENDED', 'UNCERTAIN')),
  outcome             TEXT CHECK (outcome IS NULL OR outcome IN ('WON', 'LOST')),
  stop_reason         TEXT,
  settled_at          TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS commerce_ad_tests_round
  ON commerce_ad_tests (launch_id, round);

CREATE TABLE IF NOT EXISTS commerce_orders (
  id                     TEXT PRIMARY KEY,
  project_id             TEXT NOT NULL REFERENCES projects(id),
  launch_id              TEXT NOT NULL REFERENCES commerce_launches(id),
  store_order_id         TEXT NOT NULL,
  store_order_name       TEXT NOT NULL,
  quantity               INTEGER NOT NULL CHECK (quantity >= 1),
  amount_cents           INTEGER NOT NULL CHECK (amount_cents > 0),
  currency               TEXT NOT NULL,
  paid_at                TEXT NOT NULL,
  supplier_order_number  TEXT NOT NULL,
  supplier_order_id      TEXT,
  supplier_cost_cents    INTEGER,
  commitment_id          TEXT,
  tracking_number        TEXT,
  tracking_url           TEXT,
  carrier                TEXT,
  state                  TEXT NOT NULL CHECK (state IN ('PAID', 'ORDERED', 'SHIPPED', 'FULFILLED', 'NEEDS_PERSON')),
  problem                TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS commerce_orders_by_store_order
  ON commerce_orders (project_id, store_order_id);
CREATE UNIQUE INDEX IF NOT EXISTS commerce_orders_by_supplier_number
  ON commerce_orders (supplier_order_number);
