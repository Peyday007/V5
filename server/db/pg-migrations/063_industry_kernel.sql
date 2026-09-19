-- The Postgres half of SQLite migration 072. See that file for why the map is
-- discovered rather than declared, why a structural finding is declared by
-- whoever read the source, why nothing derivable is stored, and why an unknown
-- amount withholds the minimum rather than lowering it.
--
-- Every table here carries `seq BIGSERIAL`, which is the identity column
-- `dialect.ts` rewrites `rowid` to. §25 and §27 both record what its absence
-- costs: a tiebreak on a column only one dialect has passes the whole SQLite
-- suite and throws in production.

CREATE TABLE IF NOT EXISTS industry_nodes (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  parent_id       TEXT REFERENCES industry_nodes(id),
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
  CHECK (kind IN ('SECTOR', 'SUB_INDUSTRY', 'VALUE_CHAIN_LAYER', 'BUYER_TYPE',
                  'FULFILMENT_SOURCE', 'TRANSACTION_TYPE', 'BOTTLENECK',
                  'ADJACENT_INDUSTRY')),
  CHECK (origin IN ('SEED', 'BOOTSTRAP', 'DISCOVERED')),
  CHECK (origin = 'SEED' OR source_claim_id IS NOT NULL),
  CHECK ((retired_at IS NULL) = (retired_reason IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_industry_nodes_child
  ON industry_nodes(project_id, parent_id, name) WHERE parent_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_industry_nodes_root
  ON industry_nodes(project_id, name) WHERE parent_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_industry_nodes_project
  ON industry_nodes(project_id, kind);

CREATE INDEX IF NOT EXISTS idx_industry_nodes_parent
  ON industry_nodes(parent_id);


CREATE TABLE IF NOT EXISTS industry_rounds (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id),
  cash_mode_id   TEXT NOT NULL,
  node_id        TEXT REFERENCES industry_nodes(id),
  purpose        TEXT NOT NULL,
  bucket_id      TEXT,
  opportunity_id TEXT REFERENCES cash_opportunities(id),
  round          INTEGER NOT NULL,
  candidate_id   TEXT NOT NULL,
  state          TEXT NOT NULL,
  opened_at      TEXT NOT NULL,
  harvested_at   TEXT,
  found          INTEGER,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  seq            BIGSERIAL,
  CHECK (purpose IN ('BOOTSTRAP', 'MAP', 'SCAN', 'CAPITAL')),
  CHECK (state IN ('OPEN', 'HARVESTED', 'ABANDONED')),
  CHECK (round >= 1),
  CHECK ((purpose = 'BOOTSTRAP') = (node_id IS NULL)),
  CHECK ((purpose = 'SCAN') = (bucket_id IS NOT NULL)),
  CHECK ((purpose = 'CAPITAL') = (opportunity_id IS NOT NULL)),
  CHECK (state = 'OPEN' OR found IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_industry_rounds_ask
  ON industry_rounds(project_id, COALESCE(node_id, '-'), purpose,
                     COALESCE(bucket_id, '-'), COALESCE(opportunity_id, '-'), round);

CREATE UNIQUE INDEX IF NOT EXISTS idx_industry_rounds_candidate
  ON industry_rounds(candidate_id);

CREATE INDEX IF NOT EXISTS idx_industry_rounds_project
  ON industry_rounds(project_id, state);


CREATE TABLE IF NOT EXISTS capital_structures (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  opportunity_id  TEXT NOT NULL REFERENCES cash_opportunities(id),
  entry_kind      TEXT NOT NULL,
  requirement     TEXT,
  mechanism       TEXT,
  answers_id      TEXT REFERENCES capital_structures(id),
  amount_cents    INTEGER,
  residual_cents  INTEGER,
  statement       TEXT NOT NULL,
  source_claim_id TEXT NOT NULL REFERENCES research_claims(id),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  seq             BIGSERIAL,
  CHECK (entry_kind IN ('REQUIREMENT', 'RESTRUCTURING')),
  CHECK (requirement IS NULL OR requirement IN (
           'LABOR', 'EQUIPMENT', 'PROPERTY', 'INVENTORY', 'LICENSING',
           'CUSTOMER_ACQUISITION', 'WORKING_CAPITAL', 'DEPOSIT', 'INSURANCE',
           'COMPLIANCE', 'FULFILMENT', 'TRANSPORT', 'STORAGE', 'TECHNOLOGY',
           'MINIMUM_ORDER', 'GUARANTEE')),
  CHECK (mechanism IS NULL OR mechanism IN (
           'SUBCONTRACT', 'BROKERAGE', 'AGENCY', 'CUSTOMER_DEPOSIT',
           'MILESTONE_BILLING', 'PRESALE', 'PURCHASE_ORDER_FINANCE',
           'RECEIVABLES_FINANCE', 'SUPPLIER_CREDIT', 'CONSIGNMENT', 'LEASE',
           'RENTAL', 'LICENSE_IN', 'REVENUE_SHARE', 'JOINT_VENTURE',
           'PROJECT_FINANCE', 'OFFTAKE', 'DISTRIBUTION_ADVANCE',
           'GOVERNMENT_INCENTIVE', 'CAPACITY_RESERVATION',
           'MANAGEMENT_CONTRACT', 'CONTRACT_MANUFACTURE',
           'THIRD_PARTY_LOGISTICS', 'WHITE_LABEL', 'MARKETPLACE')),
  CHECK (amount_cents IS NULL OR amount_cents >= 0),
  CHECK (residual_cents IS NULL OR residual_cents >= 0),
  CHECK ((entry_kind = 'REQUIREMENT') = (requirement IS NOT NULL)),
  CHECK ((entry_kind = 'RESTRUCTURING') = (mechanism IS NOT NULL)),
  CHECK (entry_kind = 'REQUIREMENT' OR answers_id IS NOT NULL),
  CHECK (entry_kind = 'RESTRUCTURING' OR residual_cents IS NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_capital_claim
  ON capital_structures(opportunity_id, source_claim_id);

CREATE INDEX IF NOT EXISTS idx_capital_opportunity
  ON capital_structures(opportunity_id, entry_kind);


CREATE TABLE IF NOT EXISTS opportunity_constraints (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  opportunity_id  TEXT REFERENCES cash_opportunities(id),
  node_id         TEXT REFERENCES industry_nodes(id),
  kind            TEXT NOT NULL,
  statement       TEXT NOT NULL,
  effect          TEXT,
  source_claim_id TEXT NOT NULL REFERENCES research_claims(id),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  seq             BIGSERIAL,
  CHECK (kind IN (
           'CYCLE_LONGER_THAN_STATED', 'SUBCONTRACTING_PROHIBITED',
           'CREDENTIAL_REQUIRED', 'PRIOR_WORK_REQUIRED', 'SUPERVISION_CEILING',
           'SECURITY_RESTRICTION', 'BUYER_CONCENTRATION',
           'MARGIN_ERODED_BY_REWORK', 'PAYMENT_ON_FINAL_ACCEPTANCE',
           'BONDING_OR_INSURANCE', 'REGULATORY_CAPITAL',
           'ARBITRAGE_LOST_TO_OVERHEAD', 'PLATFORM_TERMS',
           'SUPPLY_UNAVAILABLE')),
  CHECK ((opportunity_id IS NULL) <> (node_id IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_constraint_claim
  ON opportunity_constraints(source_claim_id, kind);

CREATE INDEX IF NOT EXISTS idx_constraint_opportunity
  ON opportunity_constraints(opportunity_id);

CREATE INDEX IF NOT EXISTS idx_constraint_node
  ON opportunity_constraints(node_id);


ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS structural_finding TEXT;
ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS structural_subject TEXT;

ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS structural_qualifier TEXT;
ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS structural_amount_cents INTEGER;

ALTER TABLE cash_opportunities ADD COLUMN IF NOT EXISTS industry_node_id TEXT;

CREATE INDEX IF NOT EXISTS idx_opportunities_node
  ON cash_opportunities(industry_node_id);
