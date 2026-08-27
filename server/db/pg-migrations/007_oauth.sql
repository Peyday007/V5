-- ---------------------------------------------------------------------------
-- OAUTH 2.1 AUTHORIZATION, FOR THE REMOTE MCP GATEWAY
--
-- The Postgres counterpart of the local chain's 017_oauth.sql. The two describe
-- the same schema and differ only in the four ways the baseline documents:
-- `seq` stands in for rowid, serialized JSON stays text, timestamps stay text,
-- and case-insensitive comparison uses the `nocase` collation.
--
-- Uniqueness is an explicit `uq_`-prefixed index, per the convention
-- 003_identity.sql established.
--
-- The reasoning behind every column is in 017_oauth.sql and is not repeated
-- here. The one thing worth saying twice: `worker_id` on oauth_tokens is the
-- principal a token resolves to, and there is deliberately no user_id column
-- beside it that could become one by accident. The human who approved the
-- authorization is recorded on the code, not on the token.
-- ---------------------------------------------------------------------------

CREATE TABLE oauth_clients (
  id                text PRIMARY KEY,
  client_id         text NOT NULL,
  secret_digest     text,
  client_name       text NOT NULL,
  redirect_uris     text NOT NULL DEFAULT '[]',
  token_auth_method text NOT NULL DEFAULT 'none',
  created_at        text NOT NULL,
  disabled_at       text
);

CREATE UNIQUE INDEX uq_oauth_clients_client_id ON oauth_clients (client_id);

CREATE TABLE oauth_authorization_codes (
  id                    text PRIMARY KEY,
  code_digest           text NOT NULL,
  client_id             text NOT NULL,
  worker_id             text NOT NULL,
  approved_by_user_id   text NOT NULL,
  redirect_uri          text NOT NULL,
  code_challenge        text NOT NULL,
  code_challenge_method text NOT NULL DEFAULT 'S256',
  resource              text,
  scope                 text NOT NULL DEFAULT '',
  created_at            text NOT NULL,
  expires_at            text NOT NULL,
  redeemed_at           text
);

CREATE UNIQUE INDEX uq_oauth_codes_digest ON oauth_authorization_codes (code_digest);
CREATE INDEX idx_oauth_codes_expiry ON oauth_authorization_codes (expires_at);

CREATE TABLE oauth_tokens (
  id                text PRIMARY KEY,
  token_digest      text NOT NULL,
  token_prefix      text NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('ACCESS', 'REFRESH')),
  client_id         text NOT NULL,
  worker_id         text NOT NULL,
  scope             text NOT NULL DEFAULT '',
  resource          text,
  created_at        text NOT NULL,
  expires_at        text NOT NULL,
  last_used_at      text,
  revoked_at        text,
  parent_token_id   text
);

CREATE UNIQUE INDEX uq_oauth_tokens_digest ON oauth_tokens (token_digest);
CREATE INDEX idx_oauth_tokens_prefix ON oauth_tokens (token_prefix);
CREATE INDEX idx_oauth_tokens_worker ON oauth_tokens (worker_id, kind);
CREATE INDEX idx_oauth_tokens_expiry ON oauth_tokens (expires_at);
