-- The Postgres half of SQLite migration 067. See that file for why a member
-- must be able to ask for their own connector link, why a connection has to be
-- revocable and reconnectable, and why a surface bound to somebody else's
-- worker needs a name rather than a silent CONFIGURED.
--
-- There is no rebuild here. Postgres can drop and re-add a CHECK in place, so
-- the table keeps its identity, its `seq`, its indexes and every row — which is
-- the same reason §32's rebuild marker is deliberately SQLite-only.
ALTER TABLE capacity_connections
  ADD COLUMN IF NOT EXISTS invitation_requested_at TEXT,
  ADD COLUMN IF NOT EXISTS invitation_issued_at    TEXT,
  ADD COLUMN IF NOT EXISTS revoked_at              TEXT,
  ADD COLUMN IF NOT EXISTS revoked_reason          TEXT,
  ADD COLUMN IF NOT EXISTS revoked_by_user_id      TEXT;

-- 057 wrote the CHECK without a name, so Postgres generated one, and it is
-- `capacity_connections_state_check`: the naming rule is the *table plus the
-- column the constraint mentions*, even for a table-level constraint, and only
-- falls back to `<table>_check` when no single column can be named. 057 is the
-- only thing that ever created this table and it wrote exactly one CHECK on it,
-- so the name is determined rather than guessed.
--
-- The first version of this file guessed `capacity_connections_check` and was
-- wrong. It failed the migration, which failed the boot, with the constraint's
-- own name in the message — which is exactly why the next line is deliberately
-- **without** `IF EXISTS`. The tolerant form would have left the 057 constraint
-- standing beside the new one, and the first revoke in production would have
-- been refused by a constraint nobody was looking at. §18's rule about a
-- configuration that cannot be honoured: stop and say so, rather than come up
-- healthy and be wrong later.
ALTER TABLE capacity_connections DROP CONSTRAINT capacity_connections_state_check;

-- Re-added under the same name, in the same transaction, so a database that has
-- been through this migration is indistinguishable from one that has not except
-- in what the constraint permits.
ALTER TABLE capacity_connections
  ADD CONSTRAINT capacity_connections_state_check
  CHECK (state IN ('NOT_STARTED','INVITATION_REQUESTED','CONNECTOR_AUTHORIZED',
                   'ROUTINE_DETAILS_NEEDED','WAITING_FOR_ADMIN','CONFIGURED',
                   'PROBE_SENT','ARRIVED','HEALTHY','MISBOUND','REVOKED','FAILED'));
