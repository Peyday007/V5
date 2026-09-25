-- A person's reading of a Claude subscription gauge. Brain records the source
-- and time; its own fire ledger is a separate measurement. Keep each report so
-- a routing decision can be explained from the value visible at the time.
CREATE TABLE fleet_allowance_reports (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES fleet_accounts(id) ON DELETE CASCADE,
  remaining_percent INTEGER NOT NULL CHECK (remaining_percent BETWEEN 0 AND 100),
  reported_at TEXT NOT NULL,
  reported_by TEXT NOT NULL REFERENCES users(id)
);
CREATE INDEX idx_fleet_allowance_reports_latest
  ON fleet_allowance_reports (account_id, reported_at DESC);
