-- ---------------------------------------------------------------------------
-- Worker routing scope
--
-- What a worker may be handed, keyed on the worker id the authenticated
-- principal resolves to. Nothing a caller sends contributes to it.
--
-- Why a table rather than a column on `workers`: `workers.worker_type` is
-- documented as the operator's own bookkeeping and is read nowhere, and quietly
-- turning a bookkeeping field into an enforced boundary would make every
-- existing value a security decision nobody made. A row that has to be written
-- on purpose is a row somebody meant.
--
-- An explicit row is **exhaustive** — the families it lists are the only ones
-- that worker may be handed. A worker with no row serves the families its
-- membership scopes already imply and no repository work at all; see
-- `services/bins/routing.ts` for why the default is derived rather than empty.
-- ---------------------------------------------------------------------------
CREATE TABLE worker_routing (
  worker_id    TEXT PRIMARY KEY REFERENCES workers(id) ON DELETE CASCADE,
  -- JSON array of workload families. Exhaustive.
  families     TEXT NOT NULL,
  -- JSON array of repository ids as `owner/name`, lowercase. Never a remote URL
  -- and never a credential.
  repositories TEXT NOT NULL,
  -- JSON array of capability tags. Empty means "not narrowed", not "has none".
  capabilities TEXT NOT NULL,
  -- Why this scope, in the operator's words. An operator action with no reason
  -- recorded answers nothing later.
  reason       TEXT NOT NULL,
  set_by       TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX idx_worker_routing_updated ON worker_routing(updated_at);
