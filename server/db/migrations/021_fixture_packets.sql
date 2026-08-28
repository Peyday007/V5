-- ---------------------------------------------------------------------------
-- FIXTURE PACKETS
--
-- A packet whose research content was written into this repository rather than
-- found by anybody. It exists so the machinery can be exercised end to end —
-- the plan, the approval gate, all seven evidence conditions, acceptance and
-- rejection, dependency ordering, the synthesis, citation resolution, the
-- filed artifact and its ledger — without spending an account's allowance on
-- research nobody has decided to trust yet.
--
-- One column, and the reason it is a column rather than a naming convention is
-- the whole point of it.
--
-- `services/routes/research.ts` already refuses to run staged research against
-- a provider that returns placeholder content, because "a report with invented
-- citations" is the worst thing this platform could produce. A fixture packet
-- is not that — nothing invents anything, the claims are written down and
-- checkable — but it is adjacent enough that the difference has to be a fact
-- about the row rather than something a reader is trusted to infer.
--
-- So: every query that asks "is this real research" gets an answer, the UI can
-- label it, and a fixture cannot become evidence for anything by being
-- forgotten about. A slug or a title prefix would have been none of those.
-- ---------------------------------------------------------------------------
ALTER TABLE research_orchestrations ADD COLUMN fixture INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_orchestrations_fixture ON research_orchestrations (fixture, project_id);
