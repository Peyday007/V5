-- What happens to a commercial opportunity after a buyer agrees: the obligation,
-- what was done about it, and what it taught.
--
-- Three tables and no state column on any of them. Where a fulfillment stands —
-- work, delivery, acceptance, refunds, completion — is derived on the read path
-- from these rows, the money ledger and the work they point at
-- (`services/cash/fulfillment.ts`). A stored state would be a second master for
-- facts the Factory, the research pipeline and the ledger already hold.
--
-- Money is not here. Agreed amounts, payments, refunds and costs are
-- `cash_money_entries`; this table never holds a figure the ledger owns.

-- The obligation: what was promised, by what means, and what proves it landed.
-- One per opportunity. `work_ref` is the Factory change request or Russell
-- candidate Brain created for it, written once by a guarded UPDATE.
CREATE TABLE IF NOT EXISTS cash_fulfillments (
  id                    TEXT PRIMARY KEY,
  seq             BIGSERIAL,
  project_id            TEXT NOT NULL REFERENCES projects(id),
  opportunity_id        TEXT NOT NULL,
  kind                  TEXT NOT NULL CHECK (kind IN ('SOFTWARE', 'RESEARCH', 'PERSON', 'SUPPLIER')),
  promise               TEXT NOT NULL,
  performer             TEXT NOT NULL,
  acceptance_condition  TEXT,
  repository_remote     TEXT,
  repository_root       TEXT,
  base_branch           TEXT,
  mutation_scope        TEXT,
  supplier_name         TEXT,
  work_ref              TEXT,
  work_created_at       TEXT,
  declared_by           TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_fulfillments_opportunity
  ON cash_fulfillments(project_id, opportunity_id);

-- What happened, append-only. A delivery, an acceptance, a rejection, a failure,
-- a refund's authorization and its outcome. `request_key` makes one logical
-- event one row, so a retry after a lost response is the same outcome.
CREATE TABLE IF NOT EXISTS cash_fulfillment_events (
  id              TEXT PRIMARY KEY,
  seq             BIGSERIAL,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  fulfillment_id  TEXT NOT NULL REFERENCES cash_fulfillments(id),
  opportunity_id  TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN (
                    'WORK_COMPLETE', 'DELIVERED', 'PARTIALLY_DELIVERED', 'ACCEPTED', 'REJECTED',
                    'FAILED', 'SUPPLIER_COMMITTED', 'SUPPLIER_FAILED', 'ABANDONED',
                    'REFUND_AUTHORIZED', 'REFUND_CONFIRMED', 'REFUND_UNKNOWN', 'REFUND_FAILED')),
  detail          TEXT NOT NULL,
  evidence_ref    TEXT,
  amount_cents    INTEGER CHECK (amount_cents IS NULL OR amount_cents > 0),
  refund_key      TEXT,
  recorded_by     TEXT NOT NULL,
  request_key     TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_fulfillment_events_key
  ON cash_fulfillment_events(fulfillment_id, request_key);
CREATE INDEX IF NOT EXISTS idx_cash_fulfillment_events_fulfillment
  ON cash_fulfillment_events(fulfillment_id, created_at);

-- What one finished or failed obligation taught, written once and never
-- revised. A later refund is a new observation beside the old one.
CREATE TABLE IF NOT EXISTS cash_outcome_observations (
  id              TEXT PRIMARY KEY,
  seq             BIGSERIAL,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  opportunity_id  TEXT NOT NULL,
  fulfillment_id  TEXT NOT NULL REFERENCES cash_fulfillments(id),
  mechanism       TEXT NOT NULL,
  fulfillment_kind TEXT NOT NULL,
  outcome         TEXT NOT NULL CHECK (outcome IN ('SUCCESS', 'FAILURE', 'REFUND')),
  kind            TEXT NOT NULL CHECK (kind IN (
                    'BUYER_RESPONSE', 'AGREED_PRICE', 'DELIVERY_TIME', 'ACCEPTANCE',
                    'ACTUAL_COST', 'SUPPLIER_RELIABILITY', 'REFUND_REASON',
                    'REALIZED_CONTRIBUTION')),
  value_text      TEXT NOT NULL,
  value_number    INTEGER,
  currency        TEXT,
  request_key     TEXT NOT NULL,
  observed_at     TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_outcome_observations_key
  ON cash_outcome_observations(project_id, request_key);
CREATE INDEX IF NOT EXISTS idx_cash_outcome_observations_mechanism
  ON cash_outcome_observations(project_id, mechanism, kind);
