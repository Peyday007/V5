-- ---------------------------------------------------------------------------
-- INBOX PROCUREMENT (§110, invariants 18, 26, 37, 38)
--
-- The owner puts money in; Brain buys sending inboxes with it — pre-warmed
-- ones through Instantly, new ones it builds through InboxKit (domain, DNS,
-- mailboxes, export to Instantly) — and nothing else spends it.
--
-- Every table is append-only. A balance is never stored: what is left is the
-- funds added minus every purchase that is not REFUSED, so a purchase whose
-- outcome is UNKNOWN counts as spent (invariant 26) and is never retried.
--
-- `inbox_funds`: ADD_FUNDS adds to the one-off pot; SET_MONTHLY_CEILING
-- replaces the ceiling on the recurring total (the latest row wins).
-- `inbox_purchases`: one row per order attempt, one domain each, its quote
-- recorded before the order is placed. `purchase_key` is unique, so a retry of
-- the same order is the same row and can never become a second purchase.
-- `inbox_purchase_outcomes`: what the provider said, appended; the latest row
-- is the purchase's state (an UNKNOWN later reconciled appends PLACED).
-- ---------------------------------------------------------------------------

CREATE TABLE inbox_funds (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('ADD_FUNDS', 'SET_MONTHLY_CEILING')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  actor        TEXT NOT NULL,
  note         TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_inbox_funds_created ON inbox_funds (created_at);

CREATE TABLE inbox_purchases (
  id                   TEXT PRIMARY KEY,
  purchase_key         TEXT NOT NULL UNIQUE,
  provider             TEXT NOT NULL CHECK (provider IN ('INSTANTLY', 'INBOXKIT')),
  kind                 TEXT NOT NULL CHECK (kind IN ('PREWARMED', 'NEW')),
  domain               TEXT NOT NULL,
  mailboxes            INTEGER NOT NULL CHECK (mailboxes > 0),
  upfront_cents        INTEGER NOT NULL CHECK (upfront_cents >= 0),
  monthly_cents        INTEGER NOT NULL CHECK (monthly_cents >= 0),
  quote                TEXT NOT NULL DEFAULT '{}',
  actor                TEXT NOT NULL,
  created_at           TEXT NOT NULL
);
CREATE INDEX idx_inbox_purchases_created ON inbox_purchases (created_at);

CREATE TABLE inbox_purchase_outcomes (
  id           TEXT PRIMARY KEY,
  purchase_id  TEXT NOT NULL REFERENCES inbox_purchases (id),
  outcome      TEXT NOT NULL CHECK (outcome IN ('PLACED', 'REFUSED', 'UNKNOWN', 'WARMUP_ENABLED')),
  detail       TEXT NOT NULL,
  receipt      TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_inbox_purchase_outcomes_purchase ON inbox_purchase_outcomes (purchase_id, created_at);
