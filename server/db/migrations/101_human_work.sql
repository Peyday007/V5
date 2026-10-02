-- ---------------------------------------------------------------------------
-- GETTING WORK DONE THROUGH PEOPLE
--
-- §41's kernel decides *whether* a person is needed and names which of six
-- reasons makes it so. Nothing after that decision existed: no row said which
-- person, on what terms, with whose authorization, what they were told, what
-- they handed back, or whether it met the need. This is that half, and four
-- rules decided every column.
--
-- 1. A RESEARCHED POSSIBILITY IS NOT A PERSON WHO AGREED. A candidate row says
--    somebody *could* do the work and why Brain believes so; an engagement row
--    says a person *has been asked* on stated terms; `ENGAGED` is written only
--    when that person accepted — by themselves inside Brain, or attested by a
--    coordinator who names the evidence. `relationship` and `engaged_evidence`
--    keep those facts apart in the schema rather than in a sentence.
--
-- 2. AN UNANSWERED INVITATION IS NOT AN ENGAGEMENT, AND AN ASSIGNED TASK IS NOT
--    A DELIVERED RESULT. The engagement's state moves only by a guarded
--    compare-and-swap naming the state it comes from, and a result is accepted
--    only when every acceptance condition reads MET on the latest deliverable —
--    read live from rows where Brain can read it, and judged by somebody other
--    than the assignee where it cannot.
--
-- 3. NO COMMITMENT WITHOUT A PERSON'S DECISION ON THE CONCRETE TERMS. The
--    decision is a Needs You card (`russell_human_requests`) naming who, what,
--    what it costs and what access it needs, answered by a project
--    administrator. Approving records the approved maximum; nothing here can
--    raise it afterwards without a second decision.
--
-- 4. HISTORY IS NEVER OVERWRITTEN. Events, deliverables, reviews and costs are
--    append-only. A repair is a new deliverable round; a correction is a new
--    row. What a person was told, when, and what they returned stays readable
--    for the reliability reading that informs the next staffing decision.
-- ---------------------------------------------------------------------------

-- A piece of work a person must do: the precise work, why a person, what Brain
-- prepares first, and the standard the result is accepted against.
CREATE TABLE IF NOT EXISTS human_work_orders (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id),
  -- The labor task whose live allocation says a person produces it. Required:
  -- the production-allocation judgment is the gate, not a sentence here.
  task_id             TEXT NOT NULL REFERENCES labor_tasks(id),
  allocation_id       TEXT NOT NULL REFERENCES labor_allocations(id),
  necessity_reason    TEXT NOT NULL,
  title               TEXT NOT NULL,
  work                TEXT NOT NULL,
  why_person          TEXT NOT NULL,
  -- JSON arrays. `acceptance` is [{key, statement, check}] and never empty.
  brain_prepares      TEXT NOT NULL DEFAULT '[]',
  deliverables        TEXT NOT NULL DEFAULT '[]',
  acceptance          TEXT NOT NULL,
  -- What the worker is shown, and nothing else from the project.
  shared_context      TEXT NOT NULL DEFAULT '[]',
  access_required     TEXT NOT NULL DEFAULT '[]',
  due_by              TEXT,
  budget_cents        INTEGER CHECK (budget_cents IS NULL OR budget_cents >= 0),
  currency            TEXT NOT NULL DEFAULT 'USD',
  -- A project member who works with Brain on delivery. Decisions stay ADMIN.
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

-- Somebody who could do it. Never an agreement.
CREATE TABLE IF NOT EXISTS human_work_candidates (
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
  -- [{statement, basis, ref}], basis from a closed set; a claimed skill is
  -- stored as CLAIMED_BY_CANDIDATE and is never read as proof.
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

-- An ask on stated terms, and what became of it.
CREATE TABLE IF NOT EXISTS human_work_engagements (
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
  -- How the money side was authorized: a hold under the standing commercial
  -- authority, the approver's own decision on these exact terms, or no money.
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

-- Append-only. What happened, who did it, in order.
CREATE TABLE IF NOT EXISTS human_work_events (
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

-- What the person handed back. A repair is a new round, never an edit.
CREATE TABLE IF NOT EXISTS human_work_deliverables (
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

-- One judgement on one condition against one deliverable round.
CREATE TABLE IF NOT EXISTS human_work_reviews (
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

-- Money and time, as rows. Outstanding is derived: agreed minus paid.
CREATE TABLE IF NOT EXISTS human_work_costs (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  engagement_id   TEXT NOT NULL REFERENCES human_work_engagements(id),
  kind            TEXT NOT NULL CHECK (kind IN ('INCURRED', 'PAID')),
  amount_cents    INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency        TEXT NOT NULL,
  hours           REAL CHECK (hours IS NULL OR hours >= 0),
  reference       TEXT,
  note            TEXT,
  recorded_by     TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_human_work_costs_key
  ON human_work_costs(engagement_id, idempotency_key);
