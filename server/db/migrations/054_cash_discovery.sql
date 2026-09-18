-- Where an opportunity came from, so discovery can populate the portfolio
-- without ever doing it twice.
--
-- Activating a sprint created a mode and an event and nothing else: no goal, no
-- candidate, no mission, no queued job. `capture` had exactly two production
-- callers — a person pressing a button, and the reoffer service — so a freshly
-- activated sprint could sit empty indefinitely beside a healthy research
-- fleet, while the screen said discovery had started.
--
-- `services/cash/discovery.ts` closes that in two halves, and this column is
-- what makes the second half safe to run on every tick. A finished discovery
-- mission's accepted claims in the `demand_signal` lane become opportunities,
-- one per claim, and the unique index below is what makes "one per claim" a
-- property of the database rather than of the loop running exactly once.
--
-- Keyed by project as well as claim, for the reason `053` scoped the
-- idempotency keys: a claim id is a server-generated fact, but a uniqueness
-- rule that spanned projects would be one more place where two accounts share
-- a namespace they did not agree to share.
ALTER TABLE cash_opportunities ADD COLUMN source_claim_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_opportunities_claim
  ON cash_opportunities(project_id, source_claim_id);

-- Which bucket found it, which is a different fact from which idea it is.
--
-- `candidate_id` means "the Russell idea this opportunity *is*" — what a person
-- captured, or what Brain is researching on this opportunity's behalf. A
-- harvested opportunity did not come from an idea about itself; it came from a
-- broad bucket question that found dozens of unrelated openings. Writing the
-- bucket into `candidate_id` would make those two relationships one column, and
-- the wind-down guard reads exactly that column to tell new discovery from
-- research supporting an existing obligation. It would have read a discovery
-- bucket as support work the moment any one of its openings started executing,
-- and re-opened the bucket during a wind-down that had stopped it.
ALTER TABLE cash_opportunities ADD COLUMN discovered_by_candidate_id TEXT;
