-- ---------------------------------------------------------------------------
-- A GOAL CARRIES ITS POLICY
-- ---------------------------------------------------------------------------
--
-- SQUEEZE is one policy, not the definition of a goal. Until this table a goal
-- had nowhere to say it was a long-term venture, a creative, research or
-- recurring-income goal, so every goal was read as SQUEEZE. One row per goal
-- is its current policy; the person who set it and every change are recorded
-- as workstream events. A goal with no row is SQUEEZE, as it always was.
CREATE TABLE IF NOT EXISTS goal_policies (
  workstream_id       TEXT PRIMARY KEY REFERENCES workstreams(id),
  kind                TEXT NOT NULL CHECK (kind IN
                        ('SQUEEZE', 'LONG_TERM_VENTURE', 'CREATIVE', 'RESEARCH', 'RECURRING_INCOME')),
  reliability_normal  DOUBLE PRECISION,
  reliability_adverse DOUBLE PRECISION,
  set_by              TEXT NOT NULL,
  set_at              TEXT NOT NULL,
  CHECK (reliability_normal IS NULL OR (reliability_normal > 0 AND reliability_normal <= 1)),
  CHECK (reliability_adverse IS NULL OR (reliability_adverse > 0 AND reliability_adverse <= 1)),
  CHECK (kind = 'SQUEEZE' OR (reliability_normal IS NULL AND reliability_adverse IS NULL))
);
