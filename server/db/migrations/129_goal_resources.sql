-- ---------------------------------------------------------------------------
-- WHAT A GOAL'S OWNER HAS TO WORK WITH
-- ---------------------------------------------------------------------------
--
-- A goal's owner may have people, equipment, relationships, licences or time
-- that no ledger records. This is their own statement of it, in their words,
-- read by the goal's plan and by the discovery questions asked for the goal.
-- It describes what is available, never permission to use or spend any of it:
-- that stays the commercial authority's. Null means nobody has said.
ALTER TABLE workstreams ADD COLUMN target_resources TEXT;
