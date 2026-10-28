-- ---------------------------------------------------------------------------
-- HOW A GOAL'S MONEY MAY BE SPENT OVER TIME
-- ---------------------------------------------------------------------------
--
-- A goal's owner may say more than "at most this much". Two more figures, both
-- theirs and both optional:
--
--   * how much may be tied up before any money has come in — the test stage,
--     so a plan proves itself before the rest is spent;
--   * how much may be newly tied up in any seven days — so the total is spread
--     over the goal's life rather than spent at once.
--
-- Both are limits on spending the owner already allowed, checked at the moment
-- work would begin. Neither is permission to spend: that stays the commercial
-- authority's. Null means the owner has not set that limit.
ALTER TABLE workstreams ADD COLUMN target_capital_before_proof_cents INTEGER;
ALTER TABLE workstreams ADD COLUMN target_capital_per_week_cents INTEGER;
