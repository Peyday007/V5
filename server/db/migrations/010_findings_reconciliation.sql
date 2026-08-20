-- ---------------------------------------------------------------------------
-- NEW EVIDENCE AGAINST OLD, AND THE PLAN FOR WHAT FAILED
--
-- A finding is not simply "more evidence". It either confirms what the archive
-- already had, strengthens it, updates something stale, fills a real gap,
-- narrows an existing claim, contradicts one, duplicates one, fails to support
-- the requirement it was researched for, or raises a question nobody had asked.
-- Those lead to different actions, so the classification is recorded rather
-- than collapsed into "accepted".
--
-- The one thing new evidence may never do is silently overwrite old evidence.
-- Both claims keep their rows; what changes is what the coverage says about the
-- requirement, and why.
-- ---------------------------------------------------------------------------

-- How two claims disagree, when they do. Most disagreements are not conflicts:
-- a different definition, timeframe, geography or population explains them
-- completely, and averaging them would be inventing a number nobody measured.
ALTER TABLE research_claims ADD COLUMN contradiction_kind TEXT;
ALTER TABLE research_claims ADD COLUMN reconciliation_detail TEXT;

-- The structured plan behind a repair attempt: what failed, which ecosystems
-- were already tried, what to try instead, and how much budget is left. Kept so
-- a repair can be shown to a person and so the next one cannot repeat it.
ALTER TABLE research_fragments ADD COLUMN repair_plan TEXT;

-- Queued work that accepted evidence made unnecessary is cancelled, not run.
-- The reason is on the fragment's blocked_reason; this records that it was the
-- planner rather than a failure that stopped it.
ALTER TABLE research_fragments ADD COLUMN cancelled_reason TEXT;
