-- Getting work done through people. See the SQLite migration 093_human_work.sql
-- for why every column exists; this is the same schema in Postgres.
CREATE TABLE IF NOT EXISTS human_work_orders (
  seq BIGSERIAL,
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id),
  task_id             TEXT NOT NULL REFERENCES labor_tasks(id),
  allocation_id       TEXT NOT NULL REFERENCES labor_allocations(id),
  necessity_reason    TEXT NOT NULL,
  title               TEXT NOT NULL,
  work                TEXT NOT NULL,
  why_person          TEXT NOT NULL,
  brain_prepares      TEXT NOT NULL DEFAULT '[]',
  deliverables        TEXT NOT NULL DEFAULT '[]',
  acceptance          TEXT NOT NULL,
  shared_context      TEXT NOT NULL DEFAULT '[]',
  access_required     TEXT NOT NULL DEFAULT '[]',
  due_by              TEXT,
  budget_cents        INTEGER CHECK (budget_cents IS NULL OR budget_cents >= 0),
  currency            TEXT NOT NULL DEFAULT 'USD',
  coordinator_user_id TEXT REFERENCES users(id),
  opened_by           TEXT NOT NULL,
  state               TEXT NOT NULL DEFAULT 'OPEN'
                      CHECK (state IN ('OPEN', 'ACCEPTED', 'CANCELLED')),
  closed_at           TEXT,
  close_reason        TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  CHECK ((state = 'OPEN') = (closed_at IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_human_work_orders_project ON human_work_orders(project_id, state);
CREATE UNIQUE INDEX IF NOT EXISTS idx_human_work_orders_live_task
  ON human_work_orders(task_id) WHERE state = 'OPEN';

CREATE TABLE IF NOT EXISTS human_work_candidates (
  seq BIGSERIAL,
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id),
  order_id            TEXT NOT NULL REFERENCES human_work_orders(id),
  display_name        TEXT NOT NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('PERSON', 'ORGANIZATION')),
  relationship        TEXT NOT NULL
                      CHECK (relationship IN ('TEAM_MEMBER', 'EXISTING_RELATIONSHIP', 'RESEARCHED')),
  user_id             TEXT REFERENCES users(id),
  source_claim_id     TEXT,
  attested_by         TEXT,
  competence          TEXT NOT NULL DEFAULT '[]',
  location            TEXT,
  availability        TEXT,
  quote_cents         INTEGER CHECK (quote_cents IS NULL OR quote_cents >= 0),
  quote_basis         TEXT,
  quote_currency      TEXT,
  quote_source        TEXT CHECK (quote_source IS NULL OR quote_source IN
                        ('CANDIDATE_QUOTED', 'PUBLISHED_RATE', 'INTERNAL_NO_CHARGE')),
  uncertainties       TEXT NOT NULL DEFAULT '[]',
  contact_channel     TEXT,
  set_aside_at        TEXT,
  set_aside_reason    TEXT,
  created_by          TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  CHECK ((relationship = 'TEAM_MEMBER') = (user_id IS NOT NULL)),
  CHECK ((relationship = 'RESEARCHED') = (source_claim_id IS NOT NULL)),
  CHECK ((relationship = 'EXISTING_RELATIONSHIP') = (attested_by IS NOT NULL)),
  CHECK ((set_aside_at IS NULL) = (set_aside_reason IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_human_work_candidates_order ON human_work_candidates(order_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_human_work_candidates_user
  ON human_work_candidates(order_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_human_work_candidates_claim
  ON human_work_candidates(order_id, source_claim_id) WHERE source_claim_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS human_work_engagements (
  seq BIGSERIAL,
  id                   TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL REFERENCES projects(id),
  order_id             TEXT NOT NULL REFERENCES human_work_orders(id),
  candidate_id         TEXT NOT NULL REFERENCES human_work_candidates(id),
  terms                TEXT NOT NULL,
  terms_hash           TEXT NOT NULL,
  compensation_cents   INTEGER NOT NULL CHECK (compensation_cents >= 0),
  currency             TEXT NOT NULL,
  state                TEXT NOT NULL CHECK (state IN
                         ('PROPOSED', 'APPROVED', 'INVITED', 'ENGAGED', 'COMPLETED',
                          'REFUSED_BY_OWNER', 'DECLINED_BY_WORKER', 'CANCELLED')),
  decision_request_id  TEXT,
  approved_by_user_id  TEXT REFERENCES users(id),
  approved_at          TEXT,
  approved_max_cents   INTEGER,
  funding              TEXT CHECK (funding IS NULL OR funding IN
                         ('COMMERCIAL_AUTHORITY', 'DIRECT_APPROVAL', 'NO_CHARGE')),
  commitment_id        TEXT,
  assignee_user_id     TEXT REFERENCES users(id),
  invited_at           TEXT,
  invited_by           TEXT,
  invitation_channel   TEXT,
  invitation_reference TEXT,
  engaged_at           TEXT,
  engaged_evidence     TEXT CHECK (engaged_evidence IS NULL OR engaged_evidence IN
                         ('ACCEPTED_IN_BRAIN', 'ATTESTED_BY_COORDINATOR')),
  engaged_attested_by  TEXT,
  completed_at         TEXT,
  ended_reason         TEXT,
  created_by           TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  CHECK (state IN ('PROPOSED', 'REFUSED_BY_OWNER', 'CANCELLED') OR approved_at IS NOT NULL),
  CHECK (state NOT IN ('ENGAGED', 'COMPLETED') OR engaged_evidence IS NOT NULL),
  CHECK (engaged_evidence IS NULL OR engaged_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_human_work_engagements_order ON human_work_engagements(order_id);
CREATE INDEX IF NOT EXISTS idx_human_work_engagements_assignee
  ON human_work_engagements(assignee_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_human_work_engagements_live
  ON human_work_engagements(order_id)
  WHERE state IN ('PROPOSED', 'APPROVED', 'INVITED', 'ENGAGED');

CREATE TABLE IF NOT EXISTS human_work_events (
  seq BIGSERIAL,
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  order_id      TEXT NOT NULL,
  engagement_id TEXT,
  kind          TEXT NOT NULL,
  summary       TEXT NOT NULL,
  detail        TEXT NOT NULL DEFAULT '{}',
  actor         TEXT NOT NULL CHECK (actor IN ('BRAIN', 'PERSON', 'ASSIGNEE')),
  actor_user_id TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_human_work_events_order ON human_work_events(order_id, created_at);

CREATE TABLE IF NOT EXISTS human_work_deliverables (
  seq BIGSERIAL,
  id                   TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL,
  engagement_id        TEXT NOT NULL REFERENCES human_work_engagements(id),
  round                INTEGER NOT NULL CHECK (round >= 1),
  description          TEXT NOT NULL,
  document_id          TEXT,
  reference            TEXT,
  submitted_by_user_id TEXT NOT NULL,
  submitted_as         TEXT NOT NULL CHECK (submitted_as IN ('ASSIGNEE', 'COORDINATOR')),
  created_at           TEXT NOT NULL,
  CHECK (document_id IS NOT NULL OR reference IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_human_work_deliverables_round
  ON human_work_deliverables(engagement_id, round);

CREATE TABLE IF NOT EXISTS human_work_reviews (
  seq BIGSERIAL,
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL,
  engagement_id    TEXT NOT NULL REFERENCES human_work_engagements(id),
  deliverable_id   TEXT NOT NULL REFERENCES human_work_deliverables(id),
  criterion_key    TEXT NOT NULL,
  verdict          TEXT NOT NULL CHECK (verdict IN ('MET', 'NOT_MET', 'CANNOT_VERIFY')),
  note             TEXT NOT NULL,
  repair           TEXT,
  reviewer_user_id TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  CHECK (verdict = 'MET' OR repair IS NOT NULL OR verdict = 'CANNOT_VERIFY')
);
CREATE INDEX IF NOT EXISTS idx_human_work_reviews_deliverable
  ON human_work_reviews(deliverable_id, criterion_key);

CREATE TABLE IF NOT EXISTS human_work_costs (
  seq BIGSERIAL,
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  engagement_id   TEXT NOT NULL REFERENCES human_work_engagements(id),
  kind            TEXT NOT NULL CHECK (kind IN ('INCURRED', 'PAID')),
  amount_cents    INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency        TEXT NOT NULL,
  hours           DOUBLE PRECISION CHECK (hours IS NULL OR hours >= 0),
  reference       TEXT,
  note            TEXT,
  recorded_by     TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_human_work_costs_key
  ON human_work_costs(engagement_id, idempotency_key);
