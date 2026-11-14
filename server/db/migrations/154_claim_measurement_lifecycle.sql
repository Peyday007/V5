-- How a claim was measured, and how long it holds (lens W, W-11 and W-12).
--
-- A claim carried its source, its dates and its scope, but not how the figure
-- was measured, on how many cases, what its source says limits it, until when
-- it holds, or what would make it wrong. Those lived only on quant Figures, so
-- a researched rate reached the pooler unsized and with a constant window.
-- All optional: a worker that declares none of them is not refused.
--
-- `invalidation_met_at` / `invalidation_note` record that the claim's declared
-- `invalidated_by` condition has since been met. The claim is never edited or
-- deleted; the pooler excludes it with that reason and its history stays.
ALTER TABLE research_claims ADD COLUMN measurement_method TEXT;
ALTER TABLE research_claims ADD COLUMN sample_size INTEGER;
ALTER TABLE research_claims ADD COLUMN limitations TEXT;
ALTER TABLE research_claims ADD COLUMN valid_until TEXT;
ALTER TABLE research_claims ADD COLUMN invalidated_by TEXT;
ALTER TABLE research_claims ADD COLUMN invalidation_met_at TEXT;
ALTER TABLE research_claims ADD COLUMN invalidation_note TEXT;
