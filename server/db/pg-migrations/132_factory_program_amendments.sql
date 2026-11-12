-- ---------------------------------------------------------------------------
-- FACTORY PROGRAM AMENDMENTS: A SPECIFICATION THAT GROWS BY RELEASES (§97)
--
-- A program's source is never edited (§96). An owner who keeps adding to an
-- architecture adds a numbered release: its text is appended, verbatim, after
-- every earlier release, so every item the program already mapped keeps its
-- id, its offsets and its meaning, and only the new text needs mapping. Started
-- campaigns and verified requirements are kept; nothing completed is redone.
--
-- Append-only: no code path updates or deletes a row.
-- ---------------------------------------------------------------------------
CREATE TABLE factory_program_amendments (
  program_id    TEXT NOT NULL REFERENCES factory_programs(id),
  number        INTEGER NOT NULL,
  title         TEXT NOT NULL,
  source_text   TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  actor_type    TEXT NOT NULL,
  actor_id      TEXT,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (program_id, number),
  CHECK (number >= 1),
  CHECK (actor_type IN ('PERSON', 'FACTORY'))
);

CREATE UNIQUE INDEX idx_factory_program_amendments_sha ON factory_program_amendments (program_id, source_sha256);
