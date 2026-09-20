-- What Brain has established about its own execution capacity, and the bounded
-- experiments it ran to establish it.
--
-- ---------------------------------------------------------------------------
-- Why two tables and not five
-- ---------------------------------------------------------------------------
--
-- Almost everything a capacity kernel needs is already written down. `bin_events`
-- is the capacity ledger §23 built, append-only, carrying the account, the
-- Routine, the workload class and an `evidence_class` that separates a refusal
-- the provider issued from a duration Brain timed. `bin_dispatch` records every
-- fire Brain made and when the provider accepted it. `worker_sessions` records
-- which fire produced which authenticated arrival, from Brain's own dispatch row
-- rather than from anything a worker said. `fleet_policy` is append-only policy
-- with an actor and a reason on every version, so the previous target is always
-- still there to revert to. `work_items` and `bins` hold the attempts, the leases
-- and the generations.
--
-- So the raw observations are not the gap. Two things genuinely cannot be
-- reconstructed from those rows, and they are the two tables here:
--
--   1. **A conclusion, with the date it was first observed and the date it was
--      last still true.** `bin_events` can tell you that six sessions once
--      overlapped. It cannot tell you that Brain *concluded* active concurrency
--      is at least six, on the 14th, and re-checked it on the 19th — and without
--      that, every reader re-derives from the whole history and nothing can ever
--      go stale, which means nothing can ever be revalidated when the provider,
--      the plan or the fleet changes. §31's `shared_findings` is the same shape
--      for the same reason: a promotion record that stores no knowledge, points
--      at the evidence, and holds only the facts the evidence rows cannot carry.
--
--   2. **An experiment in flight, with the rollback point it was authorized
--      against.** `fleet_policy` holds the version to revert *to*; nothing holds
--      the fact that version 12 is the thing version 13 is a temporary
--      departure from, nor that a canary is running, nor which bins it created.
--      A flag in memory can be set by a tick that then dies. Rows cannot, which
--      is why §27's stages are rows rather than a cursor.
--
-- There is no second scheduler, queue, Routine registry, account registry,
-- evidence store or telemetry authority here. The kernel reads the ledger, writes
-- its conclusions here, and changes what Brain does by writing one
-- `fleet_policy` row through `setPolicy` — the instrument `explore_ceiling` was
-- added for in 026 and which, until now, nothing wrote.

-- ---------------------------------------------------------------------------
-- Claims
-- ---------------------------------------------------------------------------
--
-- One row per (dimension, scope, workload class). The dimension vocabulary is
-- `CAPACITY_DIMENSIONS` in `server/domain/capacity.ts`; it is deliberately not a
-- CHECK constraint, because a dimension added later must not need a migration to
-- be recordable and an unknown one is refused by the repository before it can
-- reach here.
--
-- `bound` is the honesty requirement of the whole kernel. A fifth Routine being
-- created proves definition capacity is **AT_LEAST** five; it proves nothing
-- about a maximum. A refusal at six establishes an **AT_MOST**. Collapsing the
-- two into one integer is how "we created a fifth" becomes "the limit is five",
-- and it is the single error this table exists to make unsayable.
CREATE TABLE capacity_claims (
  id                    TEXT PRIMARY KEY,

  -- What is being claimed, and about what.
  dimension             TEXT NOT NULL,
  -- 'FLEET' with a null id, or 'ACCOUNT'/'ROUTINE' with one. The same scope
  -- vocabulary `fleet_policy` already uses, so a claim and the policy it is
  -- about are addressed the same way.
  scope                 TEXT NOT NULL,
  scope_id              TEXT,
  -- Normalized per §29: a batch of shorter work must not read as a capacity
  -- improvement, so a claim that did not hold the workload constant says which
  -- class it held, and 'ANY' says it did not hold one.
  workload_class        TEXT NOT NULL DEFAULT 'ANY',

  -- The claim itself. Null value with evidence 'UNKNOWN' is a real row: it
  -- records that Brain looked and could not tell, which is a different fact
  -- from no row at all and from a value of zero.
  value                 REAL,
  bound                 TEXT NOT NULL,
  evidence_class        TEXT NOT NULL,
  -- One sentence a person reads. Never an enum, never a template.
  explanation           TEXT NOT NULL,

  -- How well grounded it is, in the terms the mandate requires.
  sample_count          INTEGER NOT NULL DEFAULT 0,
  confidence            TEXT NOT NULL,
  -- `bin_events.id` values, as a JSON array. Pointers, never copies: the
  -- evidence lives in the ledger and a duplicate here is the second master
  -- §30 refuses for money and §31 refuses for findings.
  evidence_ids          TEXT NOT NULL DEFAULT '[]',
  -- Evidence that argues against this claim, kept rather than dropped. A claim
  -- whose contradictions are invisible is one nobody can re-open.
  contradictions        TEXT NOT NULL DEFAULT '[]',
  -- The conditions under which this stops being about this system, as a JSON
  -- array of sentences. Read by `isStale`, never by a timer.
  staleness             TEXT NOT NULL DEFAULT '[]',

  -- The configuration this was measured against. A claim measured on another
  -- code version, another policy or another fleet composition is a claim about
  -- another system, which is what makes revalidation derivable rather than
  -- scheduled.
  code_version          TEXT,
  config_hash           TEXT,

  first_observed_at     TEXT NOT NULL,
  last_verified_at      TEXT NOT NULL,
  -- Set when something has since made this claim not about this system. The row
  -- stays: §5, at a conclusion rather than a run.
  superseded_at         TEXT,
  superseded_by_id      TEXT,
  superseded_reason     TEXT,

  CHECK (bound IN ('AT_LEAST', 'AT_MOST', 'EXACT')),
  CHECK (evidence_class IN ('MEASURED', 'INFERRED', 'UNKNOWN', 'PROVIDER_ENFORCED')),
  CHECK (confidence IN ('LOW', 'MEDIUM', 'HIGH')),
  CHECK (sample_count >= 0),
  -- An UNKNOWN carries no value and a value is never UNKNOWN. This is the
  -- "UNKNOWN and null must remain distinct from zero" requirement, enforced by
  -- the database rather than by a convention somebody remembers.
  CHECK ((evidence_class = 'UNKNOWN') = (value IS NULL))
);

-- At most one live claim per (dimension, scope, workload class). A superseded
-- one keeps its row and drops out of the index, which is what lets history
-- accumulate without two current answers to one question ever existing.
CREATE UNIQUE INDEX idx_capacity_claims_live
  ON capacity_claims (dimension, scope, COALESCE(scope_id, ''), workload_class)
  WHERE superseded_at IS NULL;

CREATE INDEX idx_capacity_claims_scope ON capacity_claims (scope, scope_id, last_verified_at);

-- ---------------------------------------------------------------------------
-- Experiments
-- ---------------------------------------------------------------------------
--
-- The state machine is
--
--   PROPOSED → AUTHORIZED → CANARY_RUNNING → EVALUATING
--                                              → ADOPTED
--                                              → ROLLED_BACK
--            → NEEDS_USER
--            → ABANDONED
--
-- and every transition is a guarded UPDATE naming the state it moves from, so
-- two ticks reading one row produce one transition and a restart mid-experiment
-- resumes rather than starting a second canary. That is the same
-- compare-and-swap this codebase rests on everywhere else, and it is the sixth
-- place it has been needed: the guard is on a value the claimant does not
-- supply.
--
-- `NEEDS_USER` is not a failure and not a pause of the kernel. It is one
-- experiment waiting on an action only a person can take — creating a provider
-- Routine, setting a deployment secret — while every other authorized part of
-- the loop carries on. §24's rule: an escalation with no answering transition is
-- stuck rather than waiting, so `user_action` is NOT NULL for that state and
-- names the exact thing to do.
CREATE TABLE capacity_experiments (
  id                    TEXT PRIMARY KEY,

  -- From `CAPACITY_EXPERIMENT_KINDS`. Refused by the repository if unknown,
  -- for the reason above.
  kind                  TEXT NOT NULL,
  -- The dimension this is trying to reduce the uncertainty in. Half of the
  -- exclusion below.
  dimension             TEXT NOT NULL,
  scope                 TEXT NOT NULL,
  scope_id              TEXT,
  workload_class        TEXT NOT NULL DEFAULT 'ANY',

  state                 TEXT NOT NULL,

  -- Written before anything runs, so an experiment cannot be re-interpreted
  -- after its result is in. The hypothesis, the success metric and the stop
  -- condition are the three things that make a result a result.
  hypothesis            TEXT NOT NULL,
  success_metric        TEXT NOT NULL,
  stop_condition        TEXT NOT NULL,
  resolves_unknown      TEXT NOT NULL,

  -- The one primary factor being changed, and its two values. Null for a purely
  -- observational experiment, which changes nothing at all.
  factor                TEXT,
  baseline_value        REAL,
  canary_value          REAL,

  -- What a person must do, when that is the answer. NULL otherwise.
  user_action           TEXT,

  -- ------------------------------------------------------------------
  -- The rollback point
  -- ------------------------------------------------------------------
  --
  -- The `fleet_policy` version in force when this was authorized, and the
  -- target it carried. Recorded at authorization rather than read back at
  -- rollback time, because by then the row it would read is the experiment's
  -- own — which is how a "revert" quietly adopts the thing it was reverting.
  rollback_policy_version INTEGER,
  rollback_target         INTEGER,
  -- The policy version this experiment itself wrote, so an adopt-or-roll-back
  -- can tell its own change from somebody else's.
  applied_policy_version  INTEGER,

  -- The bins this experiment created as isolated canary load, as a JSON array.
  -- Recorded so a restart can tell "I already made these" from "I have not
  -- started", which is what stops a duplicate canary; and so every event the
  -- experiment produced is reconstructable from the ledger through them.
  canary_bin_ids        TEXT NOT NULL DEFAULT '[]',

  -- The reading at each end, as JSON, and the verdict. Written once.
  baseline_reading      TEXT,
  canary_reading        TEXT,
  verdict               TEXT,
  verdict_reason        TEXT,

  -- Attribution, never authentication. §23's column pair: whose authority this
  -- carries, and how the call got in. `authority_channel` defaults to the
  -- weaker unverifiable value because Brain cannot check a channel and must
  -- never assume the stronger one.
  requested_by          TEXT NOT NULL,
  authority_channel     TEXT NOT NULL DEFAULT 'REPORTED',

  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  -- When the canary window closes. Compared to the clock by a reader, never
  -- enforced by a timer: a kernel whose experiment ends only if a scheduled job
  -- runs is one whose experiments never end when it matters.
  canary_until          TEXT,
  settled_at            TEXT,

  CHECK (state IN ('PROPOSED', 'AUTHORIZED', 'CANARY_RUNNING', 'EVALUATING',
                   'ADOPTED', 'ROLLED_BACK', 'ABANDONED', 'NEEDS_USER')),
  CHECK (verdict IS NULL OR verdict IN ('CONFIRMED', 'REFUTED', 'INCONCLUSIVE', 'STOPPED')),
  CHECK (authority_channel IN ('REPORTED', 'SHELL', 'BROWSER')),
  -- An escalation must name its own remedy.
  CHECK (state <> 'NEEDS_USER' OR user_action IS NOT NULL),
  -- A settled experiment has a verdict, and a live one does not.
  CHECK ((state IN ('ADOPTED', 'ROLLED_BACK', 'ABANDONED')) = (verdict IS NOT NULL))
);

-- One live capacity-changing experiment per scope and dimension.
--
-- `NEEDS_USER` is inside the index deliberately: an experiment parked on a
-- person's action still owns its dimension, and proposing a second one for the
-- same question while the first waits would be two answers arriving out of
-- order. `PROPOSED` is too, so a tick that proposes and then dies does not let
-- the next tick propose the same thing again.
CREATE UNIQUE INDEX idx_capacity_experiments_live
  ON capacity_experiments (dimension, scope, COALESCE(scope_id, ''))
  WHERE state IN ('PROPOSED', 'AUTHORIZED', 'CANARY_RUNNING', 'EVALUATING', 'NEEDS_USER');

CREATE INDEX idx_capacity_experiments_state ON capacity_experiments (state, created_at);
