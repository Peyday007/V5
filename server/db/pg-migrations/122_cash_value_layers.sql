-- ---------------------------------------------------------------------------
-- THE SEVEN VALUES AN OPPORTUNITY CAN BE SAID TO HAVE, KEPT APART
-- ---------------------------------------------------------------------------
--
-- A listed price, a published award, a buyer's budget and money in the account
-- are all "value" and only the last is cash. One row per opportunity per layer,
-- each carrying where it came from and whether it is VERIFIED, an ESTIMATE or
-- UNKNOWN. An UNKNOWN layer holds no amount: a blank is a blank, never a zero
-- and never a favourable assumption. Nothing here sums the layers; which of
-- them may count toward a goal is decided in code, from rows.
CREATE TABLE IF NOT EXISTS cash_value_layers (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  opportunity_id TEXT NOT NULL,
  layer TEXT NOT NULL CHECK (layer IN (
    'ADVERTISED_VALUE', 'TRANSACTION_EVIDENCE', 'BUYER_DEMAND', 'ACCESSIBILITY',
    'COST_AND_CAPITAL', 'REALISTIC_REVENUE', 'LEDGER')),
  status TEXT NOT NULL CHECK (status IN ('VERIFIED', 'ESTIMATE', 'UNKNOWN')),
  amount_cents INTEGER CHECK (amount_cents IS NULL OR amount_cents >= 0),
  currency TEXT,
  source TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (opportunity_id, layer),
  CHECK (status <> 'UNKNOWN' OR amount_cents IS NULL)
);
CREATE INDEX IF NOT EXISTS idx_cash_value_layers_project ON cash_value_layers (project_id, opportunity_id);
