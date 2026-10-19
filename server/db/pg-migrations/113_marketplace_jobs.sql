-- ---------------------------------------------------------------------------
-- A JOB ON A MARKETPLACE THAT BRAIN FOUND, BID ON, DELIVERED AND WAS PAID FOR
-- ---------------------------------------------------------------------------
--
-- One row per external job (a Freelancer project), unique per project. The row
-- holds where the job has got to; what happened to it is in `cash_events`,
-- which is append-only. A rejection is a row with its reasons, so the same job
-- is not screened twice and a person can read why it was turned down.
--
-- `state` is the only mutable status. Every move is a guarded UPDATE naming the
-- state it leaves (`repos/marketplaceJobs.ts`). Money amounts are minor units
-- in `currency`, and nothing here is the money ledger: a payment is recorded in
-- `cash_money_entries` with the milestone id as its reference.
CREATE TABLE marketplace_jobs (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL REFERENCES projects (id),
  platform              TEXT NOT NULL CHECK (platform IN ('FREELANCER')),
  external_id           TEXT NOT NULL,
  title                 TEXT NOT NULL,
  url                   TEXT NOT NULL,
  employer_external_id  TEXT,
  currency              TEXT NOT NULL,
  budget_min_cents      INTEGER,
  budget_max_cents      INTEGER,
  posted_at             TEXT,
  description           TEXT NOT NULL,
  screen_reasons        TEXT NOT NULL,
  proposal_text         TEXT,
  bid_amount_cents      INTEGER,
  bid_period_days       INTEGER,
  state                 TEXT NOT NULL CHECK (state IN (
                          'REJECTED', 'PREPARED', 'BID_SENT', 'BID_UNCERTAIN', 'BID_REFUSED',
                          'LOST', 'AWARDED', 'FULFILLING', 'DELIVERED', 'PAID',
                          'FULFILMENT_FAILED', 'WITHDRAWN')),
  state_reason          TEXT,
  bid_external_id       TEXT,
  thread_external_id    TEXT,
  goal_id               TEXT,
  document_id           TEXT,
  milestone_external_id TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_marketplace_jobs_external
  ON marketplace_jobs (project_id, platform, external_id);
CREATE INDEX idx_marketplace_jobs_state
  ON marketplace_jobs (project_id, state);
