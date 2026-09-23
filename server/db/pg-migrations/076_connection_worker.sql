-- The Postgres half of SQLite migration 085. See that file for why a name is
-- not a binding, and why a screen deriving one told the owner of this Brain
-- that their Claude account was not connected while it was firing 350 times.

ALTER TABLE capacity_connections ADD COLUMN IF NOT EXISTS worker_id TEXT;

UPDATE capacity_connections AS c
   SET worker_id = r.worker_id
  FROM fleet_routines r
 WHERE r.id = c.routine_id
   AND r.worker_id IS NOT NULL
   AND c.worker_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_capacity_connections_worker ON capacity_connections (worker_id);
