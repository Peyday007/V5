-- An assignment a Brain guard refuses is not an attempt the bin spent.
--
-- Production showed the defect end to end. `bin_75bea12e15534ba4b93f` held one
-- RESEARCH_AUDIT item; the fleet's one Routine kept arriving on the session
-- that had already performed a role in that audit round; `auditAdmission`
-- correctly withheld the item every time — and `assignNextBin` had already
-- charged the bin an attempt in the same statement that handed it over. That
-- repeated 71 times in two hours until the bin read 100/100 and escalated,
-- with the packet's audit still one role from finished.
--
-- Three things were wrong and they are one thing: the eligibility question was
-- asked *after* the accounting, so a refusal Brain issued to itself was
-- recorded as the bin failing.
--
--   * `bin_session_refusals` remembers which sessions a bin has already
--     refused and when it is worth asking again. It is a pre-filter, never the
--     authority: the live admission check still runs and still decides. The row
--     exists so that the same session is not offered the same bin on a tight
--     loop, and so the refusal is a fact somebody can read afterwards rather
--     than an absence.
--
--   * `bins.dispatch_not_before` defers Brain's decision to spend a *fire* on
--     the bin. It is deliberately absent from `DISPATCHABLE_SQL`, so the
--     assigner ignores it entirely: a fresh eligible session arriving for any
--     reason is handed the bin immediately. Only the dispatcher waits.
--
-- Nothing here is a ceiling, a quota or a policy. Both are backoff, and both
-- expire by being compared to the clock rather than by anything running.
CREATE TABLE bin_session_refusals (
  bin_id       TEXT NOT NULL REFERENCES bins(id),
  -- The credential the refused request authenticated with. Server-derived, and
  -- never a body field: a session that could name itself could name another.
  session_ref  TEXT NOT NULL,
  first_at     TEXT NOT NULL,
  last_at      TEXT NOT NULL,
  -- Every refusal is counted, and the count is what the backoff is derived
  -- from. §5: the history is kept, not collapsed.
  refusals     INTEGER NOT NULL DEFAULT 1,
  retry_at     TEXT NOT NULL,
  -- Brain's own words for why, bounded by what `auditEligibility` guarantees
  -- about its reasons: the pair and the dimension, never a value.
  reason       TEXT NOT NULL,
  PRIMARY KEY (bin_id, session_ref)
);

CREATE INDEX IF NOT EXISTS idx_bin_session_refusals_retry
  ON bin_session_refusals (bin_id, retry_at);

ALTER TABLE bins ADD COLUMN dispatch_not_before TEXT NULL;
