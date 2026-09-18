-- Where each answer on a card came from, and what kind of answer it is.
-- ---------------------------------------------------------------------------
--
-- Two things this closes, and they pull in opposite directions until you have
-- somewhere to write both down.
--
-- **Research reached nothing.** `startDependentWork` captured an idea for every
-- discoverable blank and wrote its id onto the need — and the only reader of
-- that column hid the need from the review for ever. Nothing consumed the
-- answer, so a card whose payer had been established sat blank, and the need
-- that asked for it was invisible whether the research had completed, failed or
-- never started. A column with one reader that only ever hides something is not
-- a connection.
--
-- **And Brain was forbidden from forming a commercial view at all.** The rule
-- said the offer, the price, the acceptance condition and who fulfils it are
-- permanently the owner's, on the reasoning that a researched answer to "what
-- should we charge" is invented judgment wearing a citation. That is true of a
-- *citation* and false as a prohibition: the product is an operator with high
-- autonomy inside limits a person set, and reserving every commercial judgment
-- to a human makes it a form somebody fills in.
--
-- Both are answered by making the *kind* of answer a column:
--
--   EVIDENCE       a published source said it, and `claim_id` is which one.
--   RECOMMENDATION Brain proposes it, from `basis` and `assumptions`, with
--                  `uncertainty` saying what would change it. Never a fact.
--   PERSON         somebody decided it, and it is never re-proposed over.
--
-- The distinction has to be in the row rather than in the presentation, because
-- a card that renders a recommendation the same way it renders a source is a
-- card that has told somebody a guess was checked.
CREATE TABLE IF NOT EXISTS cash_card_facts (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  opportunity_id  TEXT NOT NULL,

  -- The `evidenceCard` field key this answers. One answer per field: a second
  -- one is a correction, and it replaces this row rather than accumulating,
  -- because two live answers to "who pays" is a card that argues with itself.
  field           TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('EVIDENCE', 'RECOMMENDATION', 'PERSON')),

  -- What the card now says. Stored beside the opportunity's own column rather
  -- than instead of it: the column is what every existing reader uses, and this
  -- is what says where it came from.
  value           TEXT NOT NULL,

  -- EVIDENCE only. The research claim, which resolves to a source URL, a
  -- publisher and a date — so a card field resolves to a passage exactly as a
  -- report's sentence does.
  claim_id        TEXT,
  need_id         TEXT,

  -- RECOMMENDATION only, and all three are required of one: what it rests on,
  -- what was assumed to get there, and what would change it. A recommendation
  -- with no stated uncertainty is a recommendation pretending to be a reading.
  basis           TEXT,
  assumptions     TEXT,
  uncertainty     TEXT,

  decided_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_card_facts_field
  ON cash_card_facts(opportunity_id, field);

CREATE INDEX IF NOT EXISTS idx_cash_card_facts_project
  ON cash_card_facts(project_id, kind);
