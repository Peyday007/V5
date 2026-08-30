-- Recording an unresolved research gap is an authorization, not a default.
--
-- When a fragment exhausts its evidence paths the packet can either stop for a
-- person or record the gap and file what the evidence supports. The second is a
-- narrowing of the goal, so it is a decision somebody makes about one packet —
-- never something the runner does on its own because it is stuck. Without this
-- column a Brain could always declare its way to "complete", which is the exact
-- failure invariant 20 exists to prevent.
--
-- NULL means not authorized, which is every packet that exists today and every
-- packet created from now on unless somebody says otherwise.
ALTER TABLE research_orchestrations ADD COLUMN unresolved_gap_policy TEXT;
ALTER TABLE research_orchestrations ADD COLUMN unresolved_gap_authorized_by TEXT;
ALTER TABLE research_orchestrations ADD COLUMN unresolved_gap_authorized_at TEXT;
