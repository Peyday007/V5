-- The post-sale model (SQLite 108_cash_post_sale.sql), on the Postgres chain.
-- docs/POST-SALE.md is the ownership matrix; CLAUDE.md §54 says why.
--
-- The ledger's inline CHECK is widened in place, which Postgres can do; the
-- constraint is named as Postgres names an inline column CHECK and dropped
-- without IF EXISTS on purpose (§35: the tolerant form leaves the old
-- constraint standing beside the new one).
ALTER TABLE cash_money_entries DROP CONSTRAINT cash_money_entries_kind_check;
ALTER TABLE cash_money_entries ADD CONSTRAINT cash_money_entries_kind_check
  CHECK (kind IN ('CAPITAL_IN', 'CAPITAL_OUT', 'PIPELINE_AGREED', 'PIPELINE_RELEASED',
                  'CUSTOMER_PAYMENT', 'SETTLEMENT', 'REFUND', 'COST', 'UNPAID_COMMITMENT',
                  'COMMITMENT_PAID', 'COMMITMENT_RELEASED', 'RESERVE', 'RESERVE_RELEASE'));

-- ---------------------------------------------------------------------------
-- cash_observations — what the buyer (or the channel) said, as evidence
-- ---------------------------------------------------------------------------
--
-- Pre-agreement only. Acceptance or rejection of delivered work is a fact about
-- one obligation and lives in cash_fulfillment_events; a supplier's price is a
-- ledger entry. BUYER_SILENT is the one kind Brain derives, from a contact with
-- no reply inside the window.
CREATE TABLE IF NOT EXISTS cash_observations (
  id              TEXT PRIMARY KEY,
  seq             BIGSERIAL,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  opportunity_id  TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN (
                    'BUYER_REPLIED', 'BUYER_ACCEPTED', 'BUYER_COUNTERED', 'BUYER_DECLINED',
                    'BUYER_SILENT', 'CONTACT_UNDELIVERABLE')),
  source          TEXT NOT NULL CHECK (source IN ('PROVIDER', 'PERSON', 'BRAIN')),
  channel         TEXT,
  evidence_ref    TEXT NOT NULL,
  amount_cents    INTEGER CHECK (amount_cents IS NULL OR amount_cents >= 0),
  currency        TEXT,
  note            TEXT,
  observed_at     TEXT NOT NULL,
  recorded_by     TEXT NOT NULL,
  request_key     TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_observations_key
  ON cash_observations(project_id, request_key);
CREATE INDEX IF NOT EXISTS idx_cash_observations_opportunity
  ON cash_observations(opportunity_id, observed_at);

-- ---------------------------------------------------------------------------
-- cash_agreements — what was agreed, not only how much
-- ---------------------------------------------------------------------------
--
-- The only writer of PIPELINE_AGREED / PIPELINE_RELEASED, under keys
-- `agreement:<id>` / `agreement-released:<id>`, in the same transaction as the
-- row. The deliverable and acceptance condition are the obligation's promise
-- and its acceptance condition: they are not copied anywhere else.
CREATE TABLE IF NOT EXISTS cash_agreements (
  id                    TEXT PRIMARY KEY,
  seq             BIGSERIAL,
  project_id            TEXT NOT NULL REFERENCES projects(id),
  opportunity_id        TEXT NOT NULL,
  amount_cents          INTEGER NOT NULL CHECK (amount_cents > 0),
  currency              TEXT NOT NULL,
  deliverable           TEXT NOT NULL,
  acceptance_condition  TEXT NOT NULL,
  evidence_kind         TEXT NOT NULL CHECK (evidence_kind IN (
                          'SIGNED_AGREEMENT', 'WRITTEN_ACCEPTANCE', 'PURCHASE_ORDER',
                          'PROVIDER_RECORD')),
  evidence_ref          TEXT NOT NULL,
  observation_id        TEXT,
  state                 TEXT NOT NULL CHECK (state IN ('AGREED', 'RELEASED')),
  released_reason       TEXT,
  released_by           TEXT,
  released_at           TEXT,
  request_key           TEXT NOT NULL,
  recorded_by           TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  CHECK (state = 'AGREED' OR released_at IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_agreements_key
  ON cash_agreements(project_id, request_key);
CREATE INDEX IF NOT EXISTS idx_cash_agreements_opportunity
  ON cash_agreements(opportunity_id, state);

-- ---------------------------------------------------------------------------
-- cash_fulfillments — the obligation one agreement creates
-- ---------------------------------------------------------------------------
--
-- One per agreement. Who performs it and the work Brain created for it; never
-- a stage. `work_attempt` is advanced by the same guarded UPDATE that releases
-- failed work, so a retry's Factory key can never collide with the failed one.
CREATE TABLE IF NOT EXISTS cash_fulfillments (
  id                 TEXT PRIMARY KEY,
  seq             BIGSERIAL,
  project_id         TEXT NOT NULL REFERENCES projects(id),
  opportunity_id     TEXT NOT NULL,
  agreement_id       TEXT NOT NULL REFERENCES cash_agreements(id),
  kind               TEXT NOT NULL CHECK (kind IN ('SOFTWARE', 'RESEARCH', 'PERSON', 'SUPPLIER')),
  performer          TEXT NOT NULL,
  repository_remote  TEXT,
  repository_root    TEXT,
  base_branch        TEXT,
  mutation_scope     TEXT,
  supplier_name      TEXT,
  work_ref           TEXT,
  work_created_at    TEXT,
  work_attempt       INTEGER NOT NULL DEFAULT 0 CHECK (work_attempt >= 0),
  declared_by        TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_fulfillments_agreement
  ON cash_fulfillments(agreement_id);
CREATE INDEX IF NOT EXISTS idx_cash_fulfillments_opportunity
  ON cash_fulfillments(project_id, opportunity_id);

-- ---------------------------------------------------------------------------
-- cash_fulfillment_events — what happened to the obligation, append-only
-- ---------------------------------------------------------------------------
--
-- `request_key` makes one logical event one row, so a retry after a lost
-- response is the same outcome. `refund_key` ties a refund's authorization to
-- its outcome; the money of a confirmed refund is a REFUND ledger entry.
CREATE TABLE IF NOT EXISTS cash_fulfillment_events (
  id              TEXT PRIMARY KEY,
  seq             BIGSERIAL,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  fulfillment_id  TEXT NOT NULL REFERENCES cash_fulfillments(id),
  opportunity_id  TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN (
                    'WORK_COMPLETE', 'DELIVERED', 'PARTIALLY_DELIVERED', 'ACCEPTED', 'REJECTED',
                    'FAILED', 'SUPPLIER_FAILED', 'ABANDONED',
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

-- ---------------------------------------------------------------------------
-- cash_outcomes — what a finished deal taught, written once
-- ---------------------------------------------------------------------------
--
-- One row per measured fact, each carrying its basis (the rows it was read
-- from). Keyed by the terminal point it describes — a contact answered or the
-- deal ended, an agreement, a delivered obligation, a confirmed refund — so a
-- pass that asks again writes nothing. Never updated, never deleted.
CREATE TABLE IF NOT EXISTS cash_outcomes (
  id              TEXT PRIMARY KEY,
  seq             BIGSERIAL,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  opportunity_id  TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN (
                    'CONTACT_RESULT', 'OFFERED_PRICE', 'ACCEPTED_PRICE', 'TIME_TO_AGREEMENT',
                    'FULFILLMENT_DURATION', 'ACTUAL_COST', 'REFUNDED', 'REALIZED_CONTRIBUTION',
                    'FAILURE_REASON')),
  mechanism       TEXT,
  channel         TEXT,
  value_cents     INTEGER,
  value_ms        INTEGER,
  value_text      TEXT,
  currency        TEXT,
  basis           TEXT NOT NULL,
  request_key     TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_outcomes_key
  ON cash_outcomes(project_id, request_key);
CREATE INDEX IF NOT EXISTS idx_cash_outcomes_mechanism
  ON cash_outcomes(project_id, mechanism, kind);
