-- The Postgres half of SQLite migration 078. See that file for why the default
-- is a burden of proof rather than an assumption, why the favourable direction
-- of an unknown here is *towards Brain* and is refused, why `basis` has no
-- DERIVED value, and why both decision tables are append-only.
--
-- Every table here carries `seq BIGSERIAL`, which is the identity column
-- `dialect.ts` rewrites `rowid` to. §25 and §27 both record what its absence
-- costs: a tiebreak on a column only one dialect has passes the whole SQLite
-- suite and throws in production.

CREATE TABLE IF NOT EXISTS labor_workflows (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  name            TEXT NOT NULL,
  description     TEXT,
  origin          TEXT NOT NULL,
  opportunity_id  TEXT REFERENCES cash_opportunities(id),
  declared_by_ref TEXT,
  retired_at      TEXT,
  retired_reason  TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  seq             BIGSERIAL,
  CHECK (origin IN ('SEED', 'DERIVED')),
  CHECK (origin = 'SEED' OR opportunity_id IS NOT NULL),
  CHECK ((retired_at IS NULL) = (retired_reason IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_labor_workflows_name
  ON labor_workflows(project_id, name);

CREATE UNIQUE INDEX IF NOT EXISTS idx_labor_workflows_opportunity
  ON labor_workflows(opportunity_id) WHERE opportunity_id IS NOT NULL;


CREATE TABLE IF NOT EXISTS labor_tasks (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  workflow_id     TEXT NOT NULL REFERENCES labor_workflows(id),
  name            TEXT NOT NULL,
  output          TEXT NOT NULL,
  origin          TEXT NOT NULL,
  capability_id   TEXT,
  declared_by_ref TEXT,
  retired_at      TEXT,
  retired_reason  TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  seq             BIGSERIAL,
  CHECK (origin IN ('SEED', 'DERIVED')),
  CHECK (origin = 'SEED' OR capability_id IS NOT NULL),
  CHECK ((retired_at IS NULL) = (retired_reason IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_labor_tasks_name
  ON labor_tasks(workflow_id, name);

CREATE INDEX IF NOT EXISTS idx_labor_tasks_project
  ON labor_tasks(project_id);


CREATE TABLE IF NOT EXISTS labor_allocations (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  task_id          TEXT NOT NULL REFERENCES labor_tasks(id),
  production_layer TEXT NOT NULL,
  necessity_reason TEXT,
  decided_by       TEXT NOT NULL,
  decided_by_ref   TEXT,
  rationale        TEXT NOT NULL,
  supersedes_id    TEXT REFERENCES labor_allocations(id),
  superseded_at    TEXT,
  created_at       TEXT NOT NULL,
  seq              BIGSERIAL,
  CHECK (production_layer IN ('BRAIN', 'SOFTWARE_TOOL', 'EXTERNAL_SERVICE',
                              'OFFSHORE_HUMAN', 'DOMESTIC_HUMAN',
                              'SPECIALIST_PROFESSIONAL', 'PHYSICAL_OPERATOR')),
  CHECK (necessity_reason IS NULL OR necessity_reason IN (
           'HUMAN_INTERFACE', 'EXPERT_JUDGMENT', 'ACCOUNTABILITY_LICENSING',
           'PHYSICAL_EXECUTION', 'EXCEPTION_HANDLING', 'OVERSIGHT_VERIFICATION')),
  CHECK (decided_by IN ('BRAIN', 'PERSON')),
  CHECK ((production_layer IN ('BRAIN', 'SOFTWARE_TOOL', 'EXTERNAL_SERVICE'))
         = (necessity_reason IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_labor_allocations_live
  ON labor_allocations(task_id) WHERE superseded_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_labor_allocations_supersedes
  ON labor_allocations(supersedes_id) WHERE supersedes_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_labor_allocations_task
  ON labor_allocations(task_id, created_at);

CREATE INDEX IF NOT EXISTS idx_labor_allocations_project
  ON labor_allocations(project_id);


CREATE TABLE IF NOT EXISTS labor_necessity_answers (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  task_id         TEXT NOT NULL REFERENCES labor_tasks(id),
  question        TEXT NOT NULL,
  answer          TEXT NOT NULL,
  basis           TEXT NOT NULL,
  statement       TEXT NOT NULL,
  source_claim_id TEXT REFERENCES research_claims(id),
  answered_by_ref TEXT,
  superseded_at   TEXT,
  created_at      TEXT NOT NULL,
  seq             BIGSERIAL,
  CHECK (question IN ('BRAIN_IS_FASTER', 'BRAIN_IS_CHEAPER',
                      'BRAIN_QUALITY_AT_LEAST_EQUAL', 'BRAIN_CAN_SELF_VERIFY',
                      'REQUIRES_PHYSICAL_PRESENCE', 'REQUIRES_LICENSED_HUMAN',
                      'HUMAN_INTERACTION_ADDS_VALUE', 'HANDLES_ONLY_EXCEPTIONS')),
  CHECK (answer IN ('YES', 'NO', 'UNKNOWN')),
  CHECK (basis IN ('RESEARCHED', 'PERSON')),
  CHECK ((basis = 'RESEARCHED') = (source_claim_id IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_labor_necessity_live
  ON labor_necessity_answers(task_id, question) WHERE superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_labor_necessity_task
  ON labor_necessity_answers(task_id, created_at);


CREATE TABLE IF NOT EXISTS labor_market_options (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  task_id         TEXT NOT NULL REFERENCES labor_tasks(id),
  channel         TEXT NOT NULL,
  jurisdiction    TEXT,
  rate_cents      INTEGER,
  rate_basis      TEXT,
  statement       TEXT NOT NULL,
  source_claim_id TEXT NOT NULL REFERENCES research_claims(id),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  seq             BIGSERIAL,
  CHECK (channel IN ('OFFSHORE_CONTRACTOR', 'OFFSHORE_EMPLOYEE',
                     'SPECIALIST_FREELANCER', 'DOMESTIC_CONTRACTOR',
                     'DOMESTIC_EMPLOYEE', 'LICENSED_PROFESSIONAL',
                     'FRACTIONAL_SPECIALIST', 'ON_DEMAND_OPERATOR',
                     'AGENCY_OR_VENDOR', 'MANAGED_SERVICE', 'SOFTWARE_TOOL')),
  CHECK (rate_cents IS NULL OR rate_cents >= 0),
  CHECK (rate_basis IS NULL OR rate_basis IN (
           'PER_HOUR', 'PER_UNIT', 'PER_MONTH', 'PER_ENGAGEMENT')),
  CHECK (rate_cents IS NULL OR rate_basis IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_labor_options_claim
  ON labor_market_options(task_id, source_claim_id);

CREATE INDEX IF NOT EXISTS idx_labor_options_task
  ON labor_market_options(task_id, channel);


CREATE TABLE IF NOT EXISTS labor_rounds (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  task_id       TEXT NOT NULL REFERENCES labor_tasks(id),
  purpose       TEXT NOT NULL,
  round         INTEGER NOT NULL,
  candidate_id  TEXT NOT NULL,
  state         TEXT NOT NULL,
  opened_at     TEXT NOT NULL,
  harvested_at  TEXT,
  found         INTEGER,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  seq           BIGSERIAL,
  CHECK (purpose IN ('NECESSITY', 'MARKET', 'PRECEDENT')),
  CHECK (round >= 1),
  CHECK (state IN ('OPEN', 'HARVESTED', 'ABANDONED')),
  CHECK (state = 'OPEN' OR found IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_labor_rounds_ask
  ON labor_rounds(project_id, task_id, purpose, round);

CREATE UNIQUE INDEX IF NOT EXISTS idx_labor_rounds_candidate
  ON labor_rounds(candidate_id);

CREATE INDEX IF NOT EXISTS idx_labor_rounds_project
  ON labor_rounds(project_id, state);


ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS labor_finding TEXT;
ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS labor_subject TEXT;
ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS labor_qualifier TEXT;
ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS labor_rate_cents INTEGER;
