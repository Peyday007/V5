-- ---------------------------------------------------------------------------
-- WORK ROUTING: WHICH RESOURCE RAN EACH UNIT, AND WHY
-- ---------------------------------------------------------------------------
--
-- Additive only.
--   work_routing_decisions  one row per unit of work routed: the resource chosen
--                           (CODE, CHEAP or STRONG), the reasons, the
--                           alternatives considered, any reused result, the
--                           failure class, escalation, outcome and validation.
--                           Append-only apart from recording the outcome once.
--   routing_baselines       a measurement of current routing before behaviour
--                           changed, kept so a later figure has something to
--                           be compared with.
--   provider_capacity       what a free provider/model last told us: its limit,
--                           the window, a cooldown, the last failure. Written
--                           from refusals and measurements only.
--   fleet_accounts.routing_preference  NORMAL or LAST_RESORT. Data, not an
--                           access grant: it only orders accounts that are
--                           already eligible.
-- Every decision carries its project; reads are scoped to one.
CREATE TABLE work_routing_decisions (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL,
  work_kind          TEXT NOT NULL,
  work_ref           TEXT NOT NULL,
  resource           TEXT NOT NULL CHECK (resource IN ('CODE', 'CHEAP', 'STRONG')),
  reasons            TEXT NOT NULL,
  alternatives       TEXT NOT NULL,
  reused_result_id   TEXT,
  failure_class      TEXT CHECK (failure_class IS NULL OR failure_class IN
                       ('TRANSIENT_PROVIDER', 'RATE_LIMITED', 'PROVIDER_DOWN', 'SOURCE_UNAVAILABLE',
                        'MALFORMED_OUTPUT', 'MISSING_INPUT', 'CAPABILITY_GAP', 'UNSOLVABLE')),
  escalated_from     TEXT CHECK (escalated_from IS NULL OR escalated_from IN ('CODE', 'CHEAP', 'STRONG')),
  outcome            TEXT NOT NULL DEFAULT 'PENDING'
                       CHECK (outcome IN ('PENDING', 'SUCCEEDED', 'FAILED', 'REUSED', 'PREVENTED')),
  validation_result  TEXT CHECK (validation_result IS NULL OR validation_result IN ('PASSED', 'FAILED', 'NOT_RUN')),
  decided_at         TEXT NOT NULL,
  settled_at         TEXT,
  UNIQUE (project_id, work_kind, work_ref, decided_at)
);
CREATE INDEX idx_work_routing_project ON work_routing_decisions (project_id, decided_at);
CREATE INDEX idx_work_routing_resource ON work_routing_decisions (project_id, resource, outcome);

CREATE TABLE routing_baselines (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  label        TEXT NOT NULL,
  window_from  TEXT NOT NULL,
  window_to    TEXT NOT NULL,
  measurements TEXT NOT NULL,
  recorded_at  TEXT NOT NULL
);
CREATE INDEX idx_routing_baselines_project ON routing_baselines (project_id, recorded_at);

CREATE TABLE provider_capacity (
  id                TEXT PRIMARY KEY,
  provider          TEXT NOT NULL,
  model             TEXT NOT NULL,
  limit_value       INTEGER,
  limit_unit        TEXT,
  window_seconds    INTEGER,
  cooldown_until    TEXT,
  last_failure_at   TEXT,
  last_failure_note TEXT,
  updated_at        TEXT NOT NULL,
  UNIQUE (provider, model)
);

ALTER TABLE fleet_accounts ADD COLUMN routing_preference TEXT NOT NULL DEFAULT 'NORMAL'
  CHECK (routing_preference IN ('NORMAL', 'LAST_RESORT'));
