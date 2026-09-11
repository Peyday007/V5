-- The factory's execution plane: a campaign's work reaches a permanent worker.
--
-- Until now a factory unit was executed by a process on the same machine as the
-- Brain, holding the same checkout. That is why the deployed Brain could only
-- refuse an objective: no `.git` in the image, so no commit to pin and nowhere
-- for a worker to stand. The way out is the machinery Step 10 already built for
-- research — a bin, a manifest a worker executes, a completion contract Brain
-- judges — pointed at a repository instead of at a question.
--
-- Two columns, both additive.
--
-- `bins.factory_campaign_id` is the lineage a bin needs to be answerable *for* a
-- campaign. `orchestration_id` already exists and means a research packet; a
-- second meaning on one column would make every query about either of them
-- ambiguous, and the one nobody reads is the one that drifts.
--
-- `factory_campaigns.execution_mode` records how a campaign is actually being
-- run, rather than leaving it to be inferred from whether a checkout happened to
-- exist. A campaign that says REMOTE and a campaign that says LOCAL are verified
-- differently — one against a worker's pushed branch as the forge reports it, the
-- other against a local merge — and a report that could not say which was being
-- done would be describing two different things with one word.
ALTER TABLE bins ADD COLUMN factory_campaign_id TEXT;
CREATE INDEX idx_bins_factory_campaign ON bins (factory_campaign_id, state);

ALTER TABLE factory_campaigns ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'LOCAL';
