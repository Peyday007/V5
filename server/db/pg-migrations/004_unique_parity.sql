-- ---------------------------------------------------------------------------
-- THE THREE CONSTRAINTS THE CLOUD SCHEMA WAS MISSING
--
-- Found by inspection at the start of Step 4, and measured rather than assumed:
-- against a database built from 001_baseline.sql, `projects`, `layers` and
-- `documents` carried a primary key and nothing else, while the SQLite chain
-- that baseline was generated from declares three more:
--
--     projects   slug                             UNIQUE
--     layers     (project_id, slug)               UNIQUE
--     documents  (project_id, canonical_name)     UNIQUE
--
-- The generator walked columns and foreign keys and never emitted uniqueness,
-- so all three were silently dropped on the way into Postgres. That is a fifth
-- difference between the chains, and an undocumented one, which the project's
-- own rules say must not exist.
--
-- It is not a cosmetic difference. `/files/<slug>/documents/...` resolves a
-- project by slug, and Step 4 makes that resolution an authorization decision:
-- two projects sharing a slug in the cloud database would mean a member of one
-- could be handed the other's documents, because `getProjectBySlug` would
-- return whichever row the planner reached first. The document uniqueness
-- constraint is what stops one canonical name meaning two artifacts in a layer,
-- which is the invariant the naming rules exist to keep.
--
-- Adding a unique index to a table that already holds duplicates fails, loudly,
-- and that is the correct outcome: it means the database contains two things
-- Brain has always treated as one, and a person has to decide which. The
-- migration runner will report the constraint and the duplicate key.
--
-- The generator is fixed in the same change, so a baseline generated from now
-- on carries these inline and no future table inherits the gap.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_projects__slug
  ON projects (slug);
CREATE UNIQUE INDEX IF NOT EXISTS uq_layers__project_id_slug
  ON layers (project_id, slug);
CREATE UNIQUE INDEX IF NOT EXISTS uq_documents__project_id_canonical_name
  ON documents (project_id, canonical_name);
