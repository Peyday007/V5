-- ---------------------------------------------------------------------------
-- IDENTITY, CREDENTIALS AND AUTHORIZATION
--
-- Until now the Brain has had exactly one caller: whoever holds the shared
-- deployment token. That was honest about what it was — a door, not a security
-- model — and it is what this migration replaces.
--
-- Two kinds of principal exist, and they are deliberately not the same kind of
-- row. A person signs in and gets a session. A worker is issued a credential by
-- the Brain and presents it on every request. Representing a worker as a user
-- with a password would mean a machine could sign in to the interface and a
-- person could be handed a bearer token, and both of those are mistakes that
-- only look harmless until somebody makes them.
--
-- Nothing here stores a secret. A password becomes a verifier; a credential
-- becomes a prefix that is safe to display and a verifier that is not the
-- credential. There is no column in this migration from which a working
-- credential can be reconstructed, and that is the property to preserve when
-- extending it.
--
-- What this migration does NOT contain, on purpose: no leases, no heartbeats,
-- no claim ownership, no capacity, no usage counters, no MCP registration.
-- Those are Steps 5, 7 and 11 (docs/ROADMAP.md). A placeholder table for work
-- a later step will design is worse than no table: it invites code to depend on
-- a shape nobody has thought about yet.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- People
--
-- `email` is the login handle and is stored already lowercased by the
-- repository rather than compared case-insensitively in SQL. That is not a
-- shortcut: a case-insensitive UNIQUE index behaves differently on the two
-- backends (SQLite's NOCASE is ASCII-only; Postgres needs a nondeterministic
-- ICU collation), and an account that exists on one and collides on the other
-- is exactly the class of difference this project refuses to carry.
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id                   TEXT PRIMARY KEY,
  email                TEXT NOT NULL UNIQUE,
  display_name         TEXT NOT NULL,
  -- The algorithm is recorded beside the verifier so a future change of
  -- parameters can be rolled out per user rather than invalidating everyone.
  password_algorithm   TEXT NOT NULL,
  -- Algorithm parameters, salt and derived key in one self-describing string.
  -- Never the password, and never anything reversible into it.
  password_verifier    TEXT NOT NULL,
  password_updated_at  TEXT NOT NULL,
  -- Set when an account is created by an administrator or bootstrapped: the
  -- first thing that person must do is choose their own password.
  must_change_password INTEGER NOT NULL DEFAULT 0,
  -- Brain-wide administration: managing users, workers and credentials.
  -- Project-level authority lives in project_memberships instead.
  is_brain_admin       INTEGER NOT NULL DEFAULT 0,
  -- Disabled rather than deleted. A deleted account takes its audit trail's
  -- meaning with it, and re-creating the same email later would silently
  -- inherit a stranger's history.
  disabled_at          TEXT,
  created_by_type      TEXT,
  created_by_id        TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Sessions
--
-- Server-side, so that revoking one is immediate and total. A self-contained
-- token that the server merely verifies would keep working after a person was
-- disabled, for as long as it had left to live — and "disabled, but still
-- reading everything until Tuesday" is not disabled.
--
-- The cookie carries a random secret; this table stores its sha-256. A read of
-- this table therefore yields nothing usable, which matters because a database
-- backup is a much easier thing to obtain than a live cookie.
-- ---------------------------------------------------------------------------
CREATE TABLE user_sessions (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_verifier  TEXT NOT NULL UNIQUE,
  issued_at       TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  revoked_at      TEXT,
  last_seen_at    TEXT,
  -- Kept for the operator's benefit when reading the audit, truncated by the
  -- repository. Not used for any authorization decision: a header the client
  -- controls must never be part of one.
  user_agent      TEXT,
  created_ip      TEXT
);

CREATE INDEX idx_user_sessions_user ON user_sessions (user_id);
CREATE INDEX idx_user_sessions_expiry ON user_sessions (expires_at);

-- ---------------------------------------------------------------------------
-- Workers
--
-- A worker is a Brain identity, and only a Brain identity. It is not a Claude
-- account, it does not hold a provider credential, and the Brain never learns
-- one: Claude authenticates to Anthropic on its own, and separately presents
-- the credential the Brain issued it. Conflating those would make the Brain a
-- store of somebody's subscription access, which is a liability it has no
-- reason to accept.
-- ---------------------------------------------------------------------------
CREATE TABLE workers (
  id              TEXT PRIMARY KEY,
  -- Canonical, lowercase, unique. The handle an operator types.
  name            TEXT NOT NULL UNIQUE,
  display_name    TEXT NOT NULL,
  -- What kind of thing this is, for the operator's own bookkeeping.
  worker_type     TEXT NOT NULL DEFAULT 'GENERIC',
  description     TEXT,
  -- ACTIVE or DISABLED. Checked on every authenticated request, so disabling a
  -- worker stops it mid-flight rather than at its next credential renewal.
  status          TEXT NOT NULL DEFAULT 'ACTIVE',
  disabled_at     TEXT,
  created_by_type TEXT NOT NULL,
  created_by_id   TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Worker credentials
--
-- Many per worker over its lifetime, because rotation without an overlap window
-- means an outage every time, and an outage every time means nobody rotates.
--
-- The credential a worker is given is `prefix.secret`. The prefix is public: it
-- is how this row is found, it is safe to print in a list, and it appears in
-- audit records so a reader can tell which credential acted without learning
-- it. The secret half is never stored — only `verifier`, and only ever
-- compared in constant time.
-- ---------------------------------------------------------------------------
CREATE TABLE worker_credentials (
  id              TEXT PRIMARY KEY,
  worker_id       TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  -- Unique so authentication is a single indexed lookup rather than a scan that
  -- verifies every credential in the table.
  prefix          TEXT NOT NULL UNIQUE,
  verifier        TEXT NOT NULL,
  issued_at       TEXT NOT NULL,
  -- Null means no expiry. An expiry is preferred and the administrative API
  -- defaults to one, but a credential that expires unexpectedly in the middle
  -- of a long job is its own kind of failure, so this is a decision rather than
  -- an imposition.
  expires_at      TEXT,
  revoked_at      TEXT,
  -- A category, never free text from a caller: it reaches the audit.
  revoked_reason  TEXT,
  -- Best-effort and deliberately not transactional with the request: recording
  -- it must never be able to fail an otherwise valid authentication.
  last_used_at    TEXT,
  issued_by_type  TEXT NOT NULL,
  issued_by_id    TEXT NOT NULL,
  -- The credential this one replaced, so a rotation is legible afterwards.
  rotated_from    TEXT REFERENCES worker_credentials(id) ON DELETE SET NULL
);

CREATE INDEX idx_worker_credentials_worker ON worker_credentials (worker_id);
CREATE INDEX idx_worker_credentials_live ON worker_credentials (revoked_at, expires_at);

-- ---------------------------------------------------------------------------
-- Project membership
--
-- The whole authorization model, in one table: which principal may touch which
-- project, and with what authority. A person gets a role; a worker gets scopes.
-- Both are recorded here because "who can see this project" is one question and
-- answering it from two tables invites the two answers to disagree.
--
-- One row per (project, principal), enforced by the database rather than by the
-- code that writes it. Two administrators granting the same person access at
-- the same moment is an ordinary event, and it must produce one membership, not
-- two rows that later disagree about the role. Revocation sets `revoked_at`
-- rather than deleting: the history of who could see what belongs in
-- identity_events, and the row itself stays as the thing that was revoked.
-- ---------------------------------------------------------------------------
CREATE TABLE project_memberships (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- HUMAN or WORKER.
  principal_type   TEXT NOT NULL,
  principal_id     TEXT NOT NULL,
  -- OWNER, ADMIN, MEMBER or VIEWER for a person; null for a worker.
  role             TEXT,
  -- JSON array of scope strings for a worker; '[]' for a person, whose
  -- authority comes from the role. Text rather than a JSON column for the same
  -- reason as every other serialized column here: one representation, both
  -- backends, no driver deciding to parse it on the way out.
  scopes           TEXT NOT NULL DEFAULT '[]',
  granted_by_type  TEXT NOT NULL,
  granted_by_id    TEXT NOT NULL,
  granted_at       TEXT NOT NULL,
  revoked_at       TEXT,
  updated_at       TEXT NOT NULL,
  UNIQUE (project_id, principal_type, principal_id)
);

CREATE INDEX idx_memberships_principal ON project_memberships (principal_type, principal_id);
CREATE INDEX idx_memberships_project ON project_memberships (project_id, revoked_at);

-- ---------------------------------------------------------------------------
-- The identity audit
--
-- Separate from project_events, which requires a project and cascades with one.
-- Half of what belongs here has no project at all — a sign-in, a worker being
-- created, a credential being rotated — and the other half must outlive the
-- project it mentions. A membership grant is written to both: this table is the
-- authoritative identity record, and project_events is where a project's own
-- history shows who was let into it.
--
-- Deliberately no foreign keys. An audit row that a cascade can delete is not
-- an audit row, and a foreign key here would mean the record of who was given
-- access to a project disappears with the project — precisely when somebody is
-- most likely to be asking.
--
-- This table must never become a secret store. It records credential *ids* and
-- prefixes, never credentials; denial *categories*, never the value that failed
-- to match.
-- ---------------------------------------------------------------------------
CREATE TABLE identity_events (
  id            TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL,
  -- HUMAN, WORKER, SYSTEM or ANONYMOUS. A failed sign-in has an actor whose
  -- identity is precisely what is in doubt, so it is recorded as ANONYMOUS with
  -- the attempted handle in metadata rather than as the user it claimed to be.
  actor_type    TEXT NOT NULL,
  actor_id      TEXT,
  -- The session id or worker-credential id that authenticated the actor. An
  -- identifier, never the secret.
  credential_id TEXT,
  action        TEXT NOT NULL,
  target_type   TEXT,
  target_id     TEXT,
  project_id    TEXT,
  -- SUCCESS, DENIED or FAILED.
  result        TEXT NOT NULL,
  -- A category from a fixed set, so that reading the audit never teaches an
  -- attacker which half of a guess was right.
  reason        TEXT,
  request_id    TEXT,
  metadata      TEXT NOT NULL DEFAULT '{}',
  user_agent    TEXT,
  remote_addr   TEXT
);

CREATE INDEX idx_identity_events_time ON identity_events (created_at DESC);
CREATE INDEX idx_identity_events_actor ON identity_events (actor_type, actor_id, created_at DESC);
CREATE INDEX idx_identity_events_project ON identity_events (project_id, created_at DESC);
CREATE INDEX idx_identity_events_action ON identity_events (action, created_at DESC);
