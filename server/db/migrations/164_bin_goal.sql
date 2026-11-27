-- ---------------------------------------------------------------------------
-- A BIN NAMES THE GOAL IT SERVES (2026-11-27)
-- ---------------------------------------------------------------------------
--
-- The app-session planning path queues an independent review of each clean plan
-- revision (PLAN_REVIEW) and a verification of each research answer
-- (PLAN_VERIFY). Claude routines are handed bins through `brain_check_in` and
-- nothing else, so a review queued as a loose item never reached the fleet on
-- production: the owner's own review waited on a session he would have to open.
-- Each such item now belongs to a one-item bin, and the bin names its goal so
-- the owner's §118 exception (an owner-directed goal's work may go to a routine)
-- admits it by the goal itself. Null for every other bin.
-- ---------------------------------------------------------------------------

ALTER TABLE bins ADD COLUMN goal_id TEXT;

CREATE INDEX idx_bins_goal ON bins (goal_id);
