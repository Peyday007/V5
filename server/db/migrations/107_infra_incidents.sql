-- Brain's own infrastructure failures, recorded so they are never read as a
-- worker's. An append-only record of moments when Brain could not answer: a
-- database or pooler timeout felt by authentication or check-in, a session that
-- arrived and could not be served, and the window a process restart left
-- unserved. The no-show pass reads it before charging a surface: a fire whose
-- in-flight window overlaps an incident is DISPATCH_INFRA_NO_SHOW, which neither
-- the quarantine count nor a connector's health reads.
--
-- runtime_liveness is one row per process instance, moved forward by the
-- dispatch tick, so the next boot can say how long the last process had been
-- gone. No foreign keys: an incident row a cascade can delete is not a record.
CREATE TABLE infra_incidents (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  surface      TEXT NOT NULL,
  worker_id    TEXT,
  session_ref  TEXT,
  started_at   TEXT NOT NULL,
  ended_at     TEXT NOT NULL,
  occurrences  INTEGER NOT NULL DEFAULT 1,
  -- 1 when the failure was on the path a session's arrival takes (the control
  -- plane, authentication, token rotation, check-in) or a restart. Only those
  -- excuse a no-show: a research statement timing out on the workload pool does
  -- not stop anybody arriving, so it must not excuse a surface that did not.
  affects_arrival INTEGER NOT NULL DEFAULT 0,
  detail       TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_infra_incidents_window ON infra_incidents (ended_at, started_at);

CREATE TABLE runtime_liveness (
  instance_id  TEXT PRIMARY KEY,
  started_at   TEXT NOT NULL,
  alive_at     TEXT NOT NULL,
  -- This process's own readings at alive_at: both pools, the infrastructure
  -- failures it has felt, and control-plane latency. JSON, no secrets. What the
  -- connection report reads, since an operator script is another process and
  -- cannot see this one's memory.
  readings     TEXT
);

-- auditRoundFor asks, on every audit admission decision inside a check-in,
-- for one project's DOCUMENT_HANDED_OFF / AUDIT_ROUND_REOPENED events. The only
-- index was (project_id, created_at), so the read walked the project's whole
-- history — every event Russell, Cash and the factory ever wrote — to find a
-- handful, and it timed out on production (statement timeout inside
-- brain_check_in). This makes the read cost the number of round events, not
-- the size of the archive.
CREATE INDEX IF NOT EXISTS idx_events_project_type ON project_events (project_id, event_type, created_at);
