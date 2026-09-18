-- Who is a person, what is a capacity surface, and how somebody connects one.
--
-- ---------------------------------------------------------------------------
-- 1. A person is declared, never recognised by their name
-- ---------------------------------------------------------------------------
--
-- `cashReadiness` counted every `users` row that was not disabled, so the two
-- accounts `scripts/verify-hosted.ts` creates to prove authorization works —
-- "Hosted verification" and "Hosted verification owner" — were rendered on a
-- product screen as two of the four people the sprint was waiting for. The
-- fleet half of the same reading already had the problem and had already
-- reached for the fragile answer: `name.startsWith('verify-hosted')`, which is
-- a string comparison standing in for a fact, and which silently stops working
-- the day somebody registers an account called `verify-hosted-but-real`.
--
-- `projects.purpose` settled the identical question in migration 028 and its
-- comment says why: *declared, not inferred. Everything this run creates is the
-- machinery proving itself, and it must never be counted as somebody's work on
-- a screen a person reads.* This is that column, for identities and for
-- capacity accounts.
--
-- The backfill names the two verification addresses and nothing else. They are
-- `@brain.invalid` — a reserved TLD that can never be a real person's address —
-- and they are the only `users` rows this repository has ever created from a
-- script. Everything else stays `PERSON`, because a migration that guessed
-- which existing accounts were real would be making exactly the judgement this
-- column exists to stop being guessed.
--
-- Nothing is deleted. A verification identity keeps its row, its memberships,
-- its history and its audit trail; what changes is that a screen which asks for
-- *people* no longer gets it.
ALTER TABLE users ADD COLUMN kind TEXT NOT NULL DEFAULT 'PERSON';

UPDATE users SET kind = 'SYSTEM'
 WHERE email IN ('verification-member@brain.invalid', 'verification-owner@brain.invalid');

-- ---------------------------------------------------------------------------
-- 2. A capacity account is declared too
-- ---------------------------------------------------------------------------
--
-- `verify-hosted-account-a` and `-b` exist to be *refused*: their secret name is
-- the sentinel `VERIFY_HOSTED_NEVER_SET`, which is never deployed, so the
-- dispatcher's own snapshot leaves them out and reports them under
-- `missingSecrets`. Counting them as capacity made the fleet look two accounts
-- larger than it is, which the prefix filter was patching over one screen at a
-- time.
--
-- `VERIFICATION` says what they are. It changes no routing decision — the
-- absent secret already did that, and still does — it changes what a reading
-- of *usable research capacity* is allowed to include.
ALTER TABLE fleet_accounts ADD COLUMN kind TEXT NOT NULL DEFAULT 'CAPACITY';

UPDATE fleet_accounts SET kind = 'VERIFICATION'
 WHERE name IN ('verify-hosted-account-a', 'verify-hosted-account-b');

-- ---------------------------------------------------------------------------
-- 3. Connecting a Claude account, as a durable row rather than a conversation
-- ---------------------------------------------------------------------------
--
-- A member contributing a Routine has to do six things in Claude and Brain has
-- to do three, and one of the three — putting the trigger's bearer into the
-- deployment's environment — is a privileged operation Brain structurally
-- cannot perform: `resolveToken` reads `process.env[secret_name]`, and nothing
-- in this repository can write that. §22's split again, at a new surface:
-- **Brain owns dispatch; the surface owns whether a worker may act**, and here
-- the operator owns the secret.
--
-- So the journey is rows. Refreshing does not lose it, a tick that dies does
-- not lose it, the administrator's one remaining action advances *this* request
-- rather than starting a new one, and every step is idempotent by something
-- that cannot change under it.
--
-- Two things are deliberately absent from this table. **There is no token
-- column, of any shape.** The trigger's bearer never reaches Brain's database
-- at all — it goes into the deployment environment, and `fleet_routines` keeps
-- only the *name* of that variable and a digest taken at registration. And
-- there is no free-text status: `state` is a closed vocabulary with a CHECK on
-- it, because a status a caller could write is a status a caller could claim.
CREATE TABLE capacity_connections (
  id                  TEXT PRIMARY KEY,

  -- Whose connection this is. One live request per person: a second would make
  -- "which Routine is mine" ambiguous, and the answer to wanting another one is
  -- a second person or a second Routine on the same account, both of which have
  -- their own rows.
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- The three names Brain assigns, so nobody has to invent one and two people
  -- cannot choose the same. Assigned at creation and never rewritten: the
  -- secret name in particular is what an administrator is told to set, and one
  -- that moved after they were told would send them to set the wrong variable.
  connector_name      TEXT NOT NULL,
  routine_name        TEXT NOT NULL,
  secret_name         TEXT NOT NULL,

  -- What the member submits. `trigger_ref` is the trig_… id Claude shows once
  -- the Routine exists; it is theirs to read and Brain's to fire.
  trigger_ref         TEXT,

  -- What Brain wrote once registration succeeded. Null until then.
  account_id          TEXT,
  routine_id          TEXT,

  -- NOT_STARTED             nothing submitted yet
  -- CONNECTOR_AUTHORIZED    a token of theirs has reached Brain at least once
  -- ROUTINE_DETAILS_NEEDED  connector proven, no trigger id yet
  -- WAITING_FOR_ADMIN       everything the member can do is done; the secret is not set
  -- CONFIGURED              registered and routable; no fire has been answered yet
  -- PROBE_SENT              a bounded self-test bin exists and is waiting
  -- ARRIVED                 a session Brain fired authenticated as the bound worker
  -- HEALTHY                 that session was handed the probe and finished it
  -- FAILED                  something needs a person; `failure_reason` says what
  state               TEXT NOT NULL DEFAULT 'NOT_STARTED',

  -- Always set when the state needs a person, and always with a remedy in it.
  -- §24's rule: an escalation with no answering transition is stuck rather than
  -- waiting, so a state that stops must name what unsticks it.
  failure_reason      TEXT,

  -- The bounded `DETERMINISTIC_CHECK` bin that proves the chain. Reused across
  -- retries while it can still deliver, so retrying a probe creates no second
  -- account and no second Routine.
  probe_bin_id        TEXT,
  probe_sent_at       TEXT,

  -- When Brain last read the four-row surface chain and found it complete.
  healthy_at          TEXT,

  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,

  CHECK (state IN ('NOT_STARTED','CONNECTOR_AUTHORIZED','ROUTINE_DETAILS_NEEDED',
                   'WAITING_FOR_ADMIN','CONFIGURED','PROBE_SENT','ARRIVED','HEALTHY','FAILED'))
);

CREATE UNIQUE INDEX idx_capacity_connections_user ON capacity_connections(user_id);

-- One trigger belongs to one connection. Re-submitting the same trigger id on
-- the same connection is the idempotent case and is handled by reading this row
-- back; submitting somebody else's is refused by the index rather than by a
-- check somebody has to remember to write.
CREATE UNIQUE INDEX idx_capacity_connections_trigger
  ON capacity_connections(trigger_ref) WHERE trigger_ref IS NOT NULL;

CREATE UNIQUE INDEX idx_capacity_connections_secret
  ON capacity_connections(secret_name);
