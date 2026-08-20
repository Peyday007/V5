-- ---------------------------------------------------------------------------
-- REVIEW BEFORE EXECUTION
--
-- Research costs the user's allowance and their afternoon, and the most
-- expensive mistake is not a bad search — it is researching the wrong question
-- carefully. So before any of it runs, Brain shows what it understood the goal
-- to be, what the archive already answers, what it believes the real gaps are,
-- and exactly which jobs it proposes to run.
--
-- Approval is recorded rather than assumed: who let it run, when, and with what
-- note. Automatic execution is a choice the user makes here too, and choosing
-- it does not make the reasoning invisible — the same review is stored either
-- way, because a plan nobody can inspect afterwards is not a plan.
-- ---------------------------------------------------------------------------
ALTER TABLE research_orchestrations ADD COLUMN auto_approve INTEGER NOT NULL DEFAULT 1;
ALTER TABLE research_orchestrations ADD COLUMN approved_at TEXT;
ALTER TABLE research_orchestrations ADD COLUMN approval_note TEXT;
