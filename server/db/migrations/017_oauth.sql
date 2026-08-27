-- ---------------------------------------------------------------------------
-- OAUTH 2.1 AUTHORIZATION, FOR THE REMOTE MCP GATEWAY
--
-- Step 7 authenticated MCP callers with the Step 4 worker credential as a
-- bearer token, and deliberately implemented no OAuth. The reasoning recorded
-- there was that OAuth's authorization-code flow exists to put a *person* in
-- front of a consent screen, and that there was no such person in a worker's
-- loop.
--
-- That was wrong, and Step 8 is where it showed. There is a person, and there
-- is a browser: the operator, at the moment a connector is registered. Only the
-- tool calls that come *afterwards* have no human present. OAuth is built for
-- exactly that shape — a human authorizes once, a machine acts many times — and
-- Step 7 reasoned about the second moment as though it were the first.
--
-- The practical consequence is that Claude's custom connector offers no way to
-- send a static Authorization header. Its only authentication affordance is
-- OAuth. So a Brain that cannot speak OAuth cannot be connected to Claude at
-- all, however correct its bearer design is.
--
-- ---------------------------------------------------------------------------
-- The invariant these three tables exist to hold
-- ---------------------------------------------------------------------------
--
--   A token issued by this flow resolves to the WORKER, never to the human who
--   approved it.
--
-- The operator is the resource owner. They authenticate to the Brain as
-- themselves, they choose which named worker is being connected, and they
-- approve. What comes back is a token whose principal is that worker. Every
-- authorization decision downstream — project membership, scopes, queue
-- fencing, audit attribution — is untouched, because it only ever sees a
-- Principal of type WORKER.
--
-- This is also what makes the operator's requirement true rather than
-- decorative: a worker "plugs in the same way you do", through a Brain sign-in,
-- instead of having a long-lived secret carried by hand into a configuration
-- box.
--
-- ---------------------------------------------------------------------------
-- What is deliberately not stored
-- ---------------------------------------------------------------------------
--
-- No plaintext secret of any kind. A client secret, an authorization code and
-- an access or refresh token are all kept as sha-256 digests, exactly as Step 4
-- keeps worker credentials. A stolen copy of this database yields nothing that
-- can be presented to the gateway.
--
-- Nothing about the Claude account. Not a password, not a cookie, not a
-- session, not an Anthropic token. Brain stores a token it minted itself,
-- against a worker it owns, on the authority of a human it authenticated. The
-- separation Step 7 recorded — a Brain worker identity is not a Claude account
-- — is unchanged by adding OAuth, and is the reason this table has no column
-- that could hold one.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Clients
-- ---------------------------------------------------------------------------
--
-- Registered dynamically (RFC 7591), because the connector's OAuth client id
-- and secret are optional in Claude's dialog: a client given neither must be
-- able to register itself or it can never connect.
--
-- Registration is deliberately NOT authenticated. That sounds alarming and is
-- not: a registered client can do nothing on its own. It cannot read, it cannot
-- call a tool, and it cannot obtain a token without a human completing the
-- authorize step in a browser while signed in to the Brain. Requiring
-- authentication here would break the one flow this exists to serve, and would
-- protect a row that confers no access.
CREATE TABLE oauth_clients (
  id                TEXT PRIMARY KEY,
  -- The public identifier the client sends. Random, not guessable, not secret.
  client_id         TEXT NOT NULL UNIQUE,
  -- sha-256 of the secret, or NULL for a public client using PKCE alone.
  secret_digest     TEXT,
  client_name       TEXT NOT NULL,
  -- JSON array. Every redirect must match one of these exactly at both the
  -- authorize and the token step; a prefix match is how open redirectors are
  -- built.
  redirect_uris     TEXT NOT NULL DEFAULT '[]',
  -- 'none' for a public client, 'client_secret_post'/'client_secret_basic'
  -- for a confidential one.
  token_auth_method TEXT NOT NULL DEFAULT 'none',
  created_at        TEXT NOT NULL,
  -- Set when an administrator withdraws a client. Kept rather than deleted, so
  -- the tokens that reference it still resolve for the audit.
  disabled_at       TEXT
);

CREATE INDEX idx_oauth_clients_client_id ON oauth_clients (client_id);

-- ---------------------------------------------------------------------------
-- Authorization codes
-- ---------------------------------------------------------------------------
--
-- Short-lived, single-use, PKCE-bound, and bound to the worker the operator
-- chose. The row carries the whole decision so that the token step can verify
-- it without trusting anything the client sends a second time.
CREATE TABLE oauth_authorization_codes (
  id                    TEXT PRIMARY KEY,
  -- sha-256 of the code. The code itself is in the redirect and nowhere else.
  code_digest           TEXT NOT NULL UNIQUE,
  client_id             TEXT NOT NULL,
  -- The identity the token will carry. Chosen by the human on the consent
  -- screen, never by the client.
  worker_id             TEXT NOT NULL,
  -- Who approved it. Recorded for the audit; never becomes the principal.
  approved_by_user_id   TEXT NOT NULL,
  redirect_uri          TEXT NOT NULL,
  -- PKCE. OAuth 2.1 requires it; S256 is the only method accepted.
  code_challenge        TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL DEFAULT 'S256',
  -- RFC 8707. Recorded so a token cannot be replayed at another resource.
  resource              TEXT,
  scope                 TEXT NOT NULL DEFAULT '',
  created_at            TEXT NOT NULL,
  expires_at            TEXT NOT NULL,
  -- Single use. Set on redemption; a second attempt matches a used row and is
  -- refused rather than silently issuing a second token.
  redeemed_at           TEXT
);

CREATE INDEX idx_oauth_codes_expiry ON oauth_authorization_codes (expires_at);

-- ---------------------------------------------------------------------------
-- Tokens
-- ---------------------------------------------------------------------------
--
-- One table for access and refresh tokens, distinguished by `kind`, because
-- they differ only in lifetime and in what they may be exchanged for. Both are
-- digests.
--
-- `worker_id` is the principal. There is no user_id column that could become
-- one by accident — `approved_by_user_id` is on the code, not here, and the
-- token carries no memory of the human beyond the audit trail.
CREATE TABLE oauth_tokens (
  id                TEXT PRIMARY KEY,
  -- sha-256 of the token. Presented tokens are looked up by prefix and then
  -- compared in constant time, exactly as Step 4 compares worker credentials.
  token_digest      TEXT NOT NULL UNIQUE,
  -- The non-secret half, for the lookup.
  token_prefix      TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('ACCESS', 'REFRESH')),
  client_id         TEXT NOT NULL,
  worker_id         TEXT NOT NULL,
  scope             TEXT NOT NULL DEFAULT '',
  resource          TEXT,
  created_at        TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  last_used_at      TEXT,
  -- Revoked rather than deleted, so a revoked token's audit rows still resolve.
  revoked_at        TEXT,
  -- The refresh token a rotated access token came from, so a whole chain can be
  -- revoked at once when one link is abused.
  parent_token_id   TEXT
);

CREATE INDEX idx_oauth_tokens_prefix ON oauth_tokens (token_prefix);
CREATE INDEX idx_oauth_tokens_worker ON oauth_tokens (worker_id, kind);
CREATE INDEX idx_oauth_tokens_expiry ON oauth_tokens (expires_at);
