-- The Postgres half of SQLite migration 074. See that file for why the
-- channels are discovered rather than declared, why a commerce finding is
-- declared by whoever read the source, why nothing derivable is stored, why an
-- unknown figure withholds the margin rather than lowering it, and why
-- attention has a kind of its own so it cannot be filed as demand.
--
-- Every table here carries `seq BIGSERIAL`, which is the identity column
-- `dialect.ts` rewrites `rowid` to. §25 and §27 both record what its absence
-- costs: a tiebreak on a column only one dialect has passes the whole SQLite
-- suite and throws in production.

CREATE TABLE IF NOT EXISTS commerce_channels (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  name            TEXT NOT NULL,
  description     TEXT,
  origin          TEXT NOT NULL,
  source_claim_id TEXT REFERENCES research_claims(id),
  retired_at      TEXT,
  retired_reason  TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  seq             BIGSERIAL,
  CHECK (origin IN ('SEED', 'DISCOVERED')),
  CHECK (origin = 'SEED' OR source_claim_id IS NOT NULL),
  CHECK ((retired_at IS NULL) = (retired_reason IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_commerce_channels_name
  ON commerce_channels(project_id, name);


CREATE TABLE IF NOT EXISTS commerce_propositions (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  cash_mode_id     TEXT NOT NULL,
  channel_id       TEXT NOT NULL REFERENCES commerce_channels(id),
  product          TEXT NOT NULL,
  audience         TEXT,
  supplier         TEXT,
  opportunity_id   TEXT REFERENCES cash_opportunities(id),
  industry_node_id TEXT REFERENCES industry_nodes(id),
  origin           TEXT NOT NULL,
  source_claim_id  TEXT REFERENCES research_claims(id),
  retired_at       TEXT,
  retired_reason   TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  seq              BIGSERIAL,
  CHECK (origin IN ('SEED', 'DISCOVERED')),
  CHECK (origin = 'SEED' OR source_claim_id IS NOT NULL),
  CHECK ((retired_at IS NULL) = (retired_reason IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_commerce_propositions_pair
  ON commerce_propositions(project_id, channel_id, product);

CREATE INDEX IF NOT EXISTS idx_commerce_propositions_project
  ON commerce_propositions(project_id);

CREATE INDEX IF NOT EXISTS idx_commerce_propositions_opportunity
  ON commerce_propositions(opportunity_id);


CREATE TABLE IF NOT EXISTS commerce_evidence (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  proposition_id  TEXT REFERENCES commerce_propositions(id),
  channel_id      TEXT REFERENCES commerce_channels(id),
  kind            TEXT NOT NULL,
  statement       TEXT NOT NULL,
  origin          TEXT NOT NULL,
  source_claim_id TEXT REFERENCES research_claims(id),
  test_id         TEXT,
  actor_ref       TEXT,
  amount_minor    INTEGER,
  rate_ppm        INTEGER,
  days            INTEGER,
  count_units     INTEGER,
  observed_at     TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  seq             BIGSERIAL,
  CHECK (origin IN ('CLAIM', 'TEST', 'PERSON')),
  CHECK (amount_minor IS NULL OR amount_minor >= 0),
  CHECK (rate_ppm IS NULL OR (rate_ppm >= 0 AND rate_ppm <= 1000000)),
  CHECK (days IS NULL OR days >= 0),
  CHECK (count_units IS NULL OR count_units >= 0),
  CHECK ((proposition_id IS NULL) <> (channel_id IS NULL)),
  CHECK ((origin = 'CLAIM') = (source_claim_id IS NOT NULL)),
  CHECK ((origin = 'TEST') = (test_id IS NOT NULL)),
  CHECK ((origin = 'PERSON') = (actor_ref IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_commerce_evidence_claim
  ON commerce_evidence(source_claim_id, kind) WHERE source_claim_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_commerce_evidence_proposition
  ON commerce_evidence(proposition_id, kind);

CREATE INDEX IF NOT EXISTS idx_commerce_evidence_channel
  ON commerce_evidence(channel_id, kind);


CREATE TABLE IF NOT EXISTS commerce_rounds (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id),
  cash_mode_id   TEXT NOT NULL,
  purpose        TEXT NOT NULL,
  channel_id     TEXT REFERENCES commerce_channels(id),
  proposition_id TEXT REFERENCES commerce_propositions(id),
  round          INTEGER NOT NULL,
  candidate_id   TEXT NOT NULL,
  state          TEXT NOT NULL,
  opened_at      TEXT NOT NULL,
  harvested_at   TEXT,
  found          INTEGER,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  seq            BIGSERIAL,
  CHECK (purpose IN ('CHANNELS', 'PRODUCTS', 'SUPPLY', 'ECONOMICS', 'ELIGIBILITY')),
  CHECK (state IN ('OPEN', 'HARVESTED', 'ABANDONED')),
  CHECK (round >= 1),
  CHECK ((purpose = 'CHANNELS') = (channel_id IS NULL AND proposition_id IS NULL)),
  CHECK ((purpose IN ('PRODUCTS', 'ELIGIBILITY')) = (channel_id IS NOT NULL)),
  CHECK ((purpose IN ('SUPPLY', 'ECONOMICS')) = (proposition_id IS NOT NULL)),
  CHECK (state = 'OPEN' OR found IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_commerce_rounds_ask
  ON commerce_rounds(project_id, purpose, COALESCE(channel_id, '-'),
                     COALESCE(proposition_id, '-'), round);

CREATE UNIQUE INDEX IF NOT EXISTS idx_commerce_rounds_candidate
  ON commerce_rounds(candidate_id);

CREATE INDEX IF NOT EXISTS idx_commerce_rounds_project
  ON commerce_rounds(project_id, state);


CREATE TABLE IF NOT EXISTS commerce_tests (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  proposition_id  TEXT NOT NULL REFERENCES commerce_propositions(id),
  state           TEXT NOT NULL,
  ceiling_minor   INTEGER NOT NULL,
  authority_id    TEXT,
  commitment_id   TEXT,
  blocker_kind    TEXT,
  blocker_detail  TEXT,
  stop_rule       TEXT NOT NULL,
  authorized_by   TEXT,
  opened_at       TEXT NOT NULL,
  settled_at      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  seq             BIGSERIAL,
  CHECK (state IN ('BLOCKED', 'AUTHORIZED', 'RUNNING', 'SETTLED', 'ABANDONED')),
  CHECK (ceiling_minor >= 0),
  CHECK ((state = 'BLOCKED') = (blocker_kind IS NOT NULL)),
  CHECK (state = 'BLOCKED' OR (authority_id IS NOT NULL AND authorized_by IS NOT NULL)),
  CHECK ((state = 'SETTLED') = (settled_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_commerce_tests_live
  ON commerce_tests(proposition_id)
  WHERE state IN ('BLOCKED', 'AUTHORIZED', 'RUNNING');

CREATE INDEX IF NOT EXISTS idx_commerce_tests_project
  ON commerce_tests(project_id, state);


ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS commerce_finding TEXT;
ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS commerce_subject TEXT;
ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS commerce_qualifier TEXT;
ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS commerce_amount_minor INTEGER;
ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS commerce_rate_ppm INTEGER;
ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS commerce_days INTEGER;
ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS commerce_count INTEGER;
