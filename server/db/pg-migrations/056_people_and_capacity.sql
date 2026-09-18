-- The Postgres half of SQLite migration 065. See that file for why a person and
-- a capacity account are declared rather than recognised by their name, and why
-- connecting a Claude account is a durable row rather than a conversation.
ALTER TABLE users ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'PERSON';

UPDATE users SET kind = 'SYSTEM'
 WHERE email IN ('verification-member@brain.invalid', 'verification-owner@brain.invalid');

ALTER TABLE fleet_accounts ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'CAPACITY';

UPDATE fleet_accounts SET kind = 'VERIFICATION'
 WHERE name IN ('verify-hosted-account-a', 'verify-hosted-account-b');

CREATE TABLE IF NOT EXISTS capacity_connections (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connector_name      TEXT NOT NULL,
  routine_name        TEXT NOT NULL,
  secret_name         TEXT NOT NULL,
  trigger_ref         TEXT,
  account_id          TEXT,
  routine_id          TEXT,
  state               TEXT NOT NULL DEFAULT 'NOT_STARTED',
  failure_reason      TEXT,
  probe_bin_id        TEXT,
  probe_sent_at       TEXT,
  healthy_at          TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  seq                 BIGSERIAL,
  CHECK (state IN ('NOT_STARTED','CONNECTOR_AUTHORIZED','ROUTINE_DETAILS_NEEDED',
                   'WAITING_FOR_ADMIN','CONFIGURED','PROBE_SENT','ARRIVED','HEALTHY','FAILED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_capacity_connections_user
  ON capacity_connections(user_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_capacity_connections_trigger
  ON capacity_connections(trigger_ref) WHERE trigger_ref IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_capacity_connections_secret
  ON capacity_connections(secret_name);
