-- ---------------------------------------------------------------------------
-- THE GOAL ENGINE: A GOAL'S POLICY IS A ROW
-- ---------------------------------------------------------------------------
--
-- A goal carries a policy (SQUEEZE, LONG_TERM_VENTURE, CREATIVE, RESEARCH,
-- RECURRING_INCOME). Until now nothing stored one, so every goal read as
-- SQUEEZE and a long-term or creative goal could never reach its own policy.
--
-- Append-only: a change of policy is a new row, the latest per goal is the
-- current one, and earlier rows stay as the goal's history. No row means the
-- goal has not been given a policy, which reads as SQUEEZE (the default) and
-- is reported as "not set". A reliability override belongs to SQUEEZE only.
CREATE TABLE IF NOT EXISTS goal_policies (
  id                  TEXT PRIMARY KEY,
  goal_id             TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL CHECK (kind IN
                        ('SQUEEZE', 'LONG_TERM_VENTURE', 'CREATIVE', 'RESEARCH', 'RECURRING_INCOME')),
  reliability_normal  REAL CHECK (reliability_normal IS NULL OR (reliability_normal > 0 AND reliability_normal <= 1)),
  reliability_adverse REAL CHECK (reliability_adverse IS NULL OR (reliability_adverse > 0 AND reliability_adverse <= 1)),
  reason              TEXT,
  set_by_user_id      TEXT REFERENCES users(id),
  created_at          TEXT NOT NULL,
  CHECK (kind = 'SQUEEZE' OR (reliability_normal IS NULL AND reliability_adverse IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_goal_policies_goal ON goal_policies(goal_id, created_at);
