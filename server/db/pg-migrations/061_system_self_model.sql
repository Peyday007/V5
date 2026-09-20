-- The Postgres half of SQLite migration 070. See that file for why there are
-- seven levels with three answers each, and why a derived reading is stored.
--
-- `seq BIGSERIAL` on every table: the identity column `dialect.ts` rewrites
-- `rowid` to, whose absence §25 records as costing three cursor-ordered queries
-- that passed on SQLite and failed on the cloud backend.

CREATE TABLE IF NOT EXISTS system_components (
  id              TEXT PRIMARY KEY,
  component_key   TEXT NOT NULL UNIQUE,
  kind            TEXT NOT NULL,
  name            TEXT NOT NULL,
  detail          TEXT,
  documented        TEXT NOT NULL DEFAULT 'UNKNOWN',
  in_source         TEXT NOT NULL DEFAULT 'UNKNOWN',
  connected         TEXT NOT NULL DEFAULT 'UNKNOWN',
  deployed          TEXT NOT NULL DEFAULT 'UNKNOWN',
  observed_active   TEXT NOT NULL DEFAULT 'UNKNOWN',
  evaluated         TEXT NOT NULL DEFAULT 'UNKNOWN',
  production_proven TEXT NOT NULL DEFAULT 'UNKNOWN',
  evidence        TEXT NOT NULL,
  revision        TEXT,
  observed_at     TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  seq             BIGSERIAL,
  CHECK (kind IN ('MIGRATION', 'WORK_TYPE', 'BIN_CONTRACT', 'MCP_TOOL', 'HTTP_ROUTE',
                  'SERVICE_MODULE', 'REPOSITORY_MODULE', 'STORAGE_PROVIDER',
                  'FLEET_ACCOUNT', 'FLEET_ROUTINE', 'WORKER_IDENTITY',
                  'EVALUATION_SUITE', 'PROVIDER', 'SURFACE', 'KNOWLEDGE_SCOPE')),
  CHECK (documented IN ('YES','NO','UNKNOWN')),
  CHECK (in_source IN ('YES','NO','UNKNOWN')),
  CHECK (connected IN ('YES','NO','UNKNOWN')),
  CHECK (deployed IN ('YES','NO','UNKNOWN')),
  CHECK (observed_active IN ('YES','NO','UNKNOWN')),
  CHECK (evaluated IN ('YES','NO','UNKNOWN')),
  CHECK (production_proven IN ('YES','NO','UNKNOWN'))
);
CREATE INDEX IF NOT EXISTS idx_system_components_kind ON system_components (kind, name);

CREATE TABLE IF NOT EXISTS system_component_events (
  id            TEXT PRIMARY KEY,
  component_key TEXT NOT NULL,
  level         TEXT NOT NULL,
  from_answer   TEXT NOT NULL,
  to_answer     TEXT NOT NULL,
  evidence      TEXT NOT NULL,
  revision      TEXT,
  created_at    TEXT NOT NULL,
  seq           BIGSERIAL,
  CHECK (level IN ('DOCUMENTED', 'IN_SOURCE', 'CONNECTED', 'DEPLOYED',
                   'OBSERVED_ACTIVE', 'EVALUATED', 'PRODUCTION_PROVEN'))
);
CREATE INDEX IF NOT EXISTS idx_system_component_events_key
  ON system_component_events (component_key, created_at);

CREATE TABLE IF NOT EXISTS system_scans (
  id           TEXT PRIMARY KEY,
  reason       TEXT NOT NULL,
  revision     TEXT,
  components   INTEGER NOT NULL,
  drift        INTEGER NOT NULL,
  unreadable   TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  finished_at  TEXT NOT NULL,
  seq          BIGSERIAL,
  CHECK (reason IN ('BOOT', 'MIGRATION_APPLIED', 'DEPLOYMENT', 'SCHEDULED',
                    'CAPABILITY_PROMOTED', 'FACTORY_INTEGRATION', 'REQUESTED'))
);
CREATE INDEX IF NOT EXISTS idx_system_scans_started ON system_scans (started_at);
