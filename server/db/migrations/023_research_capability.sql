-- Restoring research capability the pull path had lost, without loosening a
-- single truthfulness control.
--
-- Two columns. Everything else in this change is behaviour over existing rows.
--
-- `retrieval_state` is the one that matters most. A source that is paywalled,
-- robots-disallowed, a JavaScript shell or simply unreachable is not a claim
-- the researcher got wrong — it is a claim they could not check. Scoring those
-- as rejections drove the fragment rejection rate over the line that fails a
-- whole fragment for bad sourcing practice, so a run that hit four paywalls
-- looked identical to a run that invented four citations. They are opposites.
--
-- Defaulted to RETRIEVED so every existing claim keeps exactly the meaning it
-- had: it was retrieved, and the gate's verdict on it stands.
ALTER TABLE research_claims ADD COLUMN retrieval_state TEXT NOT NULL DEFAULT 'RETRIEVED';

-- Set when a fragment is waiting on a repair the runner has planned but not yet
-- minted, so `AWAITING_REPAIR` can be proved rather than asserted: a packet in
-- that state must have claimable repair work or a time this row names. Without
-- one of the two it is not awaiting anything and belongs to a person.
ALTER TABLE research_fragments ADD COLUMN next_retry_at TEXT;

-- `depends_on` is not altered. It is TEXT holding JSON, and the value shape
-- widens from `["key"]` to `[{"key":"…","kind":"HARD|CONDITIONAL|SEQUENCING"}]`.
-- The parser accepts both and reads a bare string as HARD, so every row written
-- before this migration keeps the blocking behaviour it was written with. A
-- backfill would have rewritten history to say something the planner never
-- decided.

-- Which fragments may be researched in one session: same scope, same source
-- ecosystem, no dependency between them. `bundling.ts` already worked this out
-- and only the in-process path could see it, so a pulling worker had no way to
-- know that three of the items in front of it belonged together.
--
-- A name on the item rather than one item per bundle. Bundling several
-- fragments into a single work item would put them under one Step 6
-- idempotency scope, and a redelivery could then record one fragment's ledger
-- against another fragment's key — the exact duplication the scope exists to
-- prevent. One item per fragment, one key per effect, and a shared name so an
-- activation can claim the set deliberately.
ALTER TABLE work_items ADD COLUMN bundle_key TEXT;
CREATE INDEX IF NOT EXISTS idx_work_items_bundle ON work_items(project_id, orchestration_id, bundle_key);
