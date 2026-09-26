-- The factory's production line.
--
-- A queue entry is an objective a person has already approved, waiting for a
-- free slot. Queueing *is* that person's approval, recorded when they queue it;
-- what Brain decides afterwards is only *when* the campaign starts, never
-- whether it is authorized. The admission policy is append-only for the same
-- reason `fleet_policy` is: the previous limit stays readable, so reverting a
-- concurrency step needs no memory of what it used to be.
CREATE TABLE factory_queue_entries (
  id TEXT PRIMARY KEY,
  change_request_id TEXT NOT NULL UNIQUE REFERENCES factory_change_requests(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  priority INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('QUEUED', 'STARTED', 'WITHDRAWN')),
  queued_by_user_id TEXT NOT NULL REFERENCES users(id),
  queued_at TEXT NOT NULL,
  campaign_id TEXT REFERENCES factory_campaigns(id),
  started_at TEXT,
  withdrawn_at TEXT,
  withdraw_reason TEXT
);
CREATE INDEX idx_factory_queue_next ON factory_queue_entries (state, priority, queued_at);

CREATE TABLE factory_admission_policy (
  id TEXT PRIMARY KEY,
  max_active INTEGER NOT NULL CHECK (max_active >= 0),
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_factory_admission_latest ON factory_admission_policy (created_at DESC);
