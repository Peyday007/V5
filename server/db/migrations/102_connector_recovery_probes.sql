-- A recovery probe: the one controlled activation that can establish which
-- connector a quarantined, unattributed Routine uses (CLAUDE.md §51,
-- services/fleet/recoveryProbe.ts). Postgres chain: 093_connector_recovery_probes.sql.
--
-- Attribution needs a proven arrival, an arrival needs a fire, and Brain does
-- not fire a quarantined surface — so without this a Routine that is both
-- quarantined and unattributed could leave that state only by an operator
-- guessing an OAuth client or re-enabling the surface blind. A probe is fired
-- once, at exactly one Routine, outside routing; the session it starts is
-- recognised by the provider session the fire returned, which nothing but
-- Brain, the provider and that session has ever seen.
--
-- State is what the probe established, never a verdict about the surface:
--   FIRING            reserved, the fire is in flight
--   FIRED             the provider started a session; waiting for it to arrive
--   HEALTHY           it arrived, authenticated, and its connector is healthy
--   REAUTH_REQUIRED   its connector is proven to need a new consent
--   NO_MCP            the session started and never reached Brain in the window
--   PROVIDER_REFUSED  the provider would not start a session
--   AMBIGUOUS         it arrived, but the arrival proves no single connector
--
-- `live` is 1 while a probe is FIRING or FIRED and NULL afterwards. The UNIQUE
-- constraint on it is the whole serialization rule: one recovery probe in the
-- Brain at a time, decided by the database rather than by a check somebody
-- could race. NULLs do not collide in either dialect.
--
-- `session_key` is the provider session normalized (`domain/sessionRef.ts`),
-- unique so one session can never be the proof for two probes.
--
-- Nothing here holds a credential. `credential_id` is the id of the access
-- token the arrival authenticated with, the same identifier `worker_sessions`
-- already records; `client_id` is the OAuth client's public id.
CREATE TABLE connector_recovery_probes (
  id                 TEXT PRIMARY KEY,
  routine_id         TEXT NOT NULL,
  account_id         TEXT NOT NULL,
  worker_id          TEXT,
  bin_id             TEXT,
  state              TEXT NOT NULL
    CHECK (state IN ('FIRING', 'FIRED', 'HEALTHY', 'REAUTH_REQUIRED', 'NO_MCP', 'PROVIDER_REFUSED', 'AMBIGUOUS')),
  live               INTEGER UNIQUE,
  provider_session   TEXT,
  session_key        TEXT UNIQUE,
  credential_id      TEXT,
  client_id          TEXT,
  connector_id       TEXT,
  health             TEXT,
  outcome            TEXT,
  next_action        TEXT,
  requested_by_id    TEXT NOT NULL,
  authority_channel  TEXT NOT NULL DEFAULT 'SHELL',
  created_at         TEXT NOT NULL,
  fired_at           TEXT,
  arrived_at         TEXT,
  settled_at         TEXT,
  expires_at         TEXT NOT NULL
);

CREATE INDEX idx_recovery_probes_routine ON connector_recovery_probes (routine_id, created_at);
CREATE INDEX idx_recovery_probes_bin ON connector_recovery_probes (bin_id);
