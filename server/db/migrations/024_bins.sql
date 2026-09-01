-- Step 10. The bin: one complete idea, dispatched to an interchangeable worker.
--
-- Four tables and one column, and the restraint is the point. Everything about
-- *doing* the work already exists — `work_items` is the queue, its
-- compare-and-swap is the claim, its generation is the fence, and
-- `work_item_checkpoints` is durable progress. None of that is rebuilt here.
--
-- What did not exist is a durable representation of the *mission*: the idea a
-- worker is handed, the manifest that fully specifies it, and the predicate
-- that decides whether it was actually finished. That is `bins`.
--
-- Why not call a `research_orchestration` a bin? Because an orchestration is
-- research. It has an assignment, fragments, claims, verification passes and an
-- audit, and every one of those is a research noun. Step 12 will create
-- missions that are not packets, and a dispatcher that reads
-- `research_orchestrations` to decide what to hand out has to be rewritten the
-- first time a mission is not one. So the bin is thin, subject-free, and links
-- *out* to whatever kind of work it happens to contain.

-- ---------------------------------------------------------------------------
-- The mission
-- ---------------------------------------------------------------------------
CREATE TABLE bins (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  layer_id              TEXT REFERENCES layers(id) ON DELETE SET NULL,

  -- The family of mission. Free text on purpose: the dispatcher never reads it
  -- and must stay indifferent to subject matter. It exists so a report can say
  -- what kind of thing this was without parsing the manifest.
  kind                  TEXT NOT NULL,

  title                 TEXT NOT NULL,
  -- The one idea this bin exists to complete, and why the work exists at all.
  objective             TEXT NOT NULL,
  rationale             TEXT,

  -- The complete Brain-authored work package. Everything the worker is allowed
  -- to know about what to do: units, ordering, sources, evidence bar, required
  -- outputs, authorized and prohibited actions, budget, stopping conditions.
  -- The worker executes this and never widens it.
  manifest              TEXT NOT NULL DEFAULT '{}',

  -- Which server-side predicate decides terminal, and which revision of it.
  -- A bin with no contract cannot be dispatched: a mission with no standard is
  -- satisfied vacuously, which is worse than being refused.
  completion_contract   TEXT NOT NULL,
  contract_version      INTEGER NOT NULL DEFAULT 1,

  -- DRAFT      authored, not yet dispatchable
  -- READY      dispatchable; the dispatcher may create intent for it
  -- LEASED     a worker owns it right now
  -- COMPLETE   the contract evaluated true
  -- FAILED     terminal without satisfying the contract
  -- NEEDS_HUMAN one precise decision, named in terminal_reason
  -- CANCELLED  withdrawn
  state                 TEXT NOT NULL DEFAULT 'DRAFT',

  -- Higher first, then oldest first. Deterministic, so two workers checking in
  -- at the same moment see the same ordering and the CAS decides the rest.
  priority              INTEGER NOT NULL DEFAULT 5,

  -- The research packet this bin drives, when it drives one. NULL for every
  -- mission that is not a packet, which is the whole reason this is a link
  -- rather than an inheritance.
  orchestration_id      TEXT REFERENCES research_orchestrations(id) ON DELETE SET NULL,

  -- The allowance boundary, as the manifest declared it. Recorded on the row so
  -- a report does not have to parse JSON to answer "what was this allowed to
  -- spend".
  budget_units          INTEGER,

  attempt_count         INTEGER NOT NULL DEFAULT 0,
  max_attempts          INTEGER NOT NULL DEFAULT 3,

  -- The fencing token, exactly as `work_items` uses it: advances by one on
  -- every assignment and every cancellation, so any holder of an older value is
  -- provably stale. It is also what makes a re-ready bin a *new* dispatch
  -- intent rather than a duplicate of the old one.
  lease_generation      INTEGER NOT NULL DEFAULT 0,
  lease_id              TEXT,
  worker_id             TEXT REFERENCES workers(id) ON DELETE SET NULL,
  lease_credential_id   TEXT,
  -- The provider's own session identity, when the worker reported one. For
  -- telemetry and for reading a run back on claude.ai; never authority.
  lease_session_ref     TEXT,
  leased_at             TEXT,
  heartbeat_at          TEXT,
  lease_expires_at      TEXT,
  lease_renewals        INTEGER NOT NULL DEFAULT 0,

  -- Durable progress, written by the owner under its fence. What a resuming
  -- worker reads so it does not start the bin again from nothing.
  checkpoint            TEXT,
  checkpoint_at         TEXT,

  -- Why the bin ended where it did. On a refusal this holds the contract's own
  -- reason, kept forever: a verdict you cannot trace is not auditable.
  terminal_reason       TEXT,
  last_refusal          TEXT,
  refusal_count         INTEGER NOT NULL DEFAULT 0,

  created_by_type       TEXT NOT NULL,
  created_by_id         TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  ready_at              TEXT,
  completed_at          TEXT,

  CHECK (state IN ('DRAFT','READY','LEASED','COMPLETE','FAILED','NEEDS_HUMAN','CANCELLED')),
  CHECK (priority BETWEEN 0 AND 9),
  CHECK (attempt_count >= 0),
  CHECK (max_attempts >= 1),
  CHECK (lease_generation >= 0),
  CHECK (contract_version >= 1),

  -- A lease exists if and only if the bin is LEASED. The same invariant
  -- `work_items` states, for the same reason: every "impossible" combination
  -- the code's comments rely on is impossible here rather than merely untested.
  CHECK (
    (state = 'LEASED'
       AND lease_id IS NOT NULL AND worker_id IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR
    (state <> 'LEASED'
       AND lease_id IS NULL AND worker_id IS NULL AND lease_expires_at IS NULL)
  )
);

CREATE INDEX idx_bins_ready ON bins (state, priority DESC, created_at);
CREATE INDEX idx_bins_project ON bins (project_id, state);
CREATE INDEX idx_bins_orchestration ON bins (orchestration_id);

-- ---------------------------------------------------------------------------
-- Which bin an internal unit belongs to
-- ---------------------------------------------------------------------------
--
-- One column, and it is what keeps there from being a second queue. A bin's
-- units are ordinary `work_items` with the ordinary claim, lease and fence; the
-- bin only says which of them are its own.
ALTER TABLE work_items ADD COLUMN bin_id TEXT REFERENCES bins(id) ON DELETE SET NULL;
CREATE INDEX idx_work_items_bin ON work_items (bin_id, state);

-- ---------------------------------------------------------------------------
-- Durable dispatch intent
-- ---------------------------------------------------------------------------
--
-- The outbox. A bin becoming READY writes a row here; a plain interval loop
-- later turns it into an HTTP call. Two separate facts, so a crash between them
-- loses nothing and a restart redrives what was never sent.
--
-- The unique key is (bin_id, lease_generation). While a bin sits READY at
-- generation 4, every dispatcher tick tries to insert the same row and every
-- one after the first does nothing. When a lease expires the generation
-- advances, and the bin legitimately earns a fresh intent — which is exactly
-- the recovery case, expressed by the same key rather than by a special path.
CREATE TABLE bin_dispatch (
  id                TEXT PRIMARY KEY,
  bin_id            TEXT NOT NULL REFERENCES bins(id) ON DELETE CASCADE,
  -- The generation the bin was at when this intent was created.
  lease_generation  INTEGER NOT NULL,

  -- PENDING    not yet sent, or waiting out a backoff
  -- SENDING    a dispatcher tick owns it and is making the call right now
  -- SENT       the provider accepted it and named a session
  -- ABANDONED  attempts exhausted; recorded, never silently dropped
  -- SUPERSEDED the bin moved on before this was sent
  --
  -- SENDING exists because the claim has to be a compare-and-swap on a value
  -- the claimer does not supply. Swapping on `attempt_count` looked equivalent
  -- and is not: two ticks that read at different moments read different counts,
  -- and each one's UPDATE then matches its own read. Postgres found that;
  -- SQLite's serialised writers had hidden it. `state = 'PENDING'` is the same
  -- for both claimers however they raced, so exactly one swap succeeds.
  --
  -- `next_attempt_at` doubles as the deadline: a SENDING intent whose deadline
  -- has passed is claimable again, so a dispatcher that died mid-call cannot
  -- strand it. The same shape as an expired lease being claimable work.
  state             TEXT NOT NULL DEFAULT 'PENDING',

  attempt_count     INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 5,
  next_attempt_at   TEXT NOT NULL,

  -- Which routine was fired, and what the provider said. `routine_ref` is the
  -- trigger id; the token that authorised the call is never here and is not
  -- recoverable from here.
  routine_ref       TEXT,
  routine_version   TEXT,
  fire_event_id     TEXT,
  session_ref       TEXT,

  -- The last failure, as a category and a bounded message. Never a credential,
  -- never a response body that could carry one.
  last_error_kind   TEXT,
  last_error        TEXT,

  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  sent_at           TEXT,

  CHECK (state IN ('PENDING','SENDING','SENT','ABANDONED','SUPERSEDED')),
  CHECK (attempt_count >= 0),
  CHECK (max_attempts >= 1)
);

CREATE UNIQUE INDEX idx_bin_dispatch_intent ON bin_dispatch (bin_id, lease_generation);
CREATE INDEX idx_bin_dispatch_pending ON bin_dispatch (state, next_attempt_at);

-- ---------------------------------------------------------------------------
-- Generic unit results
-- ---------------------------------------------------------------------------
--
-- What a non-research bin stores. A research bin stores claims, verdicts and
-- documents in the tables that already hold them; a generic mission needs
-- somewhere durable for the thing it established, or its completion contract
-- would have nothing to read and would be reduced to trusting the worker.
--
-- `value` is the worker's answer. `content_hash` is over it, so a bin that
-- submits the same content for every unit is visible as such rather than
-- passing because each row exists.
CREATE TABLE bin_unit_results (
  id             TEXT PRIMARY KEY,
  bin_id         TEXT NOT NULL REFERENCES bins(id) ON DELETE CASCADE,
  unit_key       TEXT NOT NULL,
  work_item_id   TEXT REFERENCES work_items(id) ON DELETE SET NULL,

  value          TEXT NOT NULL,
  content_hash   TEXT NOT NULL,
  -- The lease that produced it, so a result written by a worker that had
  -- already lost the bin is identifiable after the fact.
  lease_id       TEXT,
  lease_generation INTEGER,

  submitted_by   TEXT,
  created_at     TEXT NOT NULL,

  UNIQUE (bin_id, unit_key)
);

-- ---------------------------------------------------------------------------
-- Raw telemetry for Step 11
-- ---------------------------------------------------------------------------
--
-- Append-only, no foreign key to `bins`. An observation a cascade can delete is
-- not an observation — the same reasoning `identity_events` is built on.
--
-- Step 11 is not being built here. These are the facts it will need and which
-- cannot be reconstructed afterwards from application logs: when things
-- happened, how long they waited, how many times a lease was renewed, what was
-- retried, what the provider said, and what the run actually cost where the
-- provider will say.
CREATE TABLE bin_events (
  id                TEXT PRIMARY KEY,
  event_type        TEXT NOT NULL,
  at                TEXT NOT NULL,

  bin_id            TEXT,
  project_id        TEXT,
  layer_id          TEXT,
  orchestration_id  TEXT,
  work_item_id      TEXT,

  worker_id         TEXT,
  session_ref       TEXT,
  routine_ref       TEXT,
  routine_version   TEXT,
  fire_event_id     TEXT,
  provider          TEXT,

  lease_id          TEXT,
  lease_generation  INTEGER,
  attempt           INTEGER,

  -- Milliseconds, when the event is about a duration.
  duration_ms       INTEGER,
  -- Counts the event carries: units done, tool calls, sources, claims,
  -- artifacts. A JSON object rather than fifty columns, because Step 11 will
  -- want measures nobody has thought of yet and a migration per measure is how
  -- telemetry stops being recorded.
  measures          TEXT NOT NULL DEFAULT '{}',

  outcome           TEXT,
  reason            TEXT,
  -- TRUE when a usage figure here is an observable proxy rather than the
  -- provider's own accounting. A number nobody can source is worse than none.
  is_proxy          INTEGER NOT NULL DEFAULT 0,

  CHECK (is_proxy IN (0, 1))
);

CREATE INDEX idx_bin_events_bin ON bin_events (bin_id, at);
CREATE INDEX idx_bin_events_type ON bin_events (event_type, at);
CREATE INDEX idx_bin_events_session ON bin_events (session_ref);
