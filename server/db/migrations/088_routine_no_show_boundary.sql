-- When an operator last said this surface's problem was fixed.
--
-- The no-show quarantine counts `DISPATCH_NO_SHOW` rows on an append-only
-- ledger, since the surface's own last arrival. That is the right fact and it
-- leaves the recovery with nowhere to go: re-enabling a Routine creates no
-- arrival, and an arrival cannot happen until Brain fires the surface again,
-- which it will not do while the surface is quarantined. So `fleet set-state
-- --to ENABLED` would return true and the very next tick would re-quarantine
-- on the same rows, for ever, with the connector genuinely repaired — a
-- transition that exists, reports success and changes nothing that lasts.
--
-- This is the boundary instead. It is written only when a person moves a
-- surface out of QUARANTINED, it only ever moves forward, and it forgives
-- nothing beyond itself: a condition somebody said was fixed and was not takes
-- the surface out again three unanswered fires later rather than immediately.
-- The same shape, and the same reasoning, as the factory worker registry's
-- `consecutive_failures` reset on leaving QUARANTINED.
--
-- Nothing is deleted. Every `DISPATCH_NO_SHOW` row keeps its place on the
-- ledger; what changes is which of them still bear on a decision.
ALTER TABLE fleet_routines ADD COLUMN no_shows_forgiven_at TEXT;

-- And the index the per-surface reading needs.
--
-- `worker_sessions` was indexed by worker and by account and never by Routine,
-- which is the dimension a pool is read along: `sessionsForRoutine` already
-- scanned for it on every capacity reading, once per Routine, and
-- `unansweredFiresByRoutine` asks the same question again per no-show row.
-- Neither is expensive today and both grow with the fleet's own history, which
-- is the wrong thing to be paying for a reading an operator takes to find out
-- whether an account is working.
CREATE INDEX IF NOT EXISTS idx_worker_sessions_routine
  ON worker_sessions (routine_id, observed_at);
