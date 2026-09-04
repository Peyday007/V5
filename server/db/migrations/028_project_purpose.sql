-- ---------------------------------------------------------------------------
-- WHAT A PROJECT IS FOR
--
-- Not every project row is somebody's work. The hosted verifier owns one
-- ('verification-scope'), the fault harness owns others, and Step 5's queue
-- proof needs a scope to run its synthetic echoes in. Those are the machinery
-- proving itself, and they are as real as any other row — which is the problem.
-- Counted alongside ordinary work they inflate every total a person reads:
-- how many sites exist, how much is in flight, how far along anything is.
--
-- Migration 021 already settled the shape of the answer for one case, and the
-- reasoning transfers exactly. A slug prefix or a title match would put the
-- classification in whichever query happened to remember it, and a scope
-- renamed once would silently rejoin the ordinary counts. So it is a column:
-- every query that asks "is this somebody's work" gets an answer, and a
-- technical scope cannot become part of the product by being forgotten about.
--
-- The default is PROJECT, because a project somebody created through the
-- ordinary path is ordinary work, and a classification that defaulted the
-- other way would hide real work behind a flag nobody set.
-- ---------------------------------------------------------------------------
ALTER TABLE projects ADD COLUMN purpose TEXT NOT NULL DEFAULT 'PROJECT'
  CHECK (purpose IN ('PROJECT', 'TECHNICAL'));

-- The scopes that exist today and are known to be machinery. Named exactly,
-- because a LIKE here would be the naming convention this column replaces.
UPDATE projects SET purpose = 'TECHNICAL'
 WHERE slug IN ('verification-scope', 'verification-holdout', 'fault-scope', 'queue-scope');

CREATE INDEX idx_projects_purpose ON projects (purpose, status);
