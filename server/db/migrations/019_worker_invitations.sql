-- Connecting an account you are not sitting in front of.
--
-- The connection flow starts in the operator's browser and finishes there:
-- Claude sends the browser to /oauth/authorize and expects a redirect back to
-- its own callback in the same session. The consent screen demanded a
-- signed-in Brain administrator, so connecting somebody else's Claude account
-- meant one of three things — standing at their keyboard, giving them
-- administrator rights, or nothing.
--
-- All three are wrong. The people lending an account are not participants in
-- this Brain; they hold no research and need no login. They are lending
-- compute, and asking them to become administrators to do it hands over the
-- ability to create workers, grant any project and issue credentials.
--
-- So the approval moves earlier instead of moving machines. An administrator
-- pre-authorizes one named worker, once, and the invitation carries that
-- decision to whichever browser needs it. The person who receives it can
-- connect exactly that worker, once, before it expires, and can do nothing
-- else with it.
--
-- It is a credential, so it is stored the way every other credential here is:
-- a prefix to look it up by and a sha-256 of the secret. The plaintext exists
-- in the link and nowhere else, and cannot be recovered afterwards.
CREATE TABLE worker_invitations (
  id                   TEXT PRIMARY KEY,
  -- The worker this invitation may connect. Exactly one, chosen when it is
  -- created — the recipient never picks.
  worker_id            TEXT NOT NULL,
  token_prefix         TEXT NOT NULL UNIQUE,
  token_digest         TEXT NOT NULL,
  -- The administrator whose approval this carries. Every authorization code
  -- redeemed through this invitation records them, so the audit names the human
  -- who actually decided rather than whoever happened to click.
  created_by_user_id   TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  expires_at           TEXT NOT NULL,
  -- Single use, set when a connection is actually authorized. Opening the link
  -- deliberately does not consume it: a person who loses the tab, or whose
  -- first attempt fails, should not need a new invitation.
  redeemed_at          TEXT,
  -- Set when an administrator withdraws it before use.
  revoked_at           TEXT,
  note                 TEXT
);

CREATE INDEX idx_worker_invitations_worker ON worker_invitations (worker_id);
