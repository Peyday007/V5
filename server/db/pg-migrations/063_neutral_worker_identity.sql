-- The Postgres half of SQLite migration 072. See that file for why a worker's
-- operational identity is a neutral server-assigned label and why the legacy
-- human name is kept but participates in nothing.

ALTER TABLE workers ADD COLUMN IF NOT EXISTS label TEXT;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS owner_user_id TEXT;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS owner_evidence TEXT;

UPDATE workers
   SET label = 'worker-' || lpad((
         SELECT COUNT(*)::text FROM workers AS earlier
          WHERE earlier.created_at < workers.created_at
             OR (earlier.created_at = workers.created_at AND earlier.id <= workers.id)
       ), 2, '0')
 WHERE label IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_workers_label ON workers (label);
