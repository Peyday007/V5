-- The Postgres half of SQLite migration 062. See that file for why a passkey
-- account has no address and no verifier, and why a slot exists before the
-- person does.
--
-- Postgres can relax a NOT NULL in place, so `users` is altered rather than
-- rebuilt. The UNIQUE on `email` is untouched and already reads the same way in
-- both backends: several NULLs allowed, two identical addresses not.
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ALTER COLUMN password_algorithm DROP NOT NULL;
ALTER TABLE users ALTER COLUMN password_verifier DROP NOT NULL;
ALTER TABLE users ALTER COLUMN password_updated_at DROP NOT NULL;

CREATE TABLE IF NOT EXISTS user_passkeys (
  id                 TEXT PRIMARY KEY,
  seq                BIGSERIAL,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  credential_id      TEXT NOT NULL UNIQUE,
  public_key         TEXT NOT NULL,
  algorithm          INTEGER NOT NULL,
  sign_count         BIGINT NOT NULL DEFAULT 0,
  label              TEXT NOT NULL,
  origin_kind        TEXT NOT NULL CHECK (origin_kind IN ('ENROLLMENT', 'ADDED_DEVICE', 'RECOVERY')),

  created_at         TEXT NOT NULL,
  last_used_at       TEXT,
  revoked_at         TEXT,
  revoked_reason     TEXT,
  revoked_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_user_passkeys_user ON user_passkeys (user_id, revoked_at);

CREATE TABLE IF NOT EXISTS member_enrollments (
  id                 TEXT PRIMARY KEY,
  seq                BIGSERIAL,

  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_name       TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('ENROLLMENT', 'RECOVERY')),

  token_prefix       TEXT NOT NULL UNIQUE,
  token_digest       TEXT NOT NULL,
  issued_by_user_id  TEXT NOT NULL REFERENCES users(id),

  created_at         TEXT NOT NULL,
  expires_at         TEXT NOT NULL,
  used_at            TEXT,
  revoked_at         TEXT,
  revoked_reason     TEXT
);

CREATE INDEX IF NOT EXISTS idx_member_enrollments_user ON member_enrollments (user_id, used_at);

CREATE TABLE IF NOT EXISTS webauthn_challenges (
  challenge   TEXT PRIMARY KEY,
  purpose     TEXT NOT NULL CHECK (purpose IN ('REGISTER', 'AUTHENTICATE')),
  user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
