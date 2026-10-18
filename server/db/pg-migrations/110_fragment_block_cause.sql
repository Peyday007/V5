-- ---------------------------------------------------------------------------
-- WHY A FRAGMENT WAS BLOCKED, STORED IN THE STATEMENT THAT BLOCKS IT
-- ---------------------------------------------------------------------------
--
-- `classifyBlock` (services/research/gate.ts) has always been able to say why a
-- fragment ended BLOCKED, and nothing stored the answer: every report re-derived
-- it from `blocked_reason` and `verdict_detail`, a repair could not be chosen by
-- cause, and a fragment stopped by one unreachable host could not be found when
-- that host later answered.
--
-- `block_cause` is the classifier's answer, written by `updateFragment` in the
-- same UPDATE that sets status BLOCKED, and cleared in the statement that moves
-- a fragment out of BLOCKED. `block_host` is set only when the cause is
-- SOURCE_ACCESS or SOURCES_UNREADABLE and one host accounts for most of what
-- could not be read. NULL on rows written before this column existed; readers
-- classify those exactly as before.
--
-- `archive_marker` is the content marker of the archive a fragment's search was
-- launched against (services/russell/coverage.ts `archiveMarkerFor`), so an
-- identical question asked again against an archive that has not changed can be
-- recognised as the same search rather than run twice.
--
-- `idx_research_claims_created` bounds the host-reachability reading to a
-- window instead of a full scan of the claims table on every assignment.
-- ---------------------------------------------------------------------------

ALTER TABLE research_fragments ADD COLUMN block_cause TEXT;
ALTER TABLE research_fragments ADD COLUMN block_host TEXT;
ALTER TABLE research_fragments ADD COLUMN archive_marker TEXT;

CREATE INDEX idx_fragments_block_host ON research_fragments (block_host, status);
CREATE INDEX idx_fragments_archive_marker ON research_fragments (project_id, archive_marker);
CREATE INDEX idx_research_claims_created ON research_claims (created_at);
