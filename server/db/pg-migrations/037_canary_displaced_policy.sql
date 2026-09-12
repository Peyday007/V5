-- The Postgres half of migration 046. See it for why the displaced policy is
-- recorded at apply time rather than searched for at rollback time.
ALTER TABLE capability_experiments ADD COLUMN IF NOT EXISTS displaced_policy_id TEXT;
ALTER TABLE capability_experiments ADD COLUMN IF NOT EXISTS displaced_target INTEGER;
