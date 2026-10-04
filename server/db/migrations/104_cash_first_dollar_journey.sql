-- brain:rebuild-without-foreign-keys
--
-- ---------------------------------------------------------------------------
-- THE FIRST-DOLLAR JOURNEY: what happens between READY and COLLECTED
-- ---------------------------------------------------------------------------
--
-- Cash Mode could record that a buyer was reached (a `cash_actions` row written
-- from a provider receipt), that money was agreed (a `PIPELINE_AGREED` entry),
-- that money arrived and that it settled. Four facts in between had nowhere to
-- live, so each was either a sentence in a note or a button:
--
--   * what was agreed — the deliverable, the acceptance condition and the
--     evidence that the buyer agreed — rather than only an amount;
--   * which invoice was issued against which agreement, so a second invoice
--     bills what is still invoiceable instead of the whole agreement again;
--   * what the buyer said, as an observation with a source rather than hidden
--     state;
--   * whether the work was actually done and accepted, rather than `DELIVERING`
--     written on a button press.
--
-- And one fact had no way to be undone: an agreement that falls through left
-- its `PIPELINE_AGREED` entry counting for ever. The ledger is append-only, so
-- the undo is an entry of its own, `PIPELINE_RELEASED`, which needs the inline
-- CHECK widened — and SQLite cannot widen one in place, so `cash_money_entries`
-- is rebuilt by §32's procedure. Nothing references it by foreign key, which
-- `PRAGMA foreign_key_check` checks rather than this comment asserting. Every
-- row is carried across with its rowid, every index is recreated.
--
-- Nothing in these tables holds a balance. Every figure is still derived from
-- `cash_money_entries` (invariant 37); these tables say *what the money was
-- for*, which is the half a ledger row cannot carry.
-- ---------------------------------------------------------------------------

CREATE TABLE cash_money_entries_rebuilt (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id),
  opportunity_id      TEXT,
  kind                TEXT NOT NULL CHECK (kind IN (
                        'CAPITAL_IN',
                        'CAPITAL_OUT',
                        'PIPELINE_AGREED',
                        'PIPELINE_RELEASED',   -- agreed work that will no longer be billed
                        'CUSTOMER_PAYMENT',
                        'SETTLEMENT',
                        'REFUND',
                        'COST',
                        'UNPAID_COMMITMENT',
                        'COMMITMENT_PAID',
                        'RESERVE',
                        'RESERVE_RELEASE'
                      )),
  amount_cents        INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency            TEXT NOT NULL,
  verified_reference  TEXT,
  funds_available_at  TEXT,
  occurred_at         TEXT NOT NULL,
  note                TEXT,
  recorded_by         TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  idempotency_key     TEXT,
  payload_fingerprint TEXT,
  commitment_id       TEXT
);

INSERT INTO cash_money_entries_rebuilt
  (rowid, id, project_id, opportunity_id, kind, amount_cents, currency, verified_reference,
   funds_available_at, occurred_at, note, recorded_by, created_at, idempotency_key,
   payload_fingerprint, commitment_id)
SELECT rowid, id, project_id, opportunity_id, kind, amount_cents, currency, verified_reference,
       funds_available_at, occurred_at, note, recorded_by, created_at, idempotency_key,
       payload_fingerprint, commitment_id
  FROM cash_money_entries;

DROP TABLE cash_money_entries;

ALTER TABLE cash_money_entries_rebuilt RENAME TO cash_money_entries;

CREATE INDEX IF NOT EXISTS idx_cash_money_project
  ON cash_money_entries(project_id, occurred_at);

CREATE INDEX IF NOT EXISTS idx_cash_money_opportunity
  ON cash_money_entries(opportunity_id, occurred_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_money_key
  ON cash_money_entries(project_id, idempotency_key);

-- ---------------------------------------------------------------------------
-- cash_observations — what the buyer (or the world) said, as evidence
-- ---------------------------------------------------------------------------
--
-- A buyer's reply is evidence about a transaction and is kept the way evidence
-- is kept: a closed kind, a source, a reference somebody can check, and the
-- moment it was observed. `BUYER_SILENT` is the one kind Brain derives — from a
-- contact with no reply inside the window — and it is recorded as an
-- observation with its basis rather than inferred at every read, so the
-- learning loop counts the same silence the screen showed.
CREATE TABLE IF NOT EXISTS cash_observations (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  opportunity_id  TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN (
                    'BUYER_REPLIED', 'BUYER_ACCEPTED', 'BUYER_COUNTERED', 'BUYER_DECLINED',
                    'BUYER_SILENT', 'CONTACT_UNDELIVERABLE', 'DELIVERY_ACCEPTED',
                    'DELIVERY_REJECTED', 'SUPPLIER_COST_CHANGED')),
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
-- An agreement writes its `PIPELINE_AGREED` entry in the same transaction,
-- keyed from the agreement, so the two cannot disagree; releasing one writes
-- `PIPELINE_RELEASED` the same way. `evidence_ref` is NOT NULL because an
-- agreement nobody can point at is "they seemed interested".
CREATE TABLE IF NOT EXISTS cash_agreements (
  id                    TEXT PRIMARY KEY,
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
-- cash_invoices — one row per invoice actually issued, against an agreement
-- ---------------------------------------------------------------------------
--
-- Written from a provider receipt (`issued_by = 'BRAIN'`, `operation_id` set,
-- keyed by the operation so a retry or a reconciliation writes one row) or from
-- a person's record of an invoice they issued themselves. `provider_ref` is
-- NOT NULL for the same reason an agreement's evidence is. Whether it is paid is
-- derived from the ledger and never stored here.
CREATE TABLE IF NOT EXISTS cash_invoices (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  opportunity_id  TEXT NOT NULL,
  agreement_id    TEXT NOT NULL REFERENCES cash_agreements(id),
  amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
  currency        TEXT NOT NULL,
  issued_by       TEXT NOT NULL CHECK (issued_by IN ('BRAIN', 'PERSON')),
  provider_ref    TEXT NOT NULL,
  operation_id    TEXT,
  due_at          TEXT,
  state           TEXT NOT NULL CHECK (state IN ('ISSUED', 'VOID', 'EXPIRED')),
  state_reason    TEXT,
  request_key     TEXT NOT NULL,
  recorded_by     TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_invoices_key
  ON cash_invoices(project_id, request_key);
CREATE INDEX IF NOT EXISTS idx_cash_invoices_opportunity
  ON cash_invoices(opportunity_id, state);

-- ---------------------------------------------------------------------------
-- cash_fulfilments — work created, work performed, work accepted
-- ---------------------------------------------------------------------------
--
-- `work_kind` / `work_ref` point at the existing machinery that does the work —
-- a Russell idea, a Factory change request, a cash job, a commitment to a
-- supplier — so "performed" is read from that row where the row can say it and
-- recorded with evidence where it cannot. `DELIVERED` needs acceptance evidence
-- (`accepted_observation_id` or `acceptance_evidence`), never a state change
-- somebody wanted.
CREATE TABLE IF NOT EXISTS cash_fulfilments (
  id                       TEXT PRIMARY KEY,
  project_id               TEXT NOT NULL REFERENCES projects(id),
  opportunity_id           TEXT NOT NULL,
  agreement_id             TEXT NOT NULL REFERENCES cash_agreements(id),
  path                     TEXT NOT NULL CHECK (path IN (
                             'BRAIN_RESEARCH', 'FACTORY_SOFTWARE', 'PERSON', 'CONTRACTOR',
                             'SUPPLIER', 'OTHER')),
  work_kind                TEXT NOT NULL CHECK (work_kind IN (
                             'RUSSELL_CANDIDATE', 'FACTORY_CHANGE_REQUEST', 'CASH_JOB',
                             'COMMITMENT', 'EXTERNAL')),
  work_ref                 TEXT NOT NULL,
  commitment_id            TEXT,
  state                    TEXT NOT NULL CHECK (state IN (
                             'CREATED', 'PERFORMED', 'DELIVERED', 'FAILED', 'CANCELLED')),
  performed_evidence       TEXT,
  accepted_observation_id  TEXT,
  acceptance_evidence      TEXT,
  state_reason             TEXT,
  request_key              TEXT NOT NULL,
  created_by               TEXT NOT NULL,
  created_at               TEXT NOT NULL,
  performed_at             TEXT,
  delivered_at             TEXT,
  ended_at                 TEXT,
  updated_at               TEXT NOT NULL,
  CHECK (state NOT IN ('PERFORMED', 'DELIVERED') OR performed_evidence IS NOT NULL),
  CHECK (state <> 'DELIVERED'
         OR accepted_observation_id IS NOT NULL OR acceptance_evidence IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_fulfilments_key
  ON cash_fulfilments(project_id, request_key);
CREATE INDEX IF NOT EXISTS idx_cash_fulfilments_opportunity
  ON cash_fulfilments(opportunity_id, state);

-- ---------------------------------------------------------------------------
-- cash_outcomes — what a commercial test actually taught, append-only
-- ---------------------------------------------------------------------------
--
-- One row per measured fact, each carrying the rows it was read from. Nothing
-- here is a rule: whether several outcomes amount to one is derived on the read
-- path with the sample beside it, and a single result is reported as a single
-- result. Never updated, never deleted — a later outcome is a later row.
CREATE TABLE IF NOT EXISTS cash_outcomes (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  opportunity_id  TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN (
                    'CONTACT_RESULT', 'OFFERED_PRICE', 'ACCEPTED_PRICE', 'TIME_TO_AGREEMENT',
                    'FULFILMENT_DURATION', 'ACTUAL_COST', 'REFUNDED', 'REALIZED_CONTRIBUTION',
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
