-- ---------------------------------------------------------------------------
-- IDEMPOTENCY AND EFFECT CONTROL
--
-- Step 5's queue is at-least-once and says so. A worker can perform an effect,
-- lose its lease or its connection before recording completion, and the item is
-- delivered again. Fencing protects the *queue state*; nothing yet protected
-- the *effect*.
--
-- These two tables are that protection, and the whole mechanism is one row:
--
--   UNIQUE (scope_hash, key_fingerprint)
--
-- A logical operation reserves itself with INSERT ... ON CONFLICT DO NOTHING.
-- Exactly one caller inserts. Every other equivalent caller — a double click, a
-- retried HTTP request, a second Brain instance, a redelivered queue item —
-- loses that insert, reads the row it collided with, and either replays the
-- result or is told the operation is already running. No process-local lock is
-- involved, so it holds across instances.
--
-- ---------------------------------------------------------------------------
-- What is deliberately *not* stored
-- ---------------------------------------------------------------------------
--
-- The raw idempotency key. Only a digest of it. A key does not need to be
-- secret, but keeping a table of caller-supplied strings buys nothing and is a
-- liability the moment somebody puts something sensitive in one.
--
-- Response bodies. `result_ref` points at the canonical Brain record; replay
-- re-reads it through the same authorization as any other read, so a principal
-- who has since lost access does not get the answer out of this table.
--
-- ---------------------------------------------------------------------------
-- What this does not claim
-- ---------------------------------------------------------------------------
--
-- Universal exactly-once. That is not honestly available across every provider.
-- The guarantees are per effect class, and the schema records which class an
-- attempt belonged to so the claim can be checked rather than assumed:
--
--   same-database        commits exactly once, in one transaction
--   native-idempotent    one stable provider key across every retry
--   reconcilable         ask the provider what happened; never blind repeat
--   opaque               one attempt, then UNCERTAIN and a human decides
-- ---------------------------------------------------------------------------

CREATE TABLE idempotency_operations (
  id                  TEXT PRIMARY KEY,

  -- sha-256 over the server-controlled scoping tuple: Brain boundary, project,
  -- operation namespace and version, and the namespace's declared principal
  -- scope. Nothing the caller sent contributes, so the same visible key cannot
  -- collide across projects or operation types.
  scope_hash          TEXT NOT NULL,
  -- A digest of the key, never the key.
  key_fingerprint     TEXT NOT NULL,

  namespace           TEXT NOT NULL,
  namespace_version   INTEGER NOT NULL DEFAULT 1,

  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_by_type     TEXT NOT NULL,
  created_by_id       TEXT,
  correlation_id      TEXT,

  -- Queue lineage, when this effect is being performed under a lease. Recorded
  -- for provenance; ownership is proven against work_items at commit time, not
  -- read from here.
  work_item_id        TEXT REFERENCES work_items(id) ON DELETE SET NULL,
  lease_generation    INTEGER,

  -- The semantic input, canonicalized and hashed. Reusing a key with a
  -- different fingerprint is a conflict, not a retry.
  request_fingerprint TEXT NOT NULL,
  -- So a future change to canonicalization cannot silently reinterpret old rows.
  fingerprint_version INTEGER NOT NULL DEFAULT 1,

  -- RESERVED | SUCCEEDED | FAILED | UNCERTAIN
  state               TEXT NOT NULL DEFAULT 'RESERVED',
  attempt_count       INTEGER NOT NULL DEFAULT 0,
  failure_category    TEXT,
  -- Why the outcome is unknown. Required when the state is UNCERTAIN, because
  -- "we do not know" without "and here is what we do not know" is not a state
  -- anybody can act on.
  uncertainty_reason  TEXT,
  -- When a RESERVED operation may be recovered by another executor.
  recover_after       TEXT,

  -- A reference to the canonical Brain record, plus safe replay metadata.
  -- Never a response body, never a secret.
  result_ref          TEXT,
  result_status       INTEGER,
  result_summary      TEXT,

  retention_class     TEXT NOT NULL DEFAULT 'STANDARD',
  reserved_at         TEXT NOT NULL,
  started_at          TEXT,
  completed_at        TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,

  CHECK (state IN ('RESERVED', 'SUCCEEDED', 'FAILED', 'UNCERTAIN')),
  CHECK (attempt_count >= 0),
  CHECK (namespace_version >= 1),
  CHECK (fingerprint_version >= 1),
  -- An uncertain effect must say what is uncertain about it.
  CHECK (state <> 'UNCERTAIN' OR uncertainty_reason IS NOT NULL),
  -- Terminal states are finished: nothing is waiting to recover them.
  CHECK (state = 'RESERVED' OR recover_after IS NULL),
  -- A completed operation is timestamped; a running one is not.
  CHECK ((state = 'RESERVED') = (completed_at IS NULL))
);

-- The whole duplicate-suppression mechanism, as one constraint.
CREATE UNIQUE INDEX uq_idempotency_operations__scope_hash_key_fingerprint
  ON idempotency_operations (scope_hash, key_fingerprint);

CREATE INDEX idx_idempotency_operations_project ON idempotency_operations (project_id, state);
CREATE INDEX idx_idempotency_operations_work_item ON idempotency_operations (work_item_id);
-- Finding operations stranded in RESERVED, and operations awaiting a person.
CREATE INDEX idx_idempotency_operations_recovery ON idempotency_operations (state, recover_after);
CREATE INDEX idx_idempotency_operations_retention ON idempotency_operations (retention_class, completed_at);

-- ---------------------------------------------------------------------------
-- ATTEMPTS
--
-- Append-only, one row per execution attempt, kept whatever happened to it.
-- This is where an external effect's story lives: that intent was persisted
-- before anything was sent, that a send began, what came back, and — the row
-- that matters most — that a send began and nothing came back.
--
-- `provider_key` is the stable key handed to a provider that supports
-- idempotency. It is derived from the logical effect identity and never from
-- the lease id, the attempt number or the fencing generation, because those
-- change between retries and a key that changes between retries is not an
-- idempotency key.
-- ---------------------------------------------------------------------------
CREATE TABLE effect_attempts (
  id                TEXT PRIMARY KEY,
  operation_id      TEXT NOT NULL REFERENCES idempotency_operations(id) ON DELETE CASCADE,
  attempt_number    INTEGER NOT NULL,

  executor_type     TEXT NOT NULL,
  executor_id       TEXT,
  work_item_id      TEXT REFERENCES work_items(id) ON DELETE SET NULL,
  lease_id          TEXT,
  lease_generation  INTEGER,

  -- NULL for a same-database effect; the adapter name for an external one.
  adapter           TEXT,
  provider_key      TEXT,

  -- INTENT | SENT | CONFIRMED | FAILED | UNCERTAIN
  phase             TEXT NOT NULL DEFAULT 'INTENT',
  receipt_ref       TEXT,
  -- Safe provider metadata only: identifiers and classifications. Never a raw
  -- provider response, never a credential, never a header.
  receipt_meta      TEXT NOT NULL DEFAULT '{}',

  started_at        TEXT NOT NULL,
  ended_at          TEXT,
  outcome           TEXT,
  detail            TEXT,
  request_id        TEXT,

  CHECK (attempt_number >= 1),
  CHECK (phase IN ('INTENT', 'SENT', 'CONFIRMED', 'FAILED', 'UNCERTAIN')),
  CHECK (outcome IS NULL OR outcome IN ('SUCCEEDED', 'FAILED', 'UNCERTAIN', 'ABANDONED')),
  -- An attempt is numbered once per operation, so two executors cannot both
  -- believe they are attempt 2.
  UNIQUE (operation_id, attempt_number)
);

CREATE INDEX idx_effect_attempts_operation ON effect_attempts (operation_id, attempt_number DESC);
CREATE INDEX idx_effect_attempts_open ON effect_attempts (phase, ended_at);
CREATE INDEX idx_effect_attempts_provider ON effect_attempts (adapter, provider_key);
