-- brain:rebuild-without-foreign-keys
-- Passkey-only people, and the enrollment that brings one in.
--
-- The four members sign in with a device, not with an address and a secret.
-- That means `users` can no longer insist on either: a passkey account has no
-- email to be unique on and no verifier to compare. SQLite cannot relax a
-- NOT NULL in place, so the table is rebuilt — every column, constraint and row
-- carried across, nothing dropped and nothing defaulted.
--
-- `email` stays UNIQUE and becomes nullable, which SQLite and Postgres both
-- read the same way: several NULLs are allowed and two identical addresses are
-- not. So the existing password accounts keep the uniqueness they have always
-- had, and passkey accounts simply have no address to collide on.
--
-- **The first line is load-bearing, and two attempts at this were destructive.**
--
-- The obvious recipe — create, copy, `DROP TABLE users`, rename — succeeds and
-- deletes the Brain's history. A migration runs inside a transaction, and
-- `PRAGMA foreign_keys` is a documented no-op inside one, so an `OFF` written
-- here does nothing: foreign keys stay on, `DROP TABLE` performs an implicit
-- DELETE of every row, and every `ON DELETE CASCADE` aimed at `users` fires —
-- sessions, conversations, messages, collections, preferences, milestones.
-- Nothing fails. Driving it against a seeded database is what found that;
-- reading it did not, twice.
--
-- Renaming instead of dropping does not save it: with foreign keys on, a rename
-- rewrites the other tables' `REFERENCES` clauses to follow the table to its new
-- name, and `legacy_alter_table` does not stop that — measured, not assumed.
--
-- So the file carries `-- brain:rebuild-without-foreign-keys`, which makes the
-- runner do what SQLite's own twelve-step procedure says: the pragma outside the
-- transaction, the rebuild inside it, `PRAGMA foreign_key_check` before the
-- commit, and the pragma back on afterwards whatever happened.
-- Foreign keys are off for this file, so the drop below fires no action and the
-- rename rewrites nothing. `foreign_key_check` runs before the commit.
CREATE TABLE users_new (
  id                   TEXT PRIMARY KEY,
  -- Nullable now. A passkey account has no address, and inventing one would be
  -- a fake unique key that somebody later mistakes for a way to reach a person.
  email                TEXT UNIQUE,
  display_name         TEXT NOT NULL,
  -- All three nullable together: a password is one credential shape among
  -- several rather than a property every account has. A row with no verifier
  -- cannot be signed in to with a password, which is the point.
  password_algorithm   TEXT,
  password_verifier    TEXT,
  password_updated_at  TEXT,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  is_brain_admin       INTEGER NOT NULL DEFAULT 0,
  disabled_at          TEXT,
  created_by_type      TEXT,
  created_by_id        TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

INSERT INTO users_new (id, email, display_name, password_algorithm, password_verifier,
  password_updated_at, must_change_password, is_brain_admin, disabled_at,
  created_by_type, created_by_id, created_at, updated_at)
SELECT id, email, display_name, password_algorithm, password_verifier,
  password_updated_at, must_change_password, is_brain_admin, disabled_at,
  created_by_type, created_by_id, created_at, updated_at
FROM users;

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

-- One row per registered device. Several per person on purpose: a passkey is
-- bound to the device that made it, so "add another device" is the ordinary
-- case rather than an edge one, and a person with only one device has one
-- thing between them and being locked out.
CREATE TABLE user_passkeys (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- The authenticator's own id for this credential, base64url as the browser
  -- reports it. Unique Brain-wide: one physical credential is one row.
  credential_id      TEXT NOT NULL UNIQUE,
  -- The COSE public key, base64url. A public key, so it is stored as it is —
  -- there is nothing here to recover a secret from.
  public_key         TEXT NOT NULL,
  -- COSE algorithm identifier (-7 ES256, -257 RS256). Recorded rather than
  -- assumed, so a credential is verified with the algorithm it was made with.
  algorithm          INTEGER NOT NULL,

  -- The authenticator's signature counter, if it keeps one. A counter that goes
  -- backwards is the documented signal of a cloned credential; zero means the
  -- authenticator does not count, which most platform passkeys do not.
  sign_count         INTEGER NOT NULL DEFAULT 0,

  -- What a person sees when deciding which device to revoke. Their own words,
  -- or a default; never anything identifying about the device itself.
  label              TEXT NOT NULL,

  -- How this credential came to exist, so an audit can tell a first enrollment
  -- from a device added later from a recovery after a loss.
  origin_kind        TEXT NOT NULL CHECK (origin_kind IN ('ENROLLMENT', 'ADDED_DEVICE', 'RECOVERY')),

  created_at         TEXT NOT NULL,
  last_used_at       TEXT,

  -- Retired rather than deleted, for the reason every other credential in this
  -- Brain is: a row that vanishes takes the meaning of its audit trail with it.
  revoked_at         TEXT,
  revoked_reason     TEXT,
  revoked_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_user_passkeys_user ON user_passkeys (user_id, revoked_at);

-- A member slot, and the one-time link that fills it.
--
-- The slot exists before the person does: an administrator decides who is being
-- invited and what they will be called, and the link is bound to that decision.
-- So the person opening it chooses neither their identity nor their authority —
-- the same property `project_invitations` has, and for the same reason.
CREATE TABLE member_enrollments (
  id                 TEXT PRIMARY KEY,

  -- The slot. Created with the enrollment and filled by it, so a link always
  -- has an intended account rather than making one up on acceptance.
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- What the person will see before they commit their device.
  display_name       TEXT NOT NULL,

  -- ENROLLMENT: a new member joining.
  -- RECOVERY: an existing member who lost their device. Issuing one retires the
  -- lost credential, so a recovery is never a second way in beside it.
  kind               TEXT NOT NULL CHECK (kind IN ('ENROLLMENT', 'RECOVERY')),

  -- The credential: a prefix to find it by and a digest of the secret. The link
  -- itself is shown once and is not recoverable from this row.
  token_prefix       TEXT NOT NULL UNIQUE,
  token_digest       TEXT NOT NULL,

  -- Whose decision this carries, re-read at use rather than trusted.
  issued_by_user_id  TEXT NOT NULL REFERENCES users(id),

  created_at         TEXT NOT NULL,
  expires_at         TEXT NOT NULL,

  -- Single use. Set in the same statement that checks it is unset, so two
  -- requests holding one intercepted link cannot both come away with a device
  -- registered.
  used_at            TEXT,

  revoked_at         TEXT,
  revoked_reason     TEXT
);

CREATE INDEX idx_member_enrollments_user ON member_enrollments (user_id, used_at);

-- A registration or sign-in challenge, held for the seconds between issuing it
-- and the browser answering.
--
-- Server-side because the whole point of the challenge is that the server chose
-- it: one held in a cookie or echoed back by the client is a number the caller
-- supplies, which is the property every compare-and-swap in this codebase
-- exists to avoid.
CREATE TABLE webauthn_challenges (
  challenge   TEXT PRIMARY KEY,
  purpose     TEXT NOT NULL CHECK (purpose IN ('REGISTER', 'AUTHENTICATE')),
  -- Null for a sign-in, where the credential says who it is afterwards.
  user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
