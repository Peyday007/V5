-- One invoice Brain issues for one agreed amount, and what the provider says
-- happened to its money (CLAUDE.md §52, services/cash/invoicing.ts).
-- Postgres chain: 095_cash_invoices.sql.
--
-- Nothing here is a figure Brain chose. The amount and the currency are copied
-- from the PIPELINE_AGREED ledger entry the row names (`pipeline_entry_id`),
-- and the customer, the tax treatment and the due date are what a person
-- recorded. One live invoice per agreed amount (the partial unique index
-- below), whichever request or tick gets there first.
--
-- state is where the invoice is, never a verdict about the money:
--   DRAFTED    a person recorded the terms; nothing has been sent
--   ISSUED     the provider confirmed it; the buyer can pay
--   UNCERTAIN  the send left and its outcome is unknown; a need names it
--   FAILED     the provider refused it
--   PAID       the provider says the customer paid (CUSTOMER_PAYMENT recorded)
--   SETTLED    the provider says the funds are usable (SETTLEMENT recorded)
--   VOID       the provider says it was voided or written off
--
-- `hosted_url` is the provider's customer-facing payment page. It is not a
-- credential, and nothing here holds one.
CREATE TABLE cash_invoices (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  opportunity_id      TEXT NOT NULL,
  pipeline_entry_id   TEXT NOT NULL,
  amount_cents        INTEGER NOT NULL CHECK (amount_cents > 0),
  currency            TEXT NOT NULL,
  customer_name       TEXT NOT NULL,
  customer_email      TEXT NOT NULL,
  tax_treatment       TEXT NOT NULL
    CHECK (tax_treatment IN ('NO_TAX_CHARGED', 'TAX_EXEMPT', 'REVERSE_CHARGE')),
  due_date            TEXT NOT NULL,
  description         TEXT NOT NULL,
  provider            TEXT,
  state               TEXT NOT NULL
    CHECK (state IN ('DRAFTED', 'ISSUED', 'UNCERTAIN', 'FAILED', 'PAID', 'SETTLED', 'VOID')),
  state_reason        TEXT,
  provider_invoice_id TEXT,
  provider_status     TEXT,
  provider_number     TEXT,
  hosted_url          TEXT,
  payment_entry_id    TEXT,
  settlement_entry_id TEXT,
  issued_at           TEXT,
  paid_at             TEXT,
  settled_at          TEXT,
  last_read_at        TEXT,
  requested_by        TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

-- One LIVE invoice per agreed amount. A VOID or FAILED invoice is history and
-- keeps its row; the agreement it billed may be invoiced again, which the
-- partial index allows and the full one it replaced did not.
CREATE UNIQUE INDEX cash_invoices_live_entry
  ON cash_invoices (project_id, pipeline_entry_id)
  WHERE state NOT IN ('VOID', 'FAILED');

CREATE INDEX cash_invoices_project_state ON cash_invoices (project_id, state);
CREATE INDEX cash_invoices_opportunity ON cash_invoices (opportunity_id);
