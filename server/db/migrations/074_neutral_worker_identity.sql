-- A human name is not an identity.
--
-- `workers.name` is an operator handle: canonical, unique, and typed by whoever
-- created the row. It was also what `Principal.handle` carried, so
-- `brain_whoami` answered a Routine's check-in with somebody's first name, and
-- every reader downstream — an operator, a report, a person reading a session
-- transcript — took that to be a statement about whose Claude account had run
-- the session. It never was. The chain that decides a principal is
-- credential -> `oauth_tokens.worker_id` -> `workers.id`, and no step of it has
-- ever consulted a name.
--
-- So the defect is not that the attribution was wrong. It is that the thing
-- Brain *printed* looked like an attribution and was a label, and a label that
-- reads like a claim is worse than no label at all.
--
-- `label` is the neutral operational identity: server-assigned, stable, opaque
-- about people, and the only worker identifier any surface prints. `name` stays
-- exactly as it is, because §5 does not destroy history and because two modules
-- resolve site and reader workers by it — but it is a lookup handle now and
-- participates in nothing.
--
-- `owner_user_id` is the honest version of what the old name was pretending to
-- be. It is nullable, it is filled only from evidence Brain actually holds —
-- the approver recorded on an `oauth_authorization_codes` row, or a
-- `capacity_connections` row a person completed themselves — and
-- `owner_evidence` says which. Where Brain cannot prove it, it stays null, and
-- null means *we do not know* rather than *nobody*.

ALTER TABLE workers ADD COLUMN label TEXT;
ALTER TABLE workers ADD COLUMN owner_user_id TEXT;
ALTER TABLE workers ADD COLUMN owner_evidence TEXT;

-- Deterministic, by creation order, so the same database always produces the
-- same labels and a reader can reason about which worker is which.
UPDATE workers
   SET label = 'worker-' || printf('%02d', (
         SELECT COUNT(*) FROM workers AS earlier
          WHERE earlier.created_at < workers.created_at
             OR (earlier.created_at = workers.created_at AND earlier.id <= workers.id)
       ));

CREATE UNIQUE INDEX idx_workers_label ON workers (label);
