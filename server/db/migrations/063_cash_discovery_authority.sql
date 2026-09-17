-- One canonical internal discovery authorization per Cash project, enforced by
-- the database rather than by whichever tick got there first.
--
-- Pressing Start Cash Mode *is* the authorization for zero-spend internal
-- discovery: read published sources, research and validate openings, store
-- evidence, compare, calculate from accepted evidence, and prepare recommended
-- plans. It authorizes no contact, no purchase, no spending, no commitment, no
-- publication and no external operation — those are the commercial grant's,
-- which is a separate decision and is untouched by this.
--
-- The production audit found the shape this exists to make impossible: a sprint
-- was activated, ten buckets opened, ten candidates captured, and every one of
-- them parked on `no standing authority exists for this project`. Nothing was
-- wrong with the research engine. There was simply nothing a launch could run
-- under, and the sentence saying so lived in a JSON column no surface read.
--
-- A partial unique index rather than an application check, for the reason every
-- other claim in this codebase is a compare-and-swap: two ticks can both read
-- "there is no authority here" and both insert. The index decides, the loser
-- reads back the winner's row, and neither has to coordinate with the other.
-- It is scoped to the canonical name so it constrains exactly this grant and
-- says nothing about the commercial or bespoke grants beside it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_russell_goals_one_live_cash_discovery
  ON russell_goals (project_id)
  WHERE state = 'ACTIVE' AND name = 'Cash Mode internal discovery';
