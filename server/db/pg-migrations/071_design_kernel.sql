-- The Postgres half of SQLite migration 080. See that file for why a render is
-- the evidence and code is not, why a capture is bound to the bytes and to the
-- revision, why a measurement and a judgement are never one column, why the
-- taxonomy is seeded rather than declared, and why an owner correction is
-- evidence with a scope rather than a global rule.
--
-- Every table here carries `seq BIGSERIAL`, which is the identity column
-- `dialect.ts` rewrites `rowid` to. §25 and §27 both record what its absence
-- costs: a tiebreak on a column only one dialect has passes the whole SQLite
-- suite and throws in production.
--
-- `tree_dirty` is an INTEGER here rather than a BOOLEAN on purpose. Booleans are
-- 0/1 in the database and real booleans in view types, and the repositories are
-- the only place the two representations meet — so a column that was BOOLEAN on
-- one backend and INTEGER on the other would make the mapper correct in exactly
-- one of them.

CREATE TABLE IF NOT EXISTS design_surfaces (
  id             TEXT PRIMARY KEY,
  surface_key    TEXT NOT NULL UNIQUE,
  screen         TEXT NOT NULL,
  state_key      TEXT NOT NULL,
  title          TEXT NOT NULL,
  route          TEXT NOT NULL,
  preconditions  TEXT NOT NULL,
  concepts       TEXT NOT NULL,
  actions        TEXT NOT NULL,
  viewports      TEXT NOT NULL,
  faculty        TEXT,
  registered_by  TEXT NOT NULL,
  retired_at     TEXT,
  retired_reason TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  seq            BIGSERIAL,
  CHECK ((retired_at IS NULL) = (retired_reason IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_design_surfaces_screen ON design_surfaces (screen, state_key);


CREATE TABLE IF NOT EXISTS design_cycles (
  id           TEXT PRIMARY KEY,
  trigger_kind TEXT NOT NULL,
  trigger_ref  TEXT,
  surface_keys TEXT NOT NULL,
  revision     TEXT,
  passes       INTEGER NOT NULL DEFAULT 0,
  state        TEXT NOT NULL,
  stop_reason  TEXT,
  stop_detail  TEXT,
  opened_at    TEXT NOT NULL,
  closed_at    TEXT,
  seq          BIGSERIAL,
  CHECK (trigger_kind IN ('UI_IMPACT', 'SURFACE_REGISTERED', 'OWNER_REQUEST',
                     'PROACTIVE_EXPANSION', 'CORRECTION_FOLLOW_UP', 'SCHEDULED')),
  CHECK (passes >= 0),
  CHECK (state IN ('OPEN', 'CLOSED')),
  CHECK (stop_reason IS NULL OR stop_reason IN (
           'SETTLED', 'REPAIR_EXHAUSTED', 'NO_RENDER_RUNTIME', 'NEEDS_PERSON', 'ABANDONED')),
  CHECK ((state = 'CLOSED') = (closed_at IS NOT NULL)),
  CHECK (state = 'OPEN' OR stop_reason IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_design_cycles_state ON design_cycles (state, opened_at);


CREATE TABLE IF NOT EXISTS design_captures (
  id             TEXT PRIMARY KEY,
  cycle_id       TEXT REFERENCES design_cycles(id) ON DELETE SET NULL,
  pass           INTEGER NOT NULL DEFAULT 0,
  surface_key    TEXT NOT NULL,
  screen         TEXT NOT NULL,
  state_key      TEXT NOT NULL,
  viewport_name  TEXT NOT NULL,
  width          INTEGER NOT NULL,
  height         INTEGER NOT NULL,
  revision       TEXT,
  tree_dirty     INTEGER NOT NULL DEFAULT 0,
  content_hash   TEXT NOT NULL,
  byte_size      INTEGER NOT NULL,
  artifact_ref   TEXT NOT NULL,
  engine         TEXT NOT NULL,
  engine_version TEXT,
  readings       TEXT NOT NULL,
  captured_at    TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  seq            BIGSERIAL,
  CHECK (pass >= 0),
  CHECK (width > 0),
  CHECK (height > 0),
  CHECK (tree_dirty IN (0, 1)),
  CHECK (byte_size >= 0)
);
CREATE INDEX IF NOT EXISTS idx_design_captures_surface ON design_captures (surface_key, captured_at);
CREATE INDEX IF NOT EXISTS idx_design_captures_cycle ON design_captures (cycle_id, pass);
CREATE INDEX IF NOT EXISTS idx_design_captures_hash ON design_captures (content_hash);


CREATE TABLE IF NOT EXISTS design_reviews (
  id                TEXT PRIMARY KEY,
  cycle_id          TEXT NOT NULL REFERENCES design_cycles(id) ON DELETE CASCADE,
  pass              INTEGER NOT NULL DEFAULT 0,
  lane              TEXT NOT NULL,
  capture_digest    TEXT NOT NULL,
  capture_count     INTEGER NOT NULL,
  bin_id            TEXT REFERENCES bins(id) ON DELETE SET NULL,
  worker_id         TEXT,
  session_ref       TEXT,
  account_id        TEXT,
  routine_id        TEXT,
  independence_tier TEXT,
  verdict           TEXT NOT NULL,
  detail            TEXT,
  findings_count    INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  seq               BIGSERIAL,
  CHECK (pass >= 0),
  CHECK (lane IN ('MEASURED', 'JUDGED')),
  CHECK (capture_count >= 0),
  CHECK (independence_tier IS NULL OR independence_tier IN (
           'NOT_APPLICABLE', 'SESSION_SEPARATED', 'ROUTINE_SEPARATED',
           'WORKER_SEPARATED', 'ACCOUNT_SEPARATED')),
  CHECK (verdict IN ('CLEAN', 'CHANGES_REQUIRED', 'REFUSED')),
  CHECK (findings_count >= 0),
  CHECK (lane = 'MEASURED' OR (worker_id IS NOT NULL AND session_ref IS NOT NULL)),
  CHECK (lane = 'JUDGED' OR independence_tier = 'NOT_APPLICABLE')
);
CREATE INDEX IF NOT EXISTS idx_design_reviews_cycle ON design_reviews (cycle_id, pass);


CREATE TABLE IF NOT EXISTS design_findings (
  id              TEXT PRIMARY KEY,
  cycle_id        TEXT REFERENCES design_cycles(id) ON DELETE SET NULL,
  review_id       TEXT REFERENCES design_reviews(id) ON DELETE SET NULL,
  capture_id      TEXT NOT NULL REFERENCES design_captures(id) ON DELETE CASCADE,
  pass            INTEGER NOT NULL DEFAULT 0,
  surface_key     TEXT NOT NULL,
  region          TEXT NOT NULL,
  lane            TEXT NOT NULL,
  kind            TEXT NOT NULL,
  primitive       TEXT NOT NULL,
  statement       TEXT NOT NULL,
  why_it_matters  TEXT NOT NULL,
  severity        TEXT NOT NULL,
  evidence        TEXT NOT NULL,
  proposed_repair TEXT NOT NULL,
  state           TEXT NOT NULL,
  resolved_by     TEXT,
  resolution      TEXT,
  pattern_id      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  seq             BIGSERIAL,
  CHECK (pass >= 0),
  CHECK (lane IN ('MEASURED', 'JUDGED', 'OWNER')),
  CHECK (kind IN (
           'CONTENT_CLIPPED', 'HORIZONTAL_OVERFLOW', 'CONTROL_UNREACHABLE',
           'CONTROL_OVERLAPPED', 'CONTENT_MISSING', 'CONTRAST_BELOW_FLOOR',
           'TOUCH_TARGET_TOO_SMALL', 'RESPONSIVE_REGRESSION', 'EMPTY_STATE_MALFORMED',
           'HIERARCHY_UNCLEAR', 'EMPHASIS_MISPLACED', 'DENSITY_WRONG',
           'GROUPING_INCOHERENT', 'CONTAINER_NESTING_EXCESSIVE',
           'CONTROL_REDUNDANT', 'STATUS_CONTRADICTS_CONTROL', 'PURPOSE_MISMATCH')),
  CHECK (severity IN ('BLOCKER', 'MAJOR', 'MINOR', 'NIT')),
  CHECK (state IN ('OPEN', 'REPAIRED', 'ACCEPTED', 'WONT_FIX', 'UNRESOLVED', 'SUPERSEDED')),
  CHECK (state = 'OPEN' OR resolution IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_design_findings_cycle ON design_findings (cycle_id, state);
CREATE INDEX IF NOT EXISTS idx_design_findings_surface ON design_findings (surface_key, created_at);
CREATE INDEX IF NOT EXISTS idx_design_findings_primitive ON design_findings (primitive, lane);
CREATE UNIQUE INDEX IF NOT EXISTS idx_design_findings_once
  ON design_findings (capture_id, kind, region, COALESCE(review_id, '-'));


CREATE TABLE IF NOT EXISTS design_corrections (
  id                  TEXT PRIMARY KEY,
  surface_key         TEXT,
  before_capture_id   TEXT REFERENCES design_captures(id) ON DELETE SET NULL,
  after_capture_id    TEXT REFERENCES design_captures(id) ON DELETE SET NULL,
  correction          TEXT NOT NULL,
  components          TEXT NOT NULL,
  lesson              TEXT,
  scope               TEXT NOT NULL,
  scope_ref           TEXT,
  confidence          TEXT NOT NULL,
  recorded_by_user_id TEXT NOT NULL,
  promoted_pattern_id TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  seq                 BIGSERIAL,
  CHECK (scope IN ('ONE_OFF', 'COMPONENT', 'SCREEN', 'FACULTY', 'GLOBAL')),
  CHECK (confidence IN ('LOW', 'MEDIUM', 'HIGH')),
  CHECK (scope IN ('ONE_OFF', 'GLOBAL') OR scope_ref IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_design_corrections_surface ON design_corrections (surface_key, created_at);
CREATE INDEX IF NOT EXISTS idx_design_corrections_scope ON design_corrections (scope, scope_ref);


CREATE TABLE IF NOT EXISTS design_patterns (
  id             TEXT PRIMARY KEY,
  primitive      TEXT NOT NULL,
  branch         TEXT,
  statement      TEXT NOT NULL,
  applies_when   TEXT NOT NULL,
  exceptions     TEXT,
  scope          TEXT NOT NULL,
  scope_ref      TEXT,
  confidence     TEXT NOT NULL,
  origin         TEXT NOT NULL,
  evidence       TEXT NOT NULL,
  state          TEXT NOT NULL,
  retired_reason TEXT,
  fingerprint    TEXT NOT NULL UNIQUE,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  seq            BIGSERIAL,
  CHECK (scope IN ('ONE_OFF', 'COMPONENT', 'SCREEN', 'FACULTY', 'GLOBAL')),
  CHECK (confidence IN ('LOW', 'MEDIUM', 'HIGH')),
  CHECK (origin IN ('SEED', 'RESEARCH', 'CORRECTION', 'OPERATION')),
  CHECK (state IN ('PROPOSED', 'ACTIVE', 'RETIRED')),
  CHECK (scope IN ('ONE_OFF', 'GLOBAL') OR scope_ref IS NOT NULL),
  CHECK ((state = 'RETIRED') = (retired_reason IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_design_patterns_primitive ON design_patterns (primitive, state);
CREATE INDEX IF NOT EXISTS idx_design_patterns_branch ON design_patterns (branch);


CREATE TABLE IF NOT EXISTS design_capabilities (
  id                TEXT PRIMARY KEY,
  capability_key    TEXT NOT NULL UNIQUE,
  title             TEXT NOT NULL,
  primitive         TEXT NOT NULL,
  ability_state     TEXT NOT NULL DEFAULT 'ABSENT',
  evidence_state    TEXT NOT NULL DEFAULT 'UNTESTED',
  route             TEXT,
  evaluation_method TEXT,
  limitations       TEXT NOT NULL,
  evidence          TEXT NOT NULL,
  observations      INTEGER NOT NULL DEFAULT 0,
  failures          INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  seq               BIGSERIAL,
  CHECK (ability_state IN ('ABSENT', 'PARTIAL', 'CONNECTED', 'LIVE')),
  CHECK (evidence_state IN ('UNTESTED', 'FAILING', 'PASSING', 'PRODUCTION_PROVEN')),
  CHECK (observations >= 0),
  CHECK (failures >= 0),
  CHECK (evidence_state = 'UNTESTED' OR evaluation_method IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_design_capabilities_state
  ON design_capabilities (ability_state, evidence_state);


CREATE TABLE IF NOT EXISTS design_capability_events (
  id             TEXT PRIMARY KEY,
  capability_key TEXT NOT NULL,
  dimension      TEXT NOT NULL,
  from_state     TEXT NOT NULL,
  to_state       TEXT NOT NULL,
  reason         TEXT NOT NULL,
  evidence_ref   TEXT,
  actor_type     TEXT NOT NULL,
  actor_id       TEXT,
  created_at     TEXT NOT NULL,
  seq            BIGSERIAL,
  CHECK (dimension IN ('ABILITY', 'EVIDENCE'))
);
CREATE INDEX IF NOT EXISTS idx_design_capability_events_key
  ON design_capability_events (capability_key, created_at);


CREATE TABLE IF NOT EXISTS design_expansions (
  id             TEXT PRIMARY KEY,
  capability_key TEXT NOT NULL,
  origin         TEXT NOT NULL,
  statement      TEXT NOT NULL,
  why            TEXT NOT NULL,
  rank_inputs    TEXT NOT NULL,
  rank           INTEGER NOT NULL,
  route          TEXT NOT NULL,
  route_ref      TEXT,
  state          TEXT NOT NULL,
  outcome        TEXT,
  evidence       TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  seq            BIGSERIAL,
  CHECK (origin IN ('PROACTIVE', 'FAILURE', 'CORRECTION', 'OWNER_REQUEST')),
  CHECK (route IN ('RESEARCH', 'SOFTWARE', 'READING', 'PERSON')),
  CHECK (state IN ('IDENTIFIED', 'ROUTED', 'EVALUATED', 'PROMOTED', 'REJECTED', 'PARKED')),
  CHECK (state IN ('IDENTIFIED', 'ROUTED') OR outcome IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_design_expansions_state ON design_expansions (state, rank);
CREATE INDEX IF NOT EXISTS idx_design_expansions_capability
  ON design_expansions (capability_key, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_design_expansions_live
  ON design_expansions (capability_key) WHERE state IN ('IDENTIFIED', 'ROUTED');
