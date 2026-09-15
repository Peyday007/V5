-- Discovery's own identity, which was being read out of the activity feed.
-- ---------------------------------------------------------------------------
--
-- Three findings, one cause: `openDiscovery` and `bucketsByCandidate` both
-- asked `listCashEvents(projectId, 500)` which buckets existed and which
-- candidate belonged to which. That reader is the **activity display window**,
-- hard-capped at 500 rows newest-first. A month of ordinary sprint activity —
-- money entries, card fills, recorded actions — pushes the opening events out
-- of it, and then:
--
--   * `already` comes back empty, so every bucket is opened again as a
--     duplicate;
--   * `bucketsByCandidate` comes back empty, so `harvest` returns nothing at
--     all and the research that ran is never filed.
--
-- A display window is not an index. This table is the durable relationship,
-- and it is read by key rather than by scanning history.
--
-- It also settles a third thing the event could not. `launchableUnderCashMode`
-- asked whether a candidate had an opportunity on `candidate_id`, and a
-- discovery bucket has none — its link lives on `discovered_by_candidate_id`,
-- and a bucket that has found nothing yet has no link at all. So queued
-- discovery passed the wind-down guard and kept launching after somebody had
-- stopped the sprint. **Discovery work is now classified by a row that says so**
-- rather than inferred from the absence of another one.
--
-- `round` is what makes discovery ongoing rather than a single pass. A bucket
-- was skipped for ever once its event existed, so a sprint discovered five
-- things in its first hour and nothing for the rest of its life — which is not
-- what a month-long sprint searching broadly is for. A round is a deliberate
-- re-ask of the same bucket, opened only when the previous one is finished and
-- a cool-off has passed, so "ongoing" cannot become "uncontrolled".
CREATE TABLE IF NOT EXISTS cash_discovery_rounds (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  cash_mode_id  TEXT NOT NULL,

  bucket_id     TEXT NOT NULL,
  mechanism     TEXT NOT NULL,
  round         INTEGER NOT NULL CHECK (round >= 1),

  -- The Russell idea this round asked. Unique, because one candidate is one
  -- round: the wind-down guard reads this column to decide that a candidate is
  -- discovery work, and two rounds sharing one would make that answer
  -- ambiguous at exactly the moment it has to be certain.
  candidate_id  TEXT NOT NULL,

  -- OPEN while the question is live, HARVESTED once its mission's claims have
  -- been read, ABANDONED when the sprint ended before it produced anything.
  -- Nothing is deleted: a round that found nothing is evidence about where
  -- Brain has already looked, which is what stops the next round repeating it.
  state         TEXT NOT NULL CHECK (state IN ('OPEN', 'HARVESTED', 'ABANDONED')),

  opened_at     TEXT NOT NULL,
  harvested_at  TEXT,
  found         INTEGER NOT NULL DEFAULT 0,

  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_rounds_bucket
  ON cash_discovery_rounds(project_id, bucket_id, round);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_rounds_candidate
  ON cash_discovery_rounds(candidate_id);

CREATE INDEX IF NOT EXISTS idx_cash_rounds_project
  ON cash_discovery_rounds(project_id, state);
