-- The Postgres half of SQLite migration 084. See that file for why required
-- capital is a table rather than a thirteenth barrier kind, why identifying an
-- acquisition is research while every effect that follows from one is not, and
-- why a decision nobody has made is a row in the OPEN state rather than a
-- concern quietly dropped.
--
-- Every table here carries `seq BIGSERIAL`, which is the identity column
-- `dialect.ts` rewrites `rowid` to. §25, §27 and §34 each record what its
-- absence costs: a tiebreak on a column only one dialect has passes the whole
-- SQLite suite and throws in production.

ALTER TABLE manufacturing_programs ADD COLUMN IF NOT EXISTS blueprint_path TEXT;
ALTER TABLE manufacturing_programs ADD COLUMN IF NOT EXISTS blueprint_sha256 TEXT;


CREATE TABLE IF NOT EXISTS category_capital (
  id                 TEXT PRIMARY KEY,
  program_id         TEXT NOT NULL REFERENCES manufacturing_programs(id),
  category_id        TEXT NOT NULL REFERENCES machine_categories(id),
  requirement        TEXT NOT NULL,
  scenario           TEXT NOT NULL,
  amount_low_minor   BIGINT,
  amount_high_minor  BIGINT,
  currency           TEXT,
  basis              TEXT NOT NULL,
  as_of              TEXT NOT NULL,
  statement          TEXT NOT NULL,
  source_claim_id    TEXT NOT NULL REFERENCES research_claims(id),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  seq                BIGSERIAL,
  CHECK (requirement IN ('TOOLING_AND_EQUIPMENT', 'FACILITY', 'CERTIFICATION_AND_APPROVAL',
                         'ENGINEERING_AND_DEVELOPMENT', 'WORKING_CAPITAL', 'INVENTORY_AND_PARTS',
                         'SUPPLIER_ONBOARDING', 'DISTRIBUTION_AND_SERVICE_NETWORK',
                         'INTELLECTUAL_PROPERTY_OR_LICENCE', 'TEST_AND_VALIDATION')),
  CHECK (scenario IN ('SMALLEST_CREDIBLE_ENTRY', 'TYPICAL_ENTRY', 'AT_PRODUCTION_SCALE')),
  CHECK (basis IN ('PUBLISHED_PRICE_OR_SCHEDULE', 'REGULATORY_FEE_SCHEDULE',
                   'COMPARABLE_FIRM_DISCLOSURE', 'TRADE_PUBLICATION_ESTIMATE',
                   'ANALYST_OR_MARKET_ESTIMATE')),
  CHECK (amount_low_minor IS NULL OR amount_low_minor >= 0),
  CHECK (amount_high_minor IS NULL OR amount_high_minor >= 0),
  CHECK ((amount_low_minor IS NULL) = (amount_high_minor IS NULL)),
  CHECK (amount_low_minor IS NULL OR amount_high_minor >= amount_low_minor),
  CHECK ((amount_low_minor IS NULL) = (currency IS NULL)),
  CHECK (currency IS NULL OR length(currency) = 3)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_category_capital_claim
  ON category_capital(source_claim_id);

CREATE INDEX IF NOT EXISTS idx_category_capital_category
  ON category_capital(category_id, scenario);

CREATE INDEX IF NOT EXISTS idx_category_capital_program
  ON category_capital(program_id, requirement);


CREATE TABLE IF NOT EXISTS acquisition_candidates (
  id               TEXT PRIMARY KEY,
  program_id       TEXT NOT NULL REFERENCES manufacturing_programs(id),
  category_id      TEXT REFERENCES machine_categories(id),
  capability_id    TEXT REFERENCES capabilities(id),
  name             TEXT NOT NULL,
  contribution     TEXT NOT NULL,
  statement        TEXT NOT NULL,
  source_claim_id  TEXT NOT NULL REFERENCES research_claims(id),
  set_aside_at     TEXT,
  set_aside_reason TEXT,
  set_aside_by     TEXT REFERENCES users(id),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  seq              BIGSERIAL,
  CHECK (contribution IN ('CAPABILITY', 'PRODUCTION_CAPACITY', 'DISTRIBUTION_OR_DEALER_NETWORK',
                          'SUPPLY_OR_COMPONENT_SOURCE', 'CERTIFICATION_OR_APPROVAL',
                          'INTELLECTUAL_PROPERTY', 'ENGINEERING_TEAM', 'BRAND_OR_MARKET_POSITION')),
  CHECK (category_id IS NOT NULL OR capability_id IS NOT NULL),
  CHECK ((set_aside_at IS NULL) = (set_aside_reason IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_acquisition_claim
  ON acquisition_candidates(source_claim_id);

CREATE INDEX IF NOT EXISTS idx_acquisition_program
  ON acquisition_candidates(program_id, contribution);

CREATE INDEX IF NOT EXISTS idx_acquisition_category
  ON acquisition_candidates(category_id);


CREATE TABLE IF NOT EXISTS programme_decisions (
  id           TEXT PRIMARY KEY,
  program_id   TEXT NOT NULL REFERENCES manufacturing_programs(id),
  topic        TEXT NOT NULL,
  state        TEXT NOT NULL,
  resolution   TEXT,
  resolved_at  TEXT,
  resolved_by  TEXT REFERENCES users(id),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  seq          BIGSERIAL,
  CHECK (topic IN ('MASTER_BRAND_ARCHITECTURE')),
  CHECK (state IN ('OPEN', 'RESOLVED')),
  CHECK ((state = 'RESOLVED') = (resolution IS NOT NULL)),
  CHECK ((resolution IS NULL) = (resolved_at IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_programme_decisions_topic
  ON programme_decisions(program_id, topic);


ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS capability_qualifier TEXT;
ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS capability_amount_low_minor BIGINT;
ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS capability_amount_high_minor BIGINT;
ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS capability_currency TEXT;
ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS capability_basis TEXT;

ALTER TABLE research_claims ADD CONSTRAINT research_claims_capability_amount_low_minor_check
  CHECK (capability_amount_low_minor IS NULL OR capability_amount_low_minor >= 0);
ALTER TABLE research_claims ADD CONSTRAINT research_claims_capability_amount_high_minor_check
  CHECK (capability_amount_high_minor IS NULL OR capability_amount_high_minor >= 0);

-- Two more questions a round can ask. Named exactly as Postgres names an inline
-- column CHECK — the table plus the column the constraint mentions — and written
-- without `IF EXISTS` deliberately: §35 records what the tolerant form costs,
-- which is the old constraint left standing beside the new one and the first
-- write in production refused by something nobody is looking at.
ALTER TABLE manufacturing_rounds DROP CONSTRAINT manufacturing_rounds_purpose_check;
ALTER TABLE manufacturing_rounds ADD CONSTRAINT manufacturing_rounds_purpose_check
  CHECK (purpose IN ('BOOTSTRAP', 'MAP', 'DEMAND', 'CAPABILITY', 'INTEGRATION',
                     'CAPITAL', 'ACQUISITION'));
