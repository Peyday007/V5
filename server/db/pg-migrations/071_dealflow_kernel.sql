-- The Postgres half of SQLite migration 080. See that file for why a deal has
-- two sides and a cash opportunity cannot express one, why every fact row
-- traces to a claim that cleared the gate, why the five compliance layers do
-- not collapse, why "nobody looked" needed a finding of its own, and why
-- nothing derivable is stored.
--
-- Every table here carries `seq BIGSERIAL`, which is the identity column
-- `dialect.ts` rewrites `rowid` to. §25 and §27 both record what its absence
-- costs: a tiebreak on a column only one dialect has passes the whole SQLite
-- suite and throws in production.

CREATE TABLE IF NOT EXISTS deal_parties (
  id                      TEXT PRIMARY KEY,
  project_id              TEXT NOT NULL REFERENCES projects(id),
  kind                    TEXT NOT NULL,
  name                    TEXT NOT NULL,
  country                 TEXT,
  equipment_class         TEXT NOT NULL,
  equipment_key           TEXT NOT NULL,
  note                    TEXT,
  decision_maker          TEXT,
  decision_maker_claim_id TEXT,
  origin                  TEXT NOT NULL,
  source_claim_id         TEXT,
  retired_at              TEXT,
  retired_reason          TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  seq                     BIGSERIAL,
  CHECK (kind IN ('BUYER', 'SUPPLIER')),
  CHECK (origin IN ('SEED', 'DISCOVERED')),
  CHECK (origin = 'SEED' OR source_claim_id IS NOT NULL),
  CHECK ((decision_maker IS NULL) = (decision_maker_claim_id IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_deal_parties_identity
  ON deal_parties(project_id, kind, name, equipment_key);

CREATE INDEX IF NOT EXISTS idx_deal_parties_class
  ON deal_parties(project_id, equipment_key, kind);


CREATE TABLE IF NOT EXISTS deal_requirements (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  destination     TEXT NOT NULL,
  equipment_class TEXT NOT NULL,
  equipment_key   TEXT NOT NULL,
  layer           TEXT NOT NULL,
  posture         TEXT NOT NULL,
  statement       TEXT NOT NULL,
  authority       TEXT,
  effective_date  TEXT,
  source_claim_id TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  seq             BIGSERIAL,
  CHECK (layer IN ('FACTORY_CERTIFICATION', 'PRODUCT_CERTIFICATION',
                   'MARKET_APPROVAL', 'BUYER_ACCEPTANCE', 'IMPORT_BARRIER')),
  CHECK (posture IN ('REQUIRED', 'NONE_FOUND', 'PROHIBITED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_deal_requirements_claim
  ON deal_requirements(source_claim_id, layer);

CREATE INDEX IF NOT EXISTS idx_deal_requirements_envelope
  ON deal_requirements(project_id, equipment_key, destination, layer);


CREATE TABLE IF NOT EXISTS deal_costs (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  equipment_class TEXT NOT NULL,
  equipment_key   TEXT NOT NULL,
  origin_country  TEXT,
  destination     TEXT,
  component       TEXT NOT NULL,
  amount_cents    INTEGER NOT NULL,
  currency        TEXT NOT NULL,
  basis           TEXT NOT NULL,
  source_claim_id TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  seq             BIGSERIAL,
  CHECK (component IN (
           'FACTORY_PRICE', 'INLAND_ORIGIN', 'EXPORT_HANDLING', 'OCEAN_FREIGHT',
           'INSURANCE', 'IMPORT_DUTY', 'IMPORT_TAX', 'CUSTOMS_CLEARANCE',
           'INLAND_DESTINATION', 'INSPECTION', 'CERTIFICATION_COST',
           'FINANCING_COST', 'BUYER_ALTERNATIVE')),
  CHECK (amount_cents >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_deal_costs_claim
  ON deal_costs(source_claim_id, component);

CREATE INDEX IF NOT EXISTS idx_deal_costs_lane
  ON deal_costs(project_id, equipment_key, destination);


CREATE TABLE IF NOT EXISTS deal_structure_evidence (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  equipment_class TEXT NOT NULL,
  equipment_key   TEXT NOT NULL,
  structure       TEXT NOT NULL,
  statement       TEXT NOT NULL,
  rate_note       TEXT,
  source_claim_id TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  seq             BIGSERIAL,
  CHECK (structure IN (
           'REFERRAL_COMMISSION', 'SALES_REPRESENTATION', 'SOURCING_FEE',
           'PROCUREMENT_FEE', 'BROKER_COMMISSION', 'BUYER_SIDE_REPRESENTATION',
           'SUPPLIER_SIDE_REPRESENTATION', 'TRADING_COMPANY_MARKUP',
           'LOGISTICS_COORDINATION_FEE', 'INSPECTION_COORDINATION',
           'SPARE_PARTS_SUPPLY', 'AFTER_SALES_COORDINATION',
           'RECURRING_PROCUREMENT'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_deal_structure_claim
  ON deal_structure_evidence(source_claim_id, structure);

CREATE INDEX IF NOT EXISTS idx_deal_structure_class
  ON deal_structure_evidence(project_id, equipment_key);


CREATE TABLE IF NOT EXISTS deals (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id),
  buyer_party_id    TEXT NOT NULL REFERENCES deal_parties(id),
  supplier_party_id TEXT NOT NULL REFERENCES deal_parties(id),
  equipment_class   TEXT NOT NULL,
  equipment_key     TEXT NOT NULL,
  opportunity_id    TEXT REFERENCES cash_opportunities(id),
  blocked_reason    TEXT,
  outcome           TEXT,
  outcome_note      TEXT,
  outcome_at        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  seq               BIGSERIAL,
  CHECK (buyer_party_id <> supplier_party_id),
  CHECK ((outcome IS NULL) = (outcome_at IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_deals_pair
  ON deals(buyer_party_id, supplier_party_id, equipment_key);

CREATE INDEX IF NOT EXISTS idx_deals_project
  ON deals(project_id, equipment_key);

CREATE INDEX IF NOT EXISTS idx_deals_opportunity
  ON deals(opportunity_id);


CREATE TABLE IF NOT EXISTS deal_rounds (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  cash_mode_id    TEXT NOT NULL,
  purpose         TEXT NOT NULL,
  equipment_key   TEXT,
  equipment_class TEXT,
  destination     TEXT,
  party_id        TEXT REFERENCES deal_parties(id),
  deal_id         TEXT REFERENCES deals(id),
  round           INTEGER NOT NULL,
  candidate_id    TEXT NOT NULL,
  state           TEXT NOT NULL,
  opened_at       TEXT NOT NULL,
  harvested_at    TEXT,
  found           INTEGER,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  seq             BIGSERIAL,
  CHECK (purpose IN ('SEED_EQUIPMENT', 'DEMAND', 'SUPPLY', 'COMPLIANCE',
                     'LANDED_COST', 'STRUCTURE', 'DECISION_MAKER', 'ADJACENT')),
  CHECK (state IN ('OPEN', 'SETTLED')),
  CHECK (round >= 1),
  CHECK ((purpose = 'SEED_EQUIPMENT') = (equipment_key IS NULL)),
  CHECK ((equipment_key IS NULL) = (equipment_class IS NULL)),
  CHECK (purpose NOT IN ('COMPLIANCE', 'LANDED_COST') OR destination IS NOT NULL),
  CHECK (purpose NOT IN ('DECISION_MAKER', 'ADJACENT') OR party_id IS NOT NULL),
  CHECK (state = 'OPEN' OR found IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_deal_rounds_ask
  ON deal_rounds(project_id, purpose, COALESCE(equipment_key, '-'),
                 COALESCE(destination, '-'), COALESCE(party_id, '-'), round);

CREATE UNIQUE INDEX IF NOT EXISTS idx_deal_rounds_candidate
  ON deal_rounds(candidate_id);

CREATE INDEX IF NOT EXISTS idx_deal_rounds_project
  ON deal_rounds(project_id, state);


CREATE TABLE IF NOT EXISTS deal_observations (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  deal_id         TEXT REFERENCES deals(id),
  kind            TEXT NOT NULL,
  jurisdiction    TEXT,
  equipment_key   TEXT,
  statement       TEXT NOT NULL,
  recorded_by     TEXT NOT NULL,
  source_claim_id TEXT,
  created_at      TEXT NOT NULL,
  seq             BIGSERIAL,
  CHECK (kind IN (
           'BUYER_RESPONDED', 'BUYER_IGNORED', 'SUPPLIER_ENGAGED',
           'SUPPLIER_REFUSED', 'PRICE_DISCREPANCY', 'CERTIFICATION_SURPRISE',
           'LOGISTICS_SURPRISE', 'PAYMENT_PREFERENCE', 'COMMISSION_ACCEPTED',
           'COMMISSION_REFUSED', 'FALSE_SIGNAL', 'CYCLE_LENGTH'))
);

CREATE INDEX IF NOT EXISTS idx_deal_observations_scope
  ON deal_observations(project_id, kind, equipment_key);

CREATE INDEX IF NOT EXISTS idx_deal_observations_deal
  ON deal_observations(deal_id);


ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS deal_finding TEXT;
ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS deal_subject TEXT;
ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS deal_equipment TEXT;
ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS deal_jurisdiction TEXT;
ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS deal_value TEXT;
ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS deal_amount_cents INTEGER;

-- The same backstop the SQLite column carries.
--
-- `validateDealFinding` refuses a negative at both submission doors, so this
-- only catches a path around them — which is exactly why it has to exist on
-- the backend the deployed Brain runs on rather than on the one every test
-- run happens to use. The first version of this file had the CHECK on the
-- SQLite column and not this one: a constraint present in the chain nobody
-- deploys is a guard that reads as installed and is not. §3's rule that a
-- schema change is not done until both chains have it, at a constraint.
--
-- Named explicitly, because `ADD CONSTRAINT` has no `IF NOT EXISTS` in
-- Postgres 16 and a named constraint is the only thing a later migration
-- could address.
ALTER TABLE research_claims
  ADD CONSTRAINT research_claims_deal_amount_cents_check
  CHECK (deal_amount_cents IS NULL OR deal_amount_cents >= 0);

ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS deal_currency TEXT;
