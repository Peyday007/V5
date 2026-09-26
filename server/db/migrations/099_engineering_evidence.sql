-- The engineering connector: what is already known, and what the policy stopped.
--
-- Three append-only tables. Nothing here is a verdict: the current reading of a
-- property is derived from the newest row of the highest-ranked source, so a
-- later FAILED or STALE never needs an UPDATE and history is never rewritten.
--
-- engineering_evidence   one observation of one property ("FULL_GATE:<sha>:postgres",
--                        "FACTORY_SURFACE:<routine>:repo:<owner/name>:push"). A worker
--                        may only write TEST or SYNTHETIC rows; CI, OPERATOR and
--                        REAL_PRODUCTION come from Brain's own readings or a shell.
-- engineering_interventions  what the deterministic policy refused, and what it
--                        offered instead. The metrics are counts over this table.
-- engineering_blockers   a genuine blocker, classified, so "Needs You" is a
--                        category with a reason rather than the default.
CREATE TABLE engineering_evidence (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  repository TEXT NOT NULL,
  property_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PROVEN', 'FAILED', 'STALE', 'UNKNOWN')),
  source_kind TEXT NOT NULL
    CHECK (source_kind IN ('REAL_PRODUCTION', 'CI', 'TEST', 'OPERATOR', 'SYNTHETIC')),
  evidence_ref TEXT NOT NULL,
  code_sha TEXT,
  config_fingerprint TEXT,
  proven_at TEXT NOT NULL,
  valid_until TEXT,
  invalidation_scope TEXT NOT NULL DEFAULT '[]',
  recorded_by_type TEXT NOT NULL CHECK (recorded_by_type IN ('BRAIN', 'WORKER', 'OPERATOR')),
  recorded_by_id TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_engineering_evidence_property
  ON engineering_evidence (repository, property_key, created_at);

CREATE TABLE engineering_interventions (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  task_ref TEXT,
  kind TEXT NOT NULL CHECK (kind IN (
    'OVERENGINEERING_BLOCKED', 'REDUNDANT_TEST_BLOCKED', 'BAD_WAIT_BLOCKED',
    'PREMATURE_STOP_PREVENTED', 'DUPLICATE_MECHANISM_BLOCKED',
    'UNNECESSARY_HUMAN_QUESTION', 'IDLE_WITH_EXECUTABLE_WORK', 'REAL_EVIDENCE_REUSED')),
  rule TEXT NOT NULL,
  attempted_action TEXT NOT NULL,
  replacement_action TEXT NOT NULL,
  minutes_avoided INTEGER,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_engineering_interventions_kind ON engineering_interventions (kind, created_at);

CREATE TABLE engineering_blockers (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  task_ref TEXT,
  kind TEXT NOT NULL CHECK (kind IN (
    'AUTO_WAIT', 'RETRYABLE', 'MISSING_AUTHORITY', 'HUMAN_DECISION',
    'EXTERNAL_SERVICE', 'DEFECT', 'AMBIGUOUS_REQUIREMENT')),
  statement TEXT NOT NULL,
  remedy TEXT NOT NULL,
  needs_human INTEGER NOT NULL CHECK (needs_human IN (0, 1)),
  checked TEXT NOT NULL DEFAULT '[]',
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
