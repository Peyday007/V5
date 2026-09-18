-- brain:rebuild-without-foreign-keys
-- The whole life of a Claude connection, not only the happy half of it.
--
-- ---------------------------------------------------------------------------
-- What 066 left out
-- ---------------------------------------------------------------------------
--
-- 066 gave a member a resumable setup and stopped at the point where it worked.
-- Three things it has no row for turned out to be the three a person actually
-- needs once something goes wrong, and each of them was invisible rather than
-- refused:
--
--   * **Nobody can start on their own.** The one-time connector invitation is a
--     Brain administrator's to issue, correctly — it mints a worker identity and
--     grants it a project membership. But a member had no way to *ask* for one
--     and the steps never said one was needed, so an ordinary member read
--     "add a custom connector in Claude", did it, and was refused at a consent
--     screen that looks for an administrator first and an invitation second.
--     That is §24's own sentence at a new surface: a state that says "do this
--     now" which its reader cannot do is not waiting, it is stuck.
--
--   * **Nothing can be given back.** There was no revoke and no reconnect, so a
--     member who lost their Claude account, or wanted their capacity out of this
--     Brain, had to ask somebody with a terminal.
--
--   * **A surface wearing somebody else's identity had no name.** The refusal
--     existed at submission, and a connection whose Routine was *later*
--     repointed simply read CONFIGURED while Brain fired a surface its own
--     record no longer named. §27 records at length what that costs.
--
-- ---------------------------------------------------------------------------
-- Why this is a rebuild
-- ---------------------------------------------------------------------------
--
-- `state` carries a CHECK, deliberately — §32's rule that a status a caller
-- could write is a status a caller could claim — and SQLite cannot relax one in
-- place. So the table is rebuilt, and it carries the 067 marker for the reason
-- §32 records: `PRAGMA foreign_keys` is a documented no-op *inside* a
-- transaction, which is where every migration runs, so the standard recipe's
-- `OFF` does nothing and the drop cascades. Nothing references this table
-- today, which makes the cascade harmless here and makes the marker cheap
-- insurance rather than a load-bearing bet: the runner still ends with
-- `PRAGMA foreign_key_check` before the commit, so a rebuild that stranded a
-- reference is rolled back rather than recorded.
--
-- Every existing row is copied with its state, its trigger, its registration,
-- its probe and its timestamps. Nothing is reinterpreted: the three new states
-- are reachable only by a transition somebody makes from here on.

ALTER TABLE capacity_connections RENAME TO capacity_connections_066;

CREATE TABLE capacity_connections (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  connector_name      TEXT NOT NULL,
  routine_name        TEXT NOT NULL,
  secret_name         TEXT NOT NULL,

  trigger_ref         TEXT,

  account_id          TEXT,
  routine_id          TEXT,

  -- NOT_STARTED             nothing submitted yet
  -- INVITATION_REQUESTED    the member asked for their one-time connector link
  -- CONNECTOR_AUTHORIZED    a live token of theirs has reached Brain
  -- ROUTINE_DETAILS_NEEDED  connector proven, no trigger id yet
  -- WAITING_FOR_ADMIN       everything the member can do is done; the secret is not set
  -- CONFIGURED              registered and routable; no fire has been answered yet
  -- PROBE_SENT              a bounded self-test bin exists and is waiting
  -- ARRIVED                 a session Brain fired authenticated as the bound worker
  -- HEALTHY                 that session was handed the probe and finished it
  -- MISBOUND                the registered Routine is not the one this row names,
  --                         or is bound to another worker. Reported, never acted
  --                         on: repointing somebody else's surface is an
  --                         operator's decision and never a member's.
  -- REVOKED                 the member (or an administrator) took it back. The
  --                         tokens are gone and the surface is not fired.
  -- FAILED                  something needs a person; `failure_reason` says what
  state               TEXT NOT NULL DEFAULT 'NOT_STARTED',

  failure_reason      TEXT,

  probe_bin_id        TEXT,
  probe_sent_at       TEXT,

  healthy_at          TEXT,

  -- When the member asked for their connector link, and when an administrator
  -- answered. Two columns rather than one state, because the answer is what an
  -- administrator's list is sorted by and "asked an hour ago" and "asked in
  -- March" are the same state and different facts.
  invitation_requested_at TEXT,
  invitation_issued_at    TEXT,

  -- Why it was given back, and by whom. Never deleted: a connection that
  -- stopped for a reason nobody wrote down is one somebody reconnects by
  -- mistake, and a reconnect keeps this as history rather than clearing it.
  revoked_at          TEXT,
  revoked_reason      TEXT,
  revoked_by_user_id  TEXT,

  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,

  CHECK (state IN ('NOT_STARTED','INVITATION_REQUESTED','CONNECTOR_AUTHORIZED',
                   'ROUTINE_DETAILS_NEEDED','WAITING_FOR_ADMIN','CONFIGURED',
                   'PROBE_SENT','ARRIVED','HEALTHY','MISBOUND','REVOKED','FAILED'))
);

INSERT INTO capacity_connections
  (id, user_id, connector_name, routine_name, secret_name, trigger_ref,
   account_id, routine_id, state, failure_reason, probe_bin_id, probe_sent_at,
   healthy_at, created_at, updated_at)
SELECT
   id, user_id, connector_name, routine_name, secret_name, trigger_ref,
   account_id, routine_id, state, failure_reason, probe_bin_id, probe_sent_at,
   healthy_at, created_at, updated_at
  FROM capacity_connections_066;

DROP TABLE capacity_connections_066;

CREATE UNIQUE INDEX idx_capacity_connections_user ON capacity_connections(user_id);

CREATE UNIQUE INDEX idx_capacity_connections_trigger
  ON capacity_connections(trigger_ref) WHERE trigger_ref IS NOT NULL;

CREATE UNIQUE INDEX idx_capacity_connections_secret
  ON capacity_connections(secret_name);
