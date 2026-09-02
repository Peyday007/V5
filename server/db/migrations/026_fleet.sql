-- ---------------------------------------------------------------------------
-- Step 11 — the fleet: accounts, routines, capacity policy
-- ---------------------------------------------------------------------------
--
-- Step 10's whole fleet model was two environment variables. `fireConfig()`
-- read BRAIN_ROUTINE_ID and BRAIN_ROUTINE_TOKEN, and that was the fleet: one
-- Routine, named at deploy time, unchangeable without a deployment. It was the
-- right amount of machinery for proving a dispatcher works and the wrong amount
-- for running more than one account.
--
-- These tables replace that function with rows. Nothing about what a fire *is*
-- changes — same endpoint, same beta header, same empty body, same credential
-- in the same one header.

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------
--
-- A subscription. It has an allowance, and the allowance is the thing Step 10
-- could not measure: it measured a *fire* ceiling and correctly refused to
-- report that as the subscription limit.
--
-- `declared_plan_power` is what the operator says they bought — "20x". It is
-- deliberately a label and not a number the router does arithmetic on, because
-- multiplying labels is exactly how a fleet gets sized on a fiction. The router
-- uses targets and observed headroom; this column exists so a report can say
-- what was *declared* beside what was *measured* and let a reader see the gap.
CREATE TABLE fleet_accounts (
  id                   TEXT PRIMARY KEY,
  provider             TEXT NOT NULL DEFAULT 'claude',
  name                 TEXT NOT NULL,
  plan_label           TEXT,
  declared_plan_power  TEXT,

  -- ENABLED     eligible for routing
  -- DRAINING    finish what it holds, receive nothing new
  -- UNAVAILABLE the operator or a health signal says it cannot serve
  -- QUARANTINED repeated failures; recoverable only through a guarded action
  -- RETIRED     kept for its history, never routed to again
  state                TEXT NOT NULL DEFAULT 'ENABLED',
  state_reason         TEXT,

  -- What the provider last told us about this account's ceiling, and when it
  -- said we could try again. Written from refusals only — never inferred.
  retry_at             TEXT,
  last_refusal_at      TEXT,
  last_refusal_reason  TEXT,

  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,

  UNIQUE (provider, name),
  CHECK (state IN ('ENABLED','DRAINING','UNAVAILABLE','QUARANTINED','RETIRED'))
);

-- ---------------------------------------------------------------------------
-- Routines
-- ---------------------------------------------------------------------------
--
-- A fire surface. Many may belong to one account, and that is the distinction
-- the whole step turns on: adding a second Routine to an account doubles how
-- fast Brain can *start* sessions and does not change how much that account is
-- allowed to *do*. A fleet sized on Routine count alone would be sized on the
-- wrong resource.
--
-- `token_secret_name` is the NAME of the deployment secret holding the bearer,
-- never the bearer. `token_digest` is a sha-256 of the value taken once at
-- registration, so a diagnostic can say "the secret in the environment is the
-- one this row was registered with" without either of them being readable.
-- This is the same rule Step 4 applies to worker credentials and Step 8 to
-- OAuth tokens, applied to the one credential Step 10 kept in the environment.
CREATE TABLE fleet_routines (
  id                   TEXT PRIMARY KEY,
  account_id           TEXT NOT NULL REFERENCES fleet_accounts(id) ON DELETE CASCADE,

  -- The provider's trigger id, `trig_…`. Unique across the fleet: the same
  -- trigger registered twice would be two rows racing to fire one surface.
  routine_ref          TEXT NOT NULL,
  name                 TEXT NOT NULL,
  routine_version      TEXT,
  base_url             TEXT,

  token_secret_name    TEXT NOT NULL,
  token_digest         TEXT,

  -- The Brain worker identity this Routine's sessions authenticate as, once
  -- observed. Nullable because a Routine is registered before it has ever run.
  worker_id            TEXT,

  -- What this surface can reach, as a JSON array of tags a bin may require.
  -- Empty means "no special capability", which is what an ordinary Routine has.
  capabilities         TEXT NOT NULL DEFAULT '[]',

  state                TEXT NOT NULL DEFAULT 'ENABLED',
  state_reason         TEXT,

  -- The fire slot, and the whole of atomic Routine selection.
  --
  -- Two dispatchers — two ticks of one process, or two Brain instances — read
  -- this Routine's row in the same moment and both decide it has headroom for
  -- one more activation. Both then fire, and the account is over its target
  -- with nothing in the system aware of it.
  --
  -- So selection is a compare-and-swap on this number. Both racers name the
  -- generation they read in their `WHERE`, exactly one `UPDATE` matches, and
  -- the loser is refused. It is the same primitive as `work_items`'
  -- `lease_generation` and `bin_dispatch`'s `PENDING` -> `SENDING` swap, for
  -- the same reason: **a compare-and-swap has to be on a value the claimant
  -- does not supply.** A swap on `total_fires` would look equivalent and would
  -- not be, because two racers that read at different moments read different
  -- counts and each one's guard then matches its own read.
  --
  -- The loser is refused rather than retried, so the mechanism errs toward
  -- under-firing. That is the safe direction: a fire not made this tick is made
  -- ten seconds later, and a fire made twice is an activation nobody authorized.
  fire_generation      INTEGER NOT NULL DEFAULT 0,

  -- Health, as counters rather than a verdict. A verdict computed at write time
  -- cannot be re-derived when the rule changes; counters can. `total_fires`
  -- counts attempts committed to at the slot claim, so a refusal is one fire
  -- and one refusal rather than neither.
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  consecutive_no_shows INTEGER NOT NULL DEFAULT 0,
  total_fires          INTEGER NOT NULL DEFAULT 0,
  total_refusals       INTEGER NOT NULL DEFAULT 0,
  last_fired_at        TEXT,
  last_check_in_at     TEXT,
  retry_at             TEXT,

  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,

  UNIQUE (routine_ref),
  CHECK (state IN ('ENABLED','DRAINING','UNAVAILABLE','QUARANTINED','RETIRED'))
);

CREATE INDEX idx_fleet_routines_account ON fleet_routines (account_id, state);
CREATE INDEX idx_fleet_routines_eligible ON fleet_routines (state, retry_at);

-- ---------------------------------------------------------------------------
-- Capacity policy
-- ---------------------------------------------------------------------------
--
-- Append-only, versioned, and scoped. Raising a target is an INSERT, so it
-- needs no deployment, it carries who did it and why, and the previous value is
-- still there to revert to. The current policy for a scope is its highest
-- version — the same "latest row wins, history stays" shape `research_fragments`
-- uses for attempts.
--
-- `boost_until` is what makes a boost temporary rather than a target somebody
-- forgot to lower: the reader compares it to the clock, so an expired boost
-- stops applying without anything having to run.
CREATE TABLE fleet_policy (
  id                   TEXT PRIMARY KEY,

  -- FLEET has no scope_id. ACCOUNT and ROUTINE name one.
  scope                TEXT NOT NULL,
  scope_id             TEXT,
  version              INTEGER NOT NULL,

  -- How many concurrent activations this scope may have in flight.
  target               INTEGER NOT NULL,

  auto_scale           INTEGER NOT NULL DEFAULT 0,
  auto_scale_ceiling   INTEGER,
  min_reserve          INTEGER NOT NULL DEFAULT 0,

  -- A deliberate, expiring push above the target.
  boost_target         INTEGER,
  boost_until          TEXT,
  boost_reason         TEXT,

  -- A bounded run that raises rungs on purpose to find the wall.
  explore_ceiling      INTEGER,
  explore_until        TEXT,

  paused               INTEGER NOT NULL DEFAULT 0,

  actor                TEXT NOT NULL,
  reason               TEXT NOT NULL,
  created_at           TEXT NOT NULL,

  UNIQUE (scope, scope_id, version),
  CHECK (scope IN ('FLEET','ACCOUNT','ROUTINE')),
  CHECK (target >= 0),
  CHECK (min_reserve >= 0),
  CHECK (paused IN (0,1)),
  CHECK (auto_scale IN (0,1))
);

CREATE INDEX idx_fleet_policy_current ON fleet_policy (scope, scope_id, version DESC);

-- ---------------------------------------------------------------------------
-- Attribution on the existing ledger
-- ---------------------------------------------------------------------------
--
-- `bin_events` is already append-only, already carries session, routine, lease
-- and outcome, and is already written by every path that matters. Building a
-- second capacity ledger beside it would mean two tables that must agree about
-- the same fires, and the one that drifts is the one nobody reads.
--
-- So it gains three columns instead:
--
--   account_id / routine_id  which surface an event belongs to, so throughput
--                            can be asked per account rather than per bin;
--   evidence_class           what kind of fact this is, which is the honesty
--                            requirement of the whole step. A refusal the
--                            provider issued is PROVIDER_ENFORCED; a duration
--                            Brain timed is MEASURED; a ceiling nobody has
--                            observed is UNKNOWN and stays UNKNOWN.
ALTER TABLE bin_events ADD COLUMN account_id TEXT;
ALTER TABLE bin_events ADD COLUMN routine_id TEXT;
ALTER TABLE bin_events ADD COLUMN evidence_class TEXT;
ALTER TABLE bin_events ADD COLUMN workload_class TEXT;

CREATE INDEX idx_bin_events_account ON bin_events (account_id, at);
CREATE INDEX idx_bin_events_routine ON bin_events (routine_id, at);

-- Which registered Routine a dispatch actually went to. `routine_ref` already
-- held the provider's trigger id; this holds the row, so a report can join to
-- the account without parsing strings.
ALTER TABLE bin_dispatch ADD COLUMN routine_id TEXT;

-- What a bin needs from a surface, as a JSON array matched against
-- `fleet_routines.capabilities`. Null and empty both mean "any healthy
-- surface", which is what every Step 10 bin is.
ALTER TABLE bins ADD COLUMN required_capabilities TEXT;

-- Which workload class this bin belongs to, for per-class capacity questions
-- and for Step 12's profiles. Free text on purpose: the classes are a product
-- decision that will change, and an enum here would need a migration to add one.
ALTER TABLE bins ADD COLUMN workload_class TEXT;

-- ---------------------------------------------------------------------------
-- Audit execution lineage
-- ---------------------------------------------------------------------------
--
-- Step 10's three audit roles are three prompts. Nothing stopped one session
-- from performing all three, and nothing recorded that it had — so "independent
-- audit" was a naming convention rather than a fact about execution.
--
-- These columns make it a fact. A pass records which worker, Routine, account
-- and session produced it, and the independence policy is checked against those
-- rather than against the role name the submitter claimed.
ALTER TABLE research_passes ADD COLUMN executor_worker_id TEXT;
ALTER TABLE research_passes ADD COLUMN executor_routine_id TEXT;
ALTER TABLE research_passes ADD COLUMN executor_account_id TEXT;
ALTER TABLE research_passes ADD COLUMN executor_session_ref TEXT;
