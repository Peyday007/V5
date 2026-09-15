-- ---------------------------------------------------------------------------
-- ONE SHARED BRAIN, WITHOUT A SECOND KNOWLEDGE SYSTEM
--
-- Four people run four private operations in one Brain. A market fact one of
-- them paid to establish is a fact about the world, and the second person
-- paying to establish it again is the waste §13 already refuses inside a single
-- project, arriving one boundary out.
--
-- What makes that reusable is already written down. `research_claims` holds the
-- statement, the canonical source, the publisher, the date, the passage, the
-- locator, the scope fields and the contradiction state; it resolves through
-- `research_fragments` to the gate that accepted it, through
-- `research_orchestrations` to the project that produced it, and through
-- `research_passes` to the worker and session that executed it. Nothing about a
-- finding needs to be re-stated to be reused.
--
-- So this table stores NO KNOWLEDGE. It is a promotion record: a pointer to the
-- claim, the origin it came from, and the two pieces of state a claim row
-- cannot carry — whether a person has revoked it, and how long it was declared
-- good for. `knows.ts` already gives the reason for the shape: a copy is a
-- second place for the truth to live and the one nobody reconciles, and a copy
-- is precisely what loses a claim's evidence chain.
--
-- Everything else is derived live at read time. A claim that becomes contested,
-- loses its acceptance, or whose fragment leaves ACCEPTED, stops being eligible
-- with nothing written anywhere. That is the whole reason not to snapshot.
-- ---------------------------------------------------------------------------
CREATE TABLE shared_findings (
  id                      TEXT PRIMARY KEY,

  -- The claim itself. One promotion per claim, enforced below, so the
  -- derivation pass is idempotent by the thing it is about rather than by a
  -- flag some tick could set and then die.
  claim_id                TEXT NOT NULL REFERENCES research_claims(id) ON DELETE CASCADE,

  -- Provenance. Recorded in full, always. What a given reader is *shown* is
  -- decided at the projection against their own access, never by leaving a
  -- column empty.
  origin_project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  origin_orchestration_id TEXT NOT NULL REFERENCES research_orchestrations(id) ON DELETE CASCADE,
  origin_fragment_id      TEXT REFERENCES research_fragments(id) ON DELETE SET NULL,
  origin_layer_id         TEXT REFERENCES layers(id) ON DELETE SET NULL,
  -- From the pass Brain wrote, never from anything a worker said about itself.
  -- NULL means the pass recorded none, and is reported as "not recorded" rather
  -- than guessed. Provenance only: nothing in audit independence reads these,
  -- so a null here can never be read as a separation that was achieved.
  origin_worker_id        TEXT,
  origin_session_ref      TEXT,

  -- Which rule admitted it. "Brain shared this" is auditable only if you can
  -- tell which conditions were applied, and a later rule is a code change
  -- somebody reviews rather than a row somebody edits.
  rule_version            TEXT NOT NULL,

  -- ACTIVE | REVOKED. Revoking destroys nothing: the row keeps its id, its
  -- origin and the reason it was withdrawn.
  state                   TEXT NOT NULL DEFAULT 'ACTIVE',
  -- An absolute horizon a person set. NULL means none was recorded, which is
  -- not the same fact as "good forever" and is never rendered as one.
  -- Staleness *relative to a question* is already decided by the coverage
  -- classifier's own timeframe verdict and is deliberately not duplicated here.
  valid_until             TEXT,

  revoked_at              TEXT,
  revoked_by_user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  revoked_reason          TEXT,

  promoted_at             TEXT NOT NULL,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,

  CHECK (state IN ('ACTIVE','REVOKED')),
  -- A revocation with no author and no reason answers nothing later.
  CHECK (state <> 'REVOKED' OR (revoked_at IS NOT NULL AND revoked_reason IS NOT NULL))
);

-- One promotion per claim. This is what makes the derivation safe to run on
-- every tick, from two instances, after a restart, for ever.
CREATE UNIQUE INDEX idx_shared_findings_claim ON shared_findings (claim_id);
CREATE INDEX idx_shared_findings_state ON shared_findings (state, origin_project_id);
CREATE INDEX idx_shared_findings_origin ON shared_findings (origin_project_id, promoted_at);
