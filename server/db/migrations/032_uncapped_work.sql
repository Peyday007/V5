-- Continuous authorized work, rather than a lifetime allowance.
--
-- The grant carried four numbers and three of them were lifetime quotas:
-- missions, fragments and probes. A subscription-backed Brain that stops after
-- N pieces of research for ever, and needs a person to replenish it, is a
-- machine for managing an allowance rather than one that does the work. The
-- original specification said measured starting values must not become
-- permanent capacity ceilings, and they had.
--
-- So the policy becomes explicit rather than an enormous number pretending to
-- be unlimited: UNCAPPED means the cumulative ceilings do not stop anything.
-- The columns stay, and so does every reservation row ever written — this
-- removes the stopping rule, not the evidence. What a grant has consumed is
-- still counted and still shown.
--
-- Concurrency is untouched and stays real. It is not an artificial quota: it
-- is what the provider can actually run at once, and raising it is a fleet
-- capacity decision that lives in fleet_policy with an actor and a reason.
--
-- Existing rows default to UNCAPPED, which applies the correction to the live
-- grant without re-granting it and without losing what it has spent.
-- CAPPED is not a dead branch kept for symmetry. Grants that have already
-- ended were genuinely enforced against their four numbers, and saying so is
-- the difference between recording what governed a decision and rewriting it.
-- Only what is still in force is corrected.
ALTER TABLE russell_goals
  ADD COLUMN work_policy TEXT NOT NULL DEFAULT 'UNCAPPED'
  CHECK (work_policy IN ('UNCAPPED','CAPPED'));

UPDATE russell_goals SET work_policy = 'CAPPED' WHERE state <> 'ACTIVE';
