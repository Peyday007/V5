-- ---------------------------------------------------------------------------
-- VARIABLE EXPLORATION (§102)
--
-- Each exploration a plan read runs now starts with a sweep of the plan's
-- variables: tens to hundreds of thousands of combinations read by ordinary
-- code, the strongest handed to the engine as directions. The exploration row
-- records how many distinct variations were read, over how many variables and
-- conditions, and a compact summary of what the sweep concluded (strongest
-- supported and mathematical-only strategies, what each condition would need).
-- ---------------------------------------------------------------------------

ALTER TABLE reasoning_explorations ADD COLUMN variations INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reasoning_explorations ADD COLUMN variables INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reasoning_explorations ADD COLUMN sweep TEXT;
