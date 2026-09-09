-- An idea may be researched more than once.
--
-- A mission's idempotency key is `russell:mission:<candidate>:<goal>` and never
-- changes, and `launchMission` inserts ON CONFLICT DO NOTHING. So a candidate
-- got exactly one mission for the life of its grant: once that mission ended —
-- cancelled by its owner, failed, or parked having produced nothing — the idea
-- could never be researched again. The loop went on selecting it as QUEUED on
-- every tick and went on re-finding the same dead row.
--
-- That is §24's rule at a fourth altitude. Every escalation must have an
-- answering transition, and "that run produced nothing" had none: not a retry,
-- not a redo, not even a way to say the idea was finished with. One bad packet
-- retired an idea permanently.
--
-- The remedy is the one this codebase already uses for exactly this shape. §5:
-- a failed run is never overwritten, edited or deleted; a redo creates a NEW
-- run with a parent, an incremented attempt number and a reason. So a mission
-- redo is a new mission row that points at the one it supersedes, and the old
-- row keeps its state, its terminal reason, its packet and its reservation.
--
-- `attempt` defaults to 1, so every existing mission is attempt 1 and its key
-- is unchanged — the redo appends `:<attempt>` only from attempt 2, which is
-- what keeps the idempotency of every row already written.
ALTER TABLE russell_missions
  ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;

ALTER TABLE russell_missions
  ADD COLUMN supersedes_mission_id TEXT NULL REFERENCES russell_missions(id);

CREATE INDEX IF NOT EXISTS idx_russell_missions_candidate_attempt
  ON russell_missions (candidate_id, attempt);
