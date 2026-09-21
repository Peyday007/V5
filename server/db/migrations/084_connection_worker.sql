-- Whose worker a Claude connection is, as a row rather than as a derived name.
--
-- ---------------------------------------------------------------------------
-- The split brain this closes
-- ---------------------------------------------------------------------------
--
-- `connectionView` resolved a member's worker with
-- `getWorkerByName(namesFor(user).workerName)` — a name composed from their
-- display name and a slice of their user id. That is fine for a connection this
-- Brain minted, because `issueConnectorInvitation` minted the worker under
-- exactly that name. It is wrong for every surface registered before the
-- feature existed, and production is full of them: `Brain Research A` has fired
-- **350 times** against worker `wkr_1cdd82cfb2a54faf8edd`, and the owner's
-- connection view looked for `research-<their-name>-<id>`, found nothing, read
-- no tokens, and told them their Claude account was not connected.
--
-- Both halves were true readings of two different questions. *Has this member
-- completed the connection journey* is what the row answered; *is this member's
-- Claude account driving this Brain* is what the screen claimed to answer. A
-- name is not a binding, and deriving one produced a confident wrong answer —
-- which §25 already records as the worst kind.
--
-- `worker_id` is the binding. It is written when Brain mints the worker, and by
-- `adoptSurface` when a person says an existing registered surface is theirs.
-- Null means *we have not been told*, and the name lookup stays as the fallback
-- for rows written before this column, so nothing that works today stops
-- working.
--
-- It authorizes nothing. No policy, router, admission hook or audit reads it;
-- `services/identity/policy.ts` still decides what a worker may do, the fire
-- router still reads `fleet_routines`, and the independence floor still reads
-- recorded lineage. This is which surface a *screen* is describing.

ALTER TABLE capacity_connections ADD COLUMN worker_id TEXT;

-- What was already derivable, written down once so the derivation stops being
-- load-bearing. Only where exactly one worker carries that name, and only where
-- the connection has no worker recorded: a guarded backfill can never replace a
-- value somebody set.
UPDATE capacity_connections
   SET worker_id = (
     SELECT r.worker_id FROM fleet_routines r
      WHERE r.id = capacity_connections.routine_id
        AND r.worker_id IS NOT NULL
   )
 WHERE worker_id IS NULL
   AND routine_id IS NOT NULL;

CREATE INDEX idx_capacity_connections_worker ON capacity_connections (worker_id);
