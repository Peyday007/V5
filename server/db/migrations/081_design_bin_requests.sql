-- ---------------------------------------------------------------------------
-- WHAT A DESIGN BIN WAS ASKED ABOUT
--
-- Migration 080 gave the design kernel two lanes and no record of what it had
-- *asked*. That omission had two consequences, and both are the kind this
-- repository keeps having to correct rather than the kind a reader spots.
--
-- 1. A REVIEW WAS NOT BOUND TO THE EVIDENCE IT WAS BRIEFED ON.
--
--    `openDesignReview` computed `digestCaptures(input.captures)` and then used
--    the value for nothing at all. So the digest a review was finally recorded
--    with came from `listCaptures(cycle, pass)` read back **at ingest time**,
--    which is a different question: it is "what is in the table now", not "what
--    was this reviewer shown". A capture written between the two — a resumed
--    pass, a re-render, a second renderer — would have been silently folded in,
--    and the review would have settled a cycle over evidence nobody judged.
--
--    §23 records the same shape at the audit reopen and answers it the same
--    way: the reservation is bound to the bytes, and a document whose bytes
--    changed is a *different operation* rather than a repeat. `capture_digest`
--    here is that binding, written when the question is asked and compared
--    before the answer is believed.
--
-- 2. NOTHING SAID A CYCLE WAS WAITING FOR AN ANSWER.
--
--    A cycle is OPEN while it waits for a machine that can render, and OPEN
--    while it waits for a judgement, and those are different states with
--    different remedies — §24's sentence at a column. `pendingCycles` guessed
--    between them from `passes === 0`, which is a proxy rather than a reading.
--    An outstanding row of this table *is* the distinction: a RENDER request
--    means nothing has looked yet, a REVIEW request means something has looked
--    and a reader has not answered.
--
-- One table and two kinds rather than two tables, because the shape is
-- identical and the one nobody reads is the one that drifts (§23, at the
-- capacity ledger). `UNIQUE (cycle_id, pass, kind)` is what makes opening one
-- idempotent by the round rather than by a flag a dying tick could set.
--
-- `capture_digest` is NULL on a RENDER request, and that is a fact rather than
-- an omission: nothing has been captured yet, so there is nothing to bind to.
-- A REVIEW request with no digest is refused by the CHECK, because a review of
-- an unnamed capture set is the exact defect above.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS design_bin_requests (
  -- The bin is the identity. One bin answers one question, and a bin deleted
  -- takes its question with it.
  bin_id         TEXT PRIMARY KEY REFERENCES bins(id) ON DELETE CASCADE,

  cycle_id       TEXT NOT NULL REFERENCES design_cycles(id) ON DELETE CASCADE,
  pass           INTEGER NOT NULL DEFAULT 0 CHECK (pass >= 0),

  --   RENDER  nothing has looked at these surfaces yet; a worker with a
  --           browser is being asked to, and to report what it measured
  --   REVIEW  they have been rendered and measured, and a reader is being
  --           asked the half measurement cannot settle
  kind           TEXT NOT NULL CHECK (kind IN ('RENDER', 'REVIEW')),

  -- The surfaces the question is about, as JSON. Copied onto the request
  -- rather than read from the cycle, because a cycle's surface list is what it
  -- is *now* and this is what was asked.
  surface_keys   TEXT NOT NULL,

  -- The tree the question is about. A render request names the revision a
  -- worker should check out; a review request names the revision that was
  -- rendered. Null on an unstamped tree rather than guessed (§27).
  revision       TEXT,

  -- The capture set a REVIEW was briefed on, digested exactly as
  -- `design_approvals` digests a render set. NULL on a RENDER.
  capture_digest TEXT,
  capture_count  INTEGER NOT NULL DEFAULT 0 CHECK (capture_count >= 0),

  created_at     TEXT NOT NULL,

  -- A review with no capture set named is the defect this table exists for.
  CHECK (kind = 'RENDER' OR capture_digest IS NOT NULL),
  -- A render has nothing to bind to yet, and saying it does would be a lie the
  -- ingest would then check against.
  CHECK (kind = 'REVIEW' OR capture_digest IS NULL),

  UNIQUE (cycle_id, pass, kind)
);

CREATE INDEX IF NOT EXISTS idx_design_bin_requests_cycle
  ON design_bin_requests (cycle_id, pass);
CREATE INDEX IF NOT EXISTS idx_design_bin_requests_kind
  ON design_bin_requests (kind, created_at);
