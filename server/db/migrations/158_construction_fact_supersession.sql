-- ---------------------------------------------------------------------------
-- A CLAIM'S FACT IS SUPERSEDED BY A NEW ROW, NEVER REWRITTEN (§5, invariant 17)
-- ---------------------------------------------------------------------------
--
-- A claim-derived fact was unique by its claim, so when the rule that reads a
-- figure out of a claim changed (`dealLevelFigures`, B1f: "$0.47 per postcard
-- piece ... total $4,675" is a $4,675 deal, not a $0.47 one) the fact filed
-- under the old rule could neither be corrected nor replaced: production kept
-- $0.47 and the arrangement it priced was worth 0 cents.
--
-- `supersedes_fact_id` is set on the NEW row and names the fact it replaces.
-- The old row is never written: it stays as history, and readers resolve the
-- current fact at read time (a fact some other row supersedes is not current).
-- A claim still has exactly one original fact, and a fact is superseded at
-- most once, so a replay of the re-derivation writes nothing.
-- ---------------------------------------------------------------------------

ALTER TABLE construction_facts ADD COLUMN supersedes_fact_id TEXT;

DROP INDEX idx_construction_facts_claim;
CREATE UNIQUE INDEX idx_construction_facts_claim ON construction_facts (source_claim_id) WHERE source_claim_id IS NOT NULL AND supersedes_fact_id IS NULL;
CREATE UNIQUE INDEX idx_construction_facts_supersedes ON construction_facts (supersedes_fact_id) WHERE supersedes_fact_id IS NOT NULL;
