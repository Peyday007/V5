-- The Postgres half of SQLite migration 078. See that file for why a PIN
-- exists at all, and why its throttle is rows rather than memory.

ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_algorithm TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_verifier TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_updated_at TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_failed_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_locked_until TEXT;
