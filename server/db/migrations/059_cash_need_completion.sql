-- A need that is answered because something is true, and a continuation that
-- survives not working the first time.
-- ---------------------------------------------------------------------------
--
-- Three findings about `cash_needs`, and each of them is a promise the table
-- could not keep.
--
-- **`closeNeed` accepted any non-empty sentence.** `completion_condition` was
-- required at creation and then checked by nothing, so writing "done" resolved
-- a need whose capability was still missing — and the piece it was blocking
-- went back to waiting on a thing that had not happened. A written explanation
-- is not a working integration. `verified_by` records which it was: Brain read
-- the rows and the condition held, or a person authorized a manual substitute
-- and said what they did instead.
--
-- **A recurring blockage could never be raised again.** `request_key` was
-- unique per project and `needForKey` ignored state, so once a capability need
-- was resolved the key was spent: the same capability going missing a month
-- later found the old row, returned it as "already raised", and the review
-- never mentioned it. `occurrence` makes each return its own row, and the
-- unique index moves with it.
--
-- **A continuation was consumed before it succeeded.** `continued_at` was
-- written permanently *before* `continueOne` ran, so a temporary refusal — no
-- authority yet, no execution slot, the piece not READY — burned the only
-- attempt and nothing ever retried. The ordinary path made that the common
-- case rather than the rare one: filling a card leaves the piece at
-- EVIDENCE_CARD, so a need resolved then is resolved *before* READY exists.
--
-- A claim is now a lease. `continuation_claimed_at` is taken, the work runs on
-- the far side of it, and `continued_at` is set only when the continuation
-- reached a terminal answer. A claim that was taken and never settled — a crash
-- mid-flight — expires and is reclaimed, which is Step 5's rule at a new table:
-- an expired lease is claimable work, so recovery never depends on one process
-- staying alive.
ALTER TABLE cash_needs ADD COLUMN occurrence INTEGER NOT NULL DEFAULT 1;
ALTER TABLE cash_needs ADD COLUMN verified_by TEXT;
ALTER TABLE cash_needs ADD COLUMN continuation_claimed_at TEXT;
ALTER TABLE cash_needs ADD COLUMN continuation_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cash_needs ADD COLUMN continuation_not_before TEXT;

DROP INDEX IF EXISTS idx_cash_needs_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_needs_key
  ON cash_needs(project_id, request_key, occurrence);
