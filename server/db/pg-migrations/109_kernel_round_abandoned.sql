-- A kernel round whose mission failed is ABANDONED, not OPEN for ever (RES-2).
--
-- `deal_rounds` and `puzzle_rounds` declared only OPEN and SETTLED, so a round
-- whose mission FAILED or was CANCELLED had nowhere to go and held its slot
-- for ever. This widens each state CHECK by one value; SQLite 118 is the same
-- change, by rebuild.
--
-- The constraint names are Postgres's own defaults for the unnamed CHECKs in
-- 074 and 080, read from a cluster built from those files rather than assumed:
-- a single-column CHECK is `<table>_<column>_check`, and multi-column ones are
-- `<table>_check`, `<table>_check1`, … in declaration order. Written without
-- IF EXISTS on purpose: a wrong name fails the migration with the name in the
-- message, instead of leaving the old constraint beside the new one.

ALTER TABLE deal_rounds DROP CONSTRAINT deal_rounds_state_check;
ALTER TABLE deal_rounds ADD CONSTRAINT deal_rounds_state_check
  CHECK (state IN ('OPEN', 'SETTLED', 'ABANDONED'));

ALTER TABLE puzzle_rounds DROP CONSTRAINT puzzle_rounds_state_check;
ALTER TABLE puzzle_rounds ADD CONSTRAINT puzzle_rounds_state_check
  CHECK (state IN ('OPEN', 'SETTLED', 'ABANDONED'));

-- (state = 'SETTLED') = (settled_at IS NOT NULL), and the same for found.
ALTER TABLE puzzle_rounds DROP CONSTRAINT puzzle_rounds_check;
ALTER TABLE puzzle_rounds DROP CONSTRAINT puzzle_rounds_check1;
ALTER TABLE puzzle_rounds ADD CONSTRAINT puzzle_rounds_closed_at_check
  CHECK ((state <> 'OPEN') = (settled_at IS NOT NULL));
ALTER TABLE puzzle_rounds ADD CONSTRAINT puzzle_rounds_closed_found_check
  CHECK ((state <> 'OPEN') = (found IS NOT NULL));
