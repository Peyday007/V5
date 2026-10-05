-- A research goal owns a budget: a durable russell_goals row, purpose
-- RESEARCH_GOAL, whose packet, fragment and deadline ceilings are enforced
-- through the existing reservation ledger rather than a second quota system.
-- A packet links back to its goal through research_orchestrations.goal_id, and
-- (goal_id, goal_packet_key) is unique so one packet key is one orchestration.
-- Additive: every existing goal reads STANDING and every existing packet has no
-- goal. No row is changed.
ALTER TABLE russell_goals
  ADD COLUMN purpose TEXT NOT NULL DEFAULT 'STANDING'
  CHECK (purpose IN ('STANDING','RESEARCH_GOAL'));

ALTER TABLE research_orchestrations
  ADD COLUMN goal_id TEXT REFERENCES russell_goals(id) ON DELETE SET NULL;

ALTER TABLE research_orchestrations ADD COLUMN goal_packet_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_research_orchestrations_goal_packet
  ON research_orchestrations (goal_id, goal_packet_key);

CREATE INDEX IF NOT EXISTS idx_research_orchestrations_goal
  ON research_orchestrations (goal_id);
