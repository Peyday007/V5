-- The Postgres half of SQLite migration 093. See that file for what each table
-- makes checkable, why `AWAITING_AUTHORITY` is derived rather than stored, and
-- why the live-test index is where competing members are kept apart.
--
-- `seq BIGSERIAL` is the identity column `db/dialect.ts` rewrites `rowid` to.
CREATE TABLE IF NOT EXISTS cash_demand_tests (
  seq                   BIGSERIAL,
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL REFERENCES projects(id),
  opportunity_id        TEXT NOT NULL,
  owner_user_id         TEXT NOT NULL,
  prepared_by           TEXT NOT NULL CHECK (prepared_by IN ('BRAIN', 'PERSON')),
  audience              TEXT NOT NULL,
  channel               TEXT NOT NULL,
  offer                 TEXT NOT NULL,
  price_cents           INTEGER CHECK (price_cents IS NULL OR price_cents > 0),
  currency              TEXT NOT NULL,
  max_contacts          INTEGER NOT NULL CHECK (max_contacts >= 1),
  max_spend_cents       INTEGER NOT NULL DEFAULT 0 CHECK (max_spend_cents >= 0),
  window_ends_at        TEXT NOT NULL,
  continue_if_agreed    INTEGER NOT NULL CHECK (continue_if_agreed >= 1),
  change_if_interested  INTEGER NOT NULL CHECK (change_if_interested >= 1),
  stop_after_contacts   INTEGER NOT NULL CHECK (stop_after_contacts >= 1),
  draft_message         TEXT NOT NULL,
  basis                 TEXT NOT NULL,
  state                 TEXT NOT NULL
                        CHECK (state IN ('PREPARED', 'RUNNING', 'CONCLUDED', 'WITHDRAWN')),
  verdict               TEXT CHECK (verdict IS NULL OR verdict IN ('CONTINUE', 'CHANGE', 'STOP')),
  verdict_reason        TEXT,
  started_at            TEXT,
  concluded_at          TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  CHECK (state <> 'CONCLUDED' OR (verdict IS NOT NULL AND concluded_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_demand_tests_live
  ON cash_demand_tests(opportunity_id) WHERE state IN ('PREPARED', 'RUNNING');
CREATE INDEX IF NOT EXISTS idx_cash_demand_tests_project
  ON cash_demand_tests(project_id, state);

CREATE TABLE IF NOT EXISTS cash_demand_contacts (
  seq                   BIGSERIAL,
  id              TEXT PRIMARY KEY,
  test_id         TEXT NOT NULL REFERENCES cash_demand_tests(id),
  project_id      TEXT NOT NULL REFERENCES projects(id),
  opportunity_id  TEXT NOT NULL,
  action_id       TEXT NOT NULL REFERENCES cash_actions(id),
  recipient       TEXT NOT NULL,
  sent_at         TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_demand_contacts_one
  ON cash_demand_contacts(test_id, recipient);

CREATE TABLE IF NOT EXISTS cash_responses (
  seq                   BIGSERIAL,
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  opportunity_id  TEXT NOT NULL,
  test_id         TEXT,
  obligation_id   TEXT,
  respondent      TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN (
                    'INTEREST', 'QUESTION', 'OBJECTION', 'DECLINED', 'AGREED_TO_BUY',
                    'REVISION_REQUESTED', 'ACCEPTED_DELIVERY', 'REJECTED_DELIVERY',
                    'PAYMENT_PROMISED')),
  channel         TEXT NOT NULL,
  reference       TEXT NOT NULL,
  excerpt         TEXT NOT NULL,
  received_at     TEXT NOT NULL,
  performed_by    TEXT NOT NULL CHECK (performed_by IN ('BRAIN', 'PERSON')),
  recorded_by     TEXT NOT NULL,
  request_key     TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_responses_key
  ON cash_responses(project_id, request_key);
CREATE INDEX IF NOT EXISTS idx_cash_responses_opportunity
  ON cash_responses(opportunity_id, received_at);

CREATE TABLE IF NOT EXISTS cash_obligations (
  seq                   BIGSERIAL,
  id                     TEXT PRIMARY KEY,
  project_id             TEXT NOT NULL REFERENCES projects(id),
  opportunity_id         TEXT NOT NULL,
  test_id                TEXT,
  agreement_response_id  TEXT,
  owner_user_id          TEXT NOT NULL,
  buyer                  TEXT NOT NULL,
  scope                  TEXT NOT NULL,
  price_cents            INTEGER NOT NULL CHECK (price_cents > 0),
  currency               TEXT NOT NULL,
  acceptance_conditions  TEXT NOT NULL,
  delivery_plan          TEXT NOT NULL,
  delivery_route         TEXT NOT NULL
                         CHECK (delivery_route IN ('SOFTWARE_FACTORY', 'ARTIFACT', 'HUMAN', 'VENDOR')),
  required_resources     TEXT NOT NULL,
  production_reference   TEXT,
  deliverable_reference  TEXT,
  state                  TEXT NOT NULL CHECK (state IN (
                           'OFFER_PREPARED', 'OFFER_SENT', 'AGREED', 'IN_PRODUCTION', 'DELIVERED',
                           'REVISION_REQUESTED', 'ACCEPTED', 'CLOSED', 'LOST', 'CANCELLED')),
  revision_count         INTEGER NOT NULL DEFAULT 0,
  next_step              TEXT NOT NULL,
  next_step_owner        TEXT NOT NULL
                         CHECK (next_step_owner IN ('BRAIN', 'OPERATOR', 'VENDOR', 'PERSON', 'BUYER')),
  next_step_due          TEXT,
  offer_action_id        TEXT,
  sent_at                TEXT,
  agreed_at              TEXT,
  delivered_at           TEXT,
  accepted_at            TEXT,
  closed_at              TEXT,
  close_reason           TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  CHECK (state NOT IN ('AGREED', 'IN_PRODUCTION', 'DELIVERED', 'REVISION_REQUESTED', 'ACCEPTED', 'CLOSED')
         OR agreement_response_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_cash_obligations_project
  ON cash_obligations(project_id, state);
CREATE INDEX IF NOT EXISTS idx_cash_obligations_opportunity
  ON cash_obligations(opportunity_id);

CREATE TABLE IF NOT EXISTS cash_obligation_events (
  seq                   BIGSERIAL,
  id             TEXT PRIMARY KEY,
  obligation_id  TEXT NOT NULL REFERENCES cash_obligations(id),
  project_id     TEXT NOT NULL REFERENCES projects(id),
  kind           TEXT NOT NULL,
  from_state     TEXT,
  to_state       TEXT NOT NULL,
  actor_ref      TEXT NOT NULL,
  evidence       TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cash_obligation_events_obligation
  ON cash_obligation_events(obligation_id, created_at);

CREATE TABLE IF NOT EXISTS cash_invoices (
  seq                   BIGSERIAL,
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL REFERENCES projects(id),
  obligation_id         TEXT NOT NULL REFERENCES cash_obligations(id),
  opportunity_id        TEXT NOT NULL,
  amount_cents          INTEGER NOT NULL CHECK (amount_cents > 0),
  currency              TEXT NOT NULL,
  provider              TEXT NOT NULL,
  provider_reference    TEXT NOT NULL,
  issued_action_id      TEXT NOT NULL REFERENCES cash_actions(id),
  state                 TEXT NOT NULL CHECK (state IN (
                          'ISSUED', 'PAYMENT_PENDING', 'PAID', 'SETTLED', 'FAILED', 'VOID', 'REFUNDED')),
  due_at                TEXT,
  payment_reference     TEXT,
  payment_entry_id      TEXT,
  settlement_reference  TEXT,
  settlement_entry_id   TEXT,
  funds_available_at    TEXT,
  state_reason          TEXT,
  issued_at             TEXT NOT NULL,
  paid_at               TEXT,
  settled_at            TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  CHECK (state NOT IN ('PAID', 'SETTLED', 'REFUNDED') OR payment_entry_id IS NOT NULL),
  CHECK (state <> 'SETTLED' OR settlement_entry_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_invoices_provider
  ON cash_invoices(project_id, provider, provider_reference);
CREATE INDEX IF NOT EXISTS idx_cash_invoices_obligation
  ON cash_invoices(obligation_id);
