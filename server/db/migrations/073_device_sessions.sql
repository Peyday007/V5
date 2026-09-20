-- Which device a session came from, so revoking that device can end it.
--
-- A session has always been a row the server can revoke, and revocation has
-- always been all-or-nothing per person: `revokeSessionsForUser` ends every
-- session somebody holds. That is the right answer for a password change and
-- the wrong one for "this phone is lost" — the sessions the *other* devices
-- opened are not the ones in the wrong hands, and ending them makes losing a
-- phone a reason to sign in again everywhere.
--
-- With the session persistence that arrives beside this migration the
-- distinction stops being cosmetic: a device session now outlives a working
-- day by design, so a revocation that cannot find the session a retired
-- credential opened would leave it live for weeks.
--
-- Nullable, and null is not a gap: a session opened by the break-glass password
-- door came from no device, and every session written before this column
-- existed came from a device nobody recorded. Both are correctly excluded from
-- a per-device revocation, and both are still reached by the per-person one.
--
-- No foreign key, deliberately. `user_passkeys` rows are never deleted — a
-- revoked credential keeps its row and its reason (§5) — so a constraint here
-- would protect against nothing, and adding one to `user_sessions` is exactly
-- the kind of change migration 062 records the cost of getting wrong.

ALTER TABLE user_sessions ADD COLUMN passkey_id TEXT;

CREATE INDEX idx_user_sessions_passkey ON user_sessions (passkey_id);
