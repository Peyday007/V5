-- The Postgres half of SQLite migration 073. See that file for why the column
-- is nullable, why null is an answer rather than a gap, and why it carries no
-- foreign key.

ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS passkey_id TEXT;

CREATE INDEX IF NOT EXISTS idx_user_sessions_passkey ON user_sessions (passkey_id);
