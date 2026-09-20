-- ---------------------------------------------------------------------------
-- WHAT BRAIN CAN SAY ABOUT ITSELF, AND HOW IT KNOWS
--
-- A capability registry that could not be held against the running system would
-- be a wish list. This is the other half: an inventory of Brain's own parts,
-- where every assertion carries which *kind* of evidence answered it.
--
-- ---------------------------------------------------------------------------
-- Seven levels, three answers each
-- ---------------------------------------------------------------------------
--
-- The levels are documented, in source, connected, deployed, observed active,
-- evaluated and production-proven. They are not one ladder with a single
-- position on it, because a component can be deployed and never evaluated,
-- evaluated and never run in production, or documented and never written.
--
-- Each level answers YES, NO or UNKNOWN, and the third is the one that earns
-- its place. §30 already had to draw it once: *MISSING means Brain understands
-- the capability and does not have it; UNKNOWN means nobody has told Brain what
-- it is.* Here the live instance is evaluation coverage — `tests/` is not in the
-- deployment image, so a deployed Brain genuinely cannot read whether a
-- component is tested. Reporting that as NO would turn "we cannot see from
-- here" into "it is untested", which is a false statement about the repository
-- in the direction that causes work nobody needed.
--
-- ---------------------------------------------------------------------------
-- Derived, and stored anyway
-- ---------------------------------------------------------------------------
--
-- Every value here is re-derivable from the process, the filesystem and the
-- rows. The table exists for the two things a pure derivation cannot do, which
-- is the same argument §29 makes for the frontier: remember that a component
-- *stopped* being connected, and give drift somewhere to be noticed. So the
-- current reading is a row and every change to it is an append-only event.
--
-- Deleting every row here returns Brain exactly to what it did before.
-- ---------------------------------------------------------------------------

CREATE TABLE system_components (
  id              TEXT PRIMARY KEY,

  -- Derived from kind and name, so two observations of one thing are one row.
  -- Never supplied: a caller that could choose the key could split a component
  -- in two and make a drift look like a new part.
  component_key   TEXT NOT NULL UNIQUE,
  kind            TEXT NOT NULL CHECK (kind IN (
                    'MIGRATION', 'WORK_TYPE', 'BIN_CONTRACT', 'MCP_TOOL', 'HTTP_ROUTE',
                    'SERVICE_MODULE', 'REPOSITORY_MODULE', 'STORAGE_PROVIDER',
                    'FLEET_ACCOUNT', 'FLEET_ROUTINE', 'WORKER_IDENTITY',
                    'EVALUATION_SUITE', 'PROVIDER', 'SURFACE', 'KNOWLEDGE_SCOPE')),
  name            TEXT NOT NULL,
  detail          TEXT,

  -- Each level is one of YES / NO / UNKNOWN, as text rather than as two
  -- booleans, because the two-boolean encoding makes UNKNOWN unrepresentable
  -- and every reader eventually treats absent as false.
  documented        TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (documented IN ('YES','NO','UNKNOWN')),
  in_source         TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (in_source IN ('YES','NO','UNKNOWN')),
  connected         TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (connected IN ('YES','NO','UNKNOWN')),
  deployed          TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (deployed IN ('YES','NO','UNKNOWN')),
  observed_active   TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (observed_active IN ('YES','NO','UNKNOWN')),
  evaluated         TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (evaluated IN ('YES','NO','UNKNOWN')),
  production_proven TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (production_proven IN ('YES','NO','UNKNOWN')),

  -- What answered each level, per level, as JSON. A reading with no stated
  -- source is not checkable later, which is the same rule `faculty_state_events`
  -- applies to a dimension move.
  evidence        TEXT NOT NULL,

  -- The revision this reading was taken on, when the process was stamped. Null
  -- on an unstamped build rather than guessed — §27's rule about a deployment
  -- attesting its own commit, applied to a reading rather than to a report.
  revision        TEXT,
  observed_at     TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_system_components_kind ON system_components (kind, name);

-- ---------------------------------------------------------------------------
-- WHEN A READING CHANGED
--
-- Append-only, and written only when a level actually moves. A row per scan
-- would be a log of the scanner rather than a history of the system, and the
-- question somebody asks is "when did this stop being connected", which only
-- changes can answer.
-- ---------------------------------------------------------------------------
CREATE TABLE system_component_events (
  id            TEXT PRIMARY KEY,
  component_key TEXT NOT NULL,
  level         TEXT NOT NULL CHECK (level IN (
                  'DOCUMENTED', 'IN_SOURCE', 'CONNECTED', 'DEPLOYED',
                  'OBSERVED_ACTIVE', 'EVALUATED', 'PRODUCTION_PROVEN')),
  from_answer   TEXT NOT NULL,
  to_answer     TEXT NOT NULL,
  -- What the scan read to reach the new answer.
  evidence      TEXT NOT NULL,
  revision      TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_system_component_events_key
  ON system_component_events (component_key, created_at);

-- ---------------------------------------------------------------------------
-- WHEN THE SELF-MODEL WAS LAST LOOKED AT, AND WHY
--
-- A refresh trigger is a fact about the scan rather than about a component, so
-- it lives here. `reason` is the closed set of things that make the model
-- stale; `drift` counts the levels that moved, which is what makes a scan worth
-- reading at all — a scan that changed nothing is the common case and should
-- say so in one number rather than in six hundred rows.
-- ---------------------------------------------------------------------------
CREATE TABLE system_scans (
  id           TEXT PRIMARY KEY,
  reason       TEXT NOT NULL CHECK (reason IN (
                 'BOOT', 'MIGRATION_APPLIED', 'DEPLOYMENT', 'SCHEDULED',
                 'CAPABILITY_PROMOTED', 'FACTORY_INTEGRATION', 'REQUESTED')),
  revision     TEXT,
  components   INTEGER NOT NULL,
  drift        INTEGER NOT NULL,
  -- Anything the scan could not read, so an incomplete reading is visible
  -- rather than looking like a complete one with fewer parts.
  unreadable   TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  finished_at  TEXT NOT NULL
);
CREATE INDEX idx_system_scans_started ON system_scans (started_at);
