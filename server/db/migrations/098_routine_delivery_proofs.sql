-- What a Routine has been shown to be able to deliver, per repository.
--
-- `fleet_routines.capabilities` is what an operator declared. A declaration is
-- intent, and production proved how far intent can be from capability: a
-- surface declaring `repository-write` fired, authenticated, planned,
-- implemented, typechecked and passed review — and then could not push,
-- because the Claude session its Routine starts was attached to a different
-- repository and the git proxy would not inject a credential for this one.
--
-- A row here is a delivery probe: one pinned bin, answerable only by the
-- session Brain fired at this Routine, whose worker creates a disposable
-- branch on the target repository, pushes one harmless commit, opens a pull
-- request, closes it without merging and deletes the branch. PROVEN is written
-- only after Brain has read the forge and found the pull request at the
-- reported commit, touching nothing but the probe's own file, and closed
-- unmerged. FAILED carries the worker's closed-vocabulary reason, so the
-- missing step is named rather than inferred.
--
-- A probe is the fallback, not the rule. Most rows are `REAL_WORK`: a real
-- Factory session Brain fired at this Routine pushed a branch the forge then
-- confirmed (PROVEN), or reported that the git proxy refused this repository
-- (FAILED). Real work is the evidence; a probe is only for a surface with no
-- real work to prove itself on. A Routine with no row at all is provisional,
-- not refused.
--
-- CLEARED is a person saying the cause of a FAILED reading was fixed: it proves
-- nothing, and puts the pair back to provisional so real work can prove it.
--
-- Append-only. The newest settled row for (routine, repository) is the
-- reading; an older PROVEN never outlives a newer FAILED.
CREATE TABLE routine_delivery_proofs (
  id TEXT PRIMARY KEY,
  routine_id TEXT NOT NULL REFERENCES fleet_routines(id) ON DELETE CASCADE,
  repository TEXT NOT NULL,
  bin_id TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL DEFAULT 'PROBE' CHECK (source IN ('PROBE', 'REAL_WORK')),
  state TEXT NOT NULL CHECK (state IN ('PENDING', 'PROVEN', 'FAILED', 'CLEARED')),
  branch TEXT NOT NULL,
  probe_path TEXT NOT NULL,
  head_sha TEXT,
  pull_request INTEGER,
  failure_step TEXT,
  detail TEXT,
  requested_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  settled_at TEXT
);
CREATE INDEX idx_routine_delivery_proofs_latest
  ON routine_delivery_proofs (routine_id, repository, created_at);
