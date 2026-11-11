-- ---------------------------------------------------------------------------
-- A GOAL'S POLICY, RECORDED
-- ---------------------------------------------------------------------------
--
-- A goal carries a policy. Without a row here it is SQUEEZE, the policy every
-- targeted goal was already held to; a person records LONG_TERM_VENTURE,
-- CREATIVE, RESEARCH or RECURRING_INCOME (and, for SQUEEZE, its own
-- reliability standard) and `services/goals/policy.ts` reads the latest row.
-- Append-only: a change is a new row, the older ones stay as its history.
CREATE TABLE IF NOT EXISTS goal_policies (
  id                  TEXT PRIMARY KEY,
  goal_id             TEXT NOT NULL REFERENCES workstreams(id),
  kind                TEXT NOT NULL CHECK (kind IN
                        ('SQUEEZE', 'LONG_TERM_VENTURE', 'CREATIVE', 'RESEARCH', 'RECURRING_INCOME')),
  reliability_normal  REAL CHECK (reliability_normal IS NULL OR (reliability_normal > 0 AND reliability_normal <= 1)),
  reliability_adverse REAL CHECK (reliability_adverse IS NULL OR (reliability_adverse > 0 AND reliability_adverse <= 1)),
  set_by              TEXT NOT NULL,
  set_at              TEXT NOT NULL,
  CHECK (kind = 'SQUEEZE' OR (reliability_normal IS NULL AND reliability_adverse IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_goal_policies_goal ON goal_policies(goal_id, set_at);
