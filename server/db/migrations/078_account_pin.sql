-- A six-digit PIN, and the throttle that makes six digits survivable.
--
-- ---------------------------------------------------------------------------
-- Why this exists
-- ---------------------------------------------------------------------------
--
-- Migration 062 made a person a device, and the device was made mandatory
-- before anybody had proved one worked. The owner's browser answered the
-- WebAuthn request with *"the operation either timed out or was not allowed"*
-- and there was nothing else on the sign-in screen, so the one account that
-- can administer this Brain could not get into it. A credential nobody has
-- successfully presented is not a credential yet, and making it the only one
-- is how a sign-in screen becomes a locked door.
--
-- So a PIN. Additive, nullable, and beside the password rather than instead of
-- it: nothing here drops a column, rewrites a row or touches a passkey.
--
-- ---------------------------------------------------------------------------
-- Six digits is a million, and a million is not many
-- ---------------------------------------------------------------------------
--
-- That is the whole reason the last two columns exist. A password's strength
-- is in the secret; a PIN's strength is in the **throttle**, so the throttle
-- has to be as durable as the verifier it protects. An in-memory counter — the
-- shape `/api/auth/login` already uses — is emptied by every restart, and this
-- Brain restarts on every deploy: an attacker who could provoke one, or simply
-- wait for one, would get their budget back.
--
-- `pin_failed_count` and `pin_locked_until` are therefore rows. They are on
-- `users` rather than in a table of their own because the thing being
-- protected is one account's one credential, and a second table would be a
-- second place for that state to be read from — and eventually disagreed with.
--
-- `pin_algorithm` records what produced the verifier, exactly as
-- `password_algorithm` does, so a future change of hash can tell an old row
-- from a new one rather than guessing from its shape.

ALTER TABLE users ADD COLUMN pin_algorithm TEXT;
ALTER TABLE users ADD COLUMN pin_verifier TEXT;
ALTER TABLE users ADD COLUMN pin_updated_at TEXT;
ALTER TABLE users ADD COLUMN pin_failed_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN pin_locked_until TEXT;
