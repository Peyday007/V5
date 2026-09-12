-- Step 12B — the Discovery Frontier.
--
-- Every project has edges: things it understands well, things it believes on
-- thin evidence, questions it knows it has not answered, regions nobody has
-- looked at, and paths Brain found for itself. §11 asks for those five to be a
-- *living* reading rather than a report somebody runs.
--
-- Three decisions are worth recording here rather than in the service.
--
-- **A frontier item is derived, and the row exists so it can be remembered.**
-- Every item names the row it came from — a conclusion, a layer, an audit gap,
-- a contradiction, a candidate — and Brain re-derives them on every pass. The
-- table is not a second store of what the project knows; it is what makes
-- "this was on the frontier in July and is not now" answerable, and what gives
-- a person somewhere to say "this area is deliberately not required".
--
-- **An unexamined area must not be able to disappear quietly.** An item that
-- stops being derived is *resolved*, with the time, rather than deleted. §11's
-- own words: preserve explicit unknowns so no important area becomes a silent
-- dark spot. A delete would make a dark spot look like progress.
--
-- **The fingerprint is the identity.** `source_id` is legitimately null for an
-- item derived from an absence — a declared region with no work in it has no
-- row to point at — and a unique index over a nullable column behaves
-- differently in the two dialects. So identity is a deterministic hash the
-- service computes, and the index is over two non-null columns.

CREATE TABLE russell_frontier (
  id                   TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- SOLID_GROUND | WEAK_GROUND | OPEN_QUESTION | UNEXAMINED | NEW_PATH
  region               TEXT NOT NULL,

  -- What it is about, in the words of the row it came from. Never composed.
  subject              TEXT NOT NULL,
  detail               TEXT,

  -- Which authoritative row this reading came from, so a person can walk back
  -- to it rather than trusting this summary of it.
  source_kind          TEXT NOT NULL,
  source_id            TEXT,

  -- Which of §11's lenses produced it, when one did. Null for the regions that
  -- are read directly from state rather than asked for.
  lens                 TEXT,

  -- A deterministic identity over region + source + subject.
  fingerprint          TEXT NOT NULL,

  -- Visibility follows the row it was derived from: a frontier item over a
  -- private conclusion is private.
  visibility           TEXT NOT NULL DEFAULT 'SHARED',

  -- A person saying an area is deliberately not required. Attributed, with a
  -- reason, and never inferred from silence.
  dismissed_at         TEXT,
  dismissed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  dismissed_reason     TEXT,

  -- When it stopped being derived. Resolved, not deleted.
  resolved_at          TEXT,

  version              INTEGER NOT NULL DEFAULT 1,
  first_seen_at        TEXT NOT NULL,
  last_seen_at         TEXT NOT NULL,

  CHECK (region IN ('SOLID_GROUND','WEAK_GROUND','OPEN_QUESTION','UNEXAMINED','NEW_PATH')),
  CHECK (source_kind IN ('KNOWLEDGE','LAYER','AUDIT_GAP','CANDIDATE','CONTRADICTION','ABSENCE')),
  CHECK (visibility IN ('PRIVATE','SHARED'))
);

CREATE UNIQUE INDEX idx_russell_frontier_identity
  ON russell_frontier (project_id, fingerprint);

CREATE INDEX idx_russell_frontier_region
  ON russell_frontier (project_id, region, resolved_at);
