-- The hosted execution plane's sessions, which nothing had ever recorded.
--
-- `factory_sessions` is what `metrics.ts` sweeps to answer "how many sessions
-- were genuinely running at one instant", and every writer of that table lives
-- on the **local** plane — `architect.ts`, `dispatch.ts`, `review.ts`,
-- `recovery.ts`. The remote plane has none, so a hosted campaign reported
-- `maxObservedConcurrency: 0` with `concurrencyEvidence: UNKNOWN` over sessions
-- that demonstrably ran: Brain fired them, leased them a bin, timed them and
-- wrote every one of those facts to `bin_events`. A ceiling nobody has observed
-- reads UNKNOWN and stays UNKNOWN; a ceiling Brain measured and could not read
-- back is a column nothing reads, which is a different defect with the same
-- symptom.
--
-- What this adds is the episode identity, so the recording can be derived on
-- the tick from rows Brain wrote rather than hooked to the moment a bin
-- finished — which is what lets it reach the episodes already stranded.
--
-- A bin may be assigned more than once (a takeover, a release and a retake),
-- and each assignment is genuinely a separate session. The pair is therefore
-- the bin and the lease generation that assignment ran under, and the unique
-- index is the arbiter: two ticks reading one finished bin produce one row and
-- the loser is an ordinary outcome. Both columns are nullable, because every
-- row written by the local plane has no bin and never will.
ALTER TABLE factory_sessions ADD COLUMN bin_id TEXT;
ALTER TABLE factory_sessions ADD COLUMN lease_generation INTEGER;

CREATE UNIQUE INDEX idx_factory_sessions_episode
  ON factory_sessions (bin_id, lease_generation)
  WHERE bin_id IS NOT NULL;
