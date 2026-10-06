-- One live bin per research-goal packet, decided by the database.
--
-- The research-goal continuation pass gives a packet it owns the bin that
-- carries it to a worker. Two passes that both find no bin must produce one,
-- and the arbiter is this index rather than a check in a process: the loser's
-- insert is refused and it reads back the winner's bin. Scoped to bins the
-- goal pass writes (`created_by_id` 'research-goal:<id>') and to the states a
-- bin can still be handed out from, so a spent bin keeps its row and never
-- blocks anything.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bins_goal_packet_live
  ON bins (orchestration_id)
  WHERE created_by_id LIKE 'research-goal:%' AND state IN ('DRAFT', 'READY', 'LEASED');
