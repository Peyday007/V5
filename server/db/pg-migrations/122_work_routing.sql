-- ---------------------------------------------------------------------------
-- WHICH RESOURCE RAN A UNIT OF WORK, AND WHY
-- ---------------------------------------------------------------------------
--
-- One ledger of routing decisions (plain code, the free cheap lane, or Claude),
-- the baseline taken before routing changed, the capacity and cooldown of each
-- free provider and model, and a per-account routing preference.
--
-- All of it is additive. `routing_preference` is data about how an account is
-- ordered when several are eligible; it is NOT an access grant, and NORMAL is
-- what every existing account keeps.

CREATE TABLE work_routing_decisions (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL,
  -- What the unit of work was, in the vocabulary of whatever asked for it.
  work_kind           TEXT NOT NULL,
  work_ref            TEXT,
  resource            TEXT NOT NULL CHECK (resource IN ('CODE', 'CHEAP', 'STRONG')),
  reasons             TEXT NOT NULL DEFAULT '[]',
  alternatives        TEXT NOT NULL DEFAULT '[]',
  reused_result_id    TEXT,
  failure_class       TEXT,
  escalated_from      TEXT CHECK (escalated_from IS NULL OR escalated_from IN ('CODE', 'CHEAP', 'STRONG')),
  outcome             TEXT,
  validation_result   TEXT,
  -- General means a method or algorithm that may be read across projects.
  general             INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  settled_at          TEXT
);
CREATE INDEX idx_work_routing_project ON work_routing_decisions (project_id, created_at);
CREATE INDEX idx_work_routing_work ON work_routing_decisions (project_id, work_kind, work_ref);

CREATE TABLE routing_baselines (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  label         TEXT NOT NULL,
  -- The measured figures as JSON; a figure Brain could not measure is absent, never zero.
  readings      TEXT NOT NULL,
  taken_at      TEXT NOT NULL
);
CREATE INDEX idx_routing_baselines_project ON routing_baselines (project_id, taken_at);

CREATE TABLE provider_capacity (
  provider        TEXT NOT NULL,
  model           TEXT NOT NULL,
  -- What the provider itself said, when it said anything; null otherwise.
  limit_value     INTEGER,
  window_seconds  INTEGER,
  cooldown_until  TEXT,
  last_failure    TEXT,
  last_failure_at TEXT,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (provider, model)
);

ALTER TABLE fleet_accounts ADD COLUMN routing_preference TEXT NOT NULL DEFAULT 'NORMAL'
  CHECK (routing_preference IN ('NORMAL', 'LAST_RESORT'));
