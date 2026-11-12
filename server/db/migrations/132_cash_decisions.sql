-- ---------------------------------------------------------------------------
-- CASH DECISIONS: REJECT / HOLD / PRIORITIZE, PER OPPORTUNITY PER GOAL
-- ---------------------------------------------------------------------------
--
-- One current decision per (opportunity, goal). A new decision supersedes the
-- previous one and keeps it: nothing here is ever updated in place except the
-- `is_current` and recompute-request markers, and nothing is deleted.
--
-- `change_ref` names the distinct change that produced the decision (a goal
-- limit changing, new evidence, a date passing). UNIQUE (opportunity_id,
-- goal_id, change_ref) is what makes one change recompute a decision once.
CREATE TABLE cash_decisions (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL,
  opportunity_id        TEXT NOT NULL,
  goal_id               TEXT NOT NULL,
  verdict               TEXT NOT NULL CHECK (verdict IN ('REJECT', 'HOLD', 'PRIORITIZE')),
  reason                TEXT NOT NULL,
  detail                TEXT NOT NULL,
  binding_constraint    TEXT,
  missing_facts         TEXT NOT NULL,
  evidence_ids          TEXT NOT NULL,
  reopen_condition      TEXT NOT NULL,
  change_ref            TEXT NOT NULL,
  is_current            INTEGER NOT NULL DEFAULT 1,
  recompute_change_ref  TEXT,
  recompute_requested_at TEXT,
  decided_at            TEXT NOT NULL,
  superseded_at         TEXT,
  UNIQUE (opportunity_id, goal_id, change_ref)
);
CREATE UNIQUE INDEX idx_cash_decisions_current ON cash_decisions (opportunity_id, goal_id) WHERE is_current = 1;
CREATE INDEX idx_cash_decisions_goal ON cash_decisions (project_id, goal_id, is_current, verdict);
