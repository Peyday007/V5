-- The Postgres half of SQLite migration 092. See that file for what each
-- table refuses to hold. `seq BIGSERIAL` is the identity column `db/dialect.ts`
-- rewrites `rowid` to.

CREATE TABLE IF NOT EXISTS external_connections (
  seq BIGSERIAL,
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id),
  provider          TEXT NOT NULL CHECK (provider IN ('NTFY', 'RESEND', 'STRIPE')),
  label             TEXT NOT NULL,
  -- The deployment secret's NAME. Assigned by Brain so nobody has to invent one
  -- and two connections cannot choose the same.
  secret_name       TEXT NOT NULL,
  -- Where a self-directed action goes, when the provider has one that is not
  -- itself a secret (an owner's own inbox). NULL for ntfy, whose topic IS the
  -- credential and therefore lives only in the secret.
  self_destination  TEXT,
  -- The From address an email connection sends as. Not a secret.
  sender            TEXT,
  state             TEXT NOT NULL CHECK (state IN ('ACTIVE', 'REVOKED')),
  connected_by      TEXT NOT NULL,
  revoked_by        TEXT,
  revoked_reason    TEXT,
  revoked_at        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  CHECK (state = 'ACTIVE' OR (revoked_by IS NOT NULL AND revoked_at IS NOT NULL))
);

-- One live connection per provider per project. A reconnect is a new row, so
-- the revoked one keeps its history and none of its health checks carry over.
CREATE UNIQUE INDEX IF NOT EXISTS idx_external_connections_live
  ON external_connections(project_id, provider) WHERE state = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_external_connections_project
  ON external_connections(project_id, state);

CREATE TABLE IF NOT EXISTS external_health_checks (
  seq BIGSERIAL,
  id                 TEXT PRIMARY KEY,
  connection_id      TEXT NOT NULL,
  ok                 INTEGER NOT NULL CHECK (ok IN (0, 1)),
  -- TEST or LIVE, as the provider itself answered. NULL when it did not answer.
  mode               TEXT CHECK (mode IS NULL OR mode IN ('TEST', 'LIVE')),
  credential_digest  TEXT,
  detail             TEXT NOT NULL,
  checked_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_external_health_checks_connection
  ON external_health_checks(connection_id, checked_at);

CREATE TABLE IF NOT EXISTS external_actions (
  seq BIGSERIAL,
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id),
  connection_id      TEXT NOT NULL REFERENCES external_connections(id),
  kind               TEXT NOT NULL CHECK (kind IN ('NOTIFY_OWNER', 'SEND_EMAIL', 'ISSUE_INVOICE')),
  -- The COMMERCIAL_ACTIONS entry the standing grant is asked about. NULL for a
  -- self-directed notification, which contacts nobody and commits nothing.
  commercial_action  TEXT,
  opportunity_id     TEXT,
  conversation_id    TEXT,
  destination        TEXT NOT NULL,
  content            TEXT NOT NULL,
  expected_effect    TEXT NOT NULL,
  amount_cents       INTEGER CHECK (amount_cents IS NULL OR amount_cents > 0),
  currency           TEXT,
  state              TEXT NOT NULL CHECK (state IN (
                       'AWAITING_APPROVAL', 'APPROVED', 'SENDING', 'CONFIRMED',
                       'REFUSED', 'FAILED', 'UNCERTAIN', 'CANCELLED')),
  approval_required  INTEGER NOT NULL CHECK (approval_required IN (0, 1)),
  requested_by_type  TEXT NOT NULL,
  requested_by       TEXT NOT NULL,
  approved_by        TEXT,
  approved_at        TEXT,
  request_key        TEXT NOT NULL,
  operation_id       TEXT,
  provider_ref       TEXT,
  outcome_detail     TEXT,
  attempts           INTEGER NOT NULL DEFAULT 0,
  next_attempt_at    TEXT,
  readback_state     TEXT,
  readback_detail    TEXT,
  readback_at        TEXT,
  readback_final     INTEGER NOT NULL DEFAULT 0 CHECK (readback_final IN (0, 1)),
  returned_at        TEXT,
  resolved_by        TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  -- An action that needs a person cannot have been sent without one.
  CHECK (approval_required = 0 OR state IN ('AWAITING_APPROVAL', 'CANCELLED')
         OR approved_by IS NOT NULL),
  -- A confirmed action carries the provider's own identifier, or it is not
  -- confirmed.
  CHECK (state <> 'CONFIRMED' OR provider_ref IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_external_actions_key
  ON external_actions(project_id, request_key);

CREATE INDEX IF NOT EXISTS idx_external_actions_state
  ON external_actions(state, next_attempt_at);

CREATE INDEX IF NOT EXISTS idx_external_actions_project
  ON external_actions(project_id, created_at);

-- Append-only, and deliberately without foreign keys: an audit row a cascade
-- can delete is not an audit row.
CREATE TABLE IF NOT EXISTS external_action_events (
  seq BIGSERIAL,
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  action_id   TEXT,
  connection_id TEXT,
  kind        TEXT NOT NULL,
  actor_ref   TEXT NOT NULL,
  summary     TEXT NOT NULL,
  detail      TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_external_action_events_action
  ON external_action_events(action_id, created_at);

CREATE INDEX IF NOT EXISTS idx_external_action_events_project
  ON external_action_events(project_id, created_at);
