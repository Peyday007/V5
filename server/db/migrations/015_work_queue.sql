-- ---------------------------------------------------------------------------
-- THE DISTRIBUTED WORK QUEUE
--
-- Until now, "what is being worked on" lived in a JavaScript array. Two of
-- them, in fact — research/queue.ts and documents/queue.ts — each an array and
-- a Map inside one process. That is why fly.toml pins exactly one machine: a
-- second one would keep its own array, know nothing of the first, and both
-- would start the same work.
--
-- These two tables move that truth into the database, where several Brain
-- instances can share it. The design has one idea in it, and everything else
-- follows from that idea:
--
--   A claim is a compare-and-swap on a generation number.
--
-- Two workers may both read generation 7 and both try to take the item. The
-- UPDATE says `WHERE lease_generation = 7`, so exactly one of them matches;
-- the other changes no rows and moves to the next candidate. No lock is held
-- while the work is performed, no process needs to stay alive for correctness,
-- and the same statement works on SQLite and on Postgres because both drivers
-- report `changes` identically.
--
-- The generation is also the fencing token. Every later operation by that
-- worker — heartbeat, complete, fail, release — must present the lease id and
-- the generation it was given. A worker whose lease expired while it was busy
-- comes back holding generation 7 against a row that is now on 8, and every one
-- of its operations matches nothing. It cannot resurrect the item, cannot
-- overwrite the new owner's result, and cannot complete work somebody else is
-- already redoing.
--
-- What this is not: exactly-once execution. A lease can expire after a worker
-- performed an effect and before it recorded the completion, so the item is
-- redelivered and the effect happens twice. Fencing protects the *queue state*.
-- Protecting the *effect* is Step 6, and until Step 6 exists the only work this
-- queue may carry is work that is safe to perform more than once.
-- ---------------------------------------------------------------------------

CREATE TABLE work_items (
  id                   TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- Which registered kind of work this is. The registry decides what payload
  -- is valid; there is no work type meaning "run this command".
  work_type            TEXT NOT NULL,

  -- QUEUED | LEASED | SUCCEEDED | FAILED | CANCELLED
  state                TEXT NOT NULL DEFAULT 'QUEUED',

  -- Higher runs first. Bounded so that "just make it priority 9999" cannot
  -- quietly become the way every caller jumps the queue.
  priority             INTEGER NOT NULL DEFAULT 5,

  -- When this becomes eligible. Set to now on enqueue, and pushed forward only
  -- by retry backoff. This is not a scheduler: general scheduled firing is
  -- Step 10 and is not being started here.
  available_at         TEXT NOT NULL,

  -- Validated against the work type's schema. Never a credential, never a
  -- duplicated document, never model context that has a canonical home.
  payload              TEXT NOT NULL DEFAULT '{}',

  -- What a worker must hold in this project to be eligible, as a JSON array.
  required_scopes      TEXT NOT NULL DEFAULT '[]',

  -- Pin work to one worker, when the use case is real. Usually null.
  target_worker_id     TEXT REFERENCES workers(id) ON DELETE SET NULL,

  attempt_count        INTEGER NOT NULL DEFAULT 0,
  max_attempts         INTEGER NOT NULL DEFAULT 3,

  -- The fencing token. Advances by exactly one on every claim and on every
  -- cancellation, so any holder of an older value is provably stale.
  lease_generation     INTEGER NOT NULL DEFAULT 0,
  lease_id             TEXT,
  worker_id            TEXT REFERENCES workers(id) ON DELETE SET NULL,
  -- Which credential presented itself, for attribution. The credential itself
  -- is not here and is not recoverable from here.
  lease_credential_id  TEXT,
  leased_at            TEXT,
  heartbeat_at         TEXT,
  lease_expires_at     TEXT,

  -- A reference to a canonical Brain record, plus a bounded human summary.
  -- Not the result itself: the queue is a dispatcher, not a document store.
  result_ref           TEXT,
  result_summary       TEXT,
  failure_category     TEXT,
  cancelled_reason     TEXT,

  correlation_id       TEXT,
  created_by_type      TEXT NOT NULL,
  created_by_id        TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  completed_at         TEXT,

  CHECK (state IN ('QUEUED', 'LEASED', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
  CHECK (priority BETWEEN 0 AND 9),
  CHECK (attempt_count >= 0),
  CHECK (max_attempts >= 1),
  CHECK (lease_generation >= 0),

  -- The invariant that matters, stated where it cannot be forgotten: a lease
  -- exists if and only if the item is LEASED. A row cannot be QUEUED while
  -- still naming an owner, and cannot be LEASED without one. Every "impossible"
  -- combination this file's comments rely on is impossible here rather than
  -- merely untested.
  CHECK (
    (state = 'LEASED'
       AND lease_id IS NOT NULL AND worker_id IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR
    (state <> 'LEASED'
       AND lease_id IS NULL AND worker_id IS NULL AND lease_expires_at IS NULL)
  )
);

-- The claim path, in the order the claim query reads it. A worker asking for
-- work should touch an index and not the table.
CREATE INDEX idx_work_items_claim
  ON work_items (state, project_id, priority DESC, available_at, created_at, id);
-- Finding leases that have run out, for reclaim and for metrics.
CREATE INDEX idx_work_items_expiry ON work_items (state, lease_expires_at);
CREATE INDEX idx_work_items_project ON work_items (project_id, state);
CREATE INDEX idx_work_items_worker ON work_items (worker_id, state);

-- ---------------------------------------------------------------------------
-- LEASE HISTORY
--
-- Append-only. One row per attempt, kept whatever happened to it, so the
-- question "who had this, when, and why did they stop" has an answer months
-- later. A failed attempt is evidence, not something to tidy away — the same
-- rule the research engine already follows for failed runs.
--
-- Heartbeats update a counter and a timestamp on the current row rather than
-- appending. A heartbeat every few seconds across a fleet would otherwise be
-- the largest table in this database, and it would bury the events worth
-- reading underneath a million "still here" messages.
-- ---------------------------------------------------------------------------
CREATE TABLE work_leases (
  id                 TEXT PRIMARY KEY,
  work_item_id       TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  attempt_number     INTEGER NOT NULL,
  lease_generation   INTEGER NOT NULL,
  worker_id          TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  credential_id      TEXT,
  claimed_at         TEXT NOT NULL,
  expires_at         TEXT NOT NULL,
  last_heartbeat_at  TEXT,
  heartbeat_count    INTEGER NOT NULL DEFAULT 0,
  ended_at           TEXT,
  -- SUCCEEDED | FAILED | EXPIRED | CANCELLED | RELEASED
  outcome            TEXT,
  -- Bounded and sanitized. Never a provider response, never a stack trace.
  detail             TEXT,
  request_id         TEXT,

  CHECK (attempt_number >= 1),
  CHECK (heartbeat_count >= 0),
  CHECK (outcome IS NULL OR outcome IN ('SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED', 'RELEASED')),

  -- The whole design, as one database constraint: a generation is issued
  -- exactly once per item. If every layer above this were wrong and two claims
  -- both believed they had won, the second INSERT would fail rather than
  -- produce two owners.
  UNIQUE (work_item_id, lease_generation)
);

CREATE INDEX idx_work_leases_item ON work_leases (work_item_id, lease_generation DESC);
CREATE INDEX idx_work_leases_worker ON work_leases (worker_id, claimed_at DESC);
CREATE INDEX idx_work_leases_open ON work_leases (ended_at, expires_at);
