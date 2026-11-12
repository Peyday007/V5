-- ---------------------------------------------------------------------------
-- BRAIN IMPROVING ITSELF: ONE REGISTER FROM WEAKNESS TO MEASURED RESULT (§87)
--
-- Owner's order, 2026-11-03: Claude routines devote their capacity to making
-- Brain better at every future job, and research about Brain's methods must
-- become tested engineering, not only prompt guidance. Before this, nothing
-- turned a performance record or an accepted method claim into work: routines
-- answered NO_WORK while the free lane failed most of its fragments.
--
-- `improvement_candidates` is the register. One row per general weakness,
-- keyed by what is weak (never by one job). It stores the intent and the links
-- to the work that carries it — a research goal (Claude routines, in
-- brain-architecture), a Factory change request and campaign — and Brain's
-- decision at the end. The stage in between is derived from those linked rows
-- (§43, invariant 45), never stored.
--
-- `improvement_events` is append-only: what Brain saw, did and measured, so a
-- baseline recorded before a change can be compared with the reading after it.
--
-- `improvement_loop` in `brain_switches` is the owner's standing grant for the
-- loop to submit and approve Brain-repository Factory objectives. ON from this
-- migration with the owner's words as the reason; `admin improvement on|off`
-- is the only way to change it.
-- ---------------------------------------------------------------------------
CREATE TABLE improvement_candidates (
  id                 TEXT PRIMARY KEY,
  weakness_key       TEXT NOT NULL UNIQUE,
  kind               TEXT NOT NULL,
  title              TEXT NOT NULL,
  problem            TEXT NOT NULL,
  metric_key         TEXT NOT NULL,
  downstream_metric  TEXT,
  owner_component    TEXT NOT NULL,
  frequency          INTEGER NOT NULL DEFAULT 0,
  denominator        INTEGER NOT NULL DEFAULT 0,
  scope              TEXT NOT NULL CHECK (scope IN ('GENERAL', 'LANE', 'LOCAL')),
  severity           TEXT NOT NULL CHECK (severity IN ('HIGH', 'MEDIUM', 'LOW')),
  evidence           TEXT NOT NULL DEFAULT '{}',
  proposal           TEXT,
  dependency_check   TEXT,
  research_goal_id   TEXT,
  change_request_id  TEXT,
  campaign_id        TEXT,
  delivered_at       TEXT,
  delivered_ref      TEXT,
  baseline           TEXT,
  result             TEXT,
  decision           TEXT CHECK (decision IS NULL OR decision IN
                       ('KEPT', 'KEPT_NO_EFFECT', 'REVERTED', 'REJECTED', 'COMBINED', 'HELD')),
  decision_reason    TEXT,
  combined_into_id   TEXT,
  held_on            TEXT,
  attempt            INTEGER NOT NULL DEFAULT 1,
  parent_id          TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE INDEX idx_improvement_candidates_open ON improvement_candidates (decision, owner_component);

CREATE TABLE improvement_events (
  id            TEXT PRIMARY KEY,
  candidate_id  TEXT,
  kind          TEXT NOT NULL,
  detail        TEXT NOT NULL DEFAULT '{}',
  at            TEXT NOT NULL
);

CREATE INDEX idx_improvement_events_candidate ON improvement_events (candidate_id, at);
CREATE INDEX idx_improvement_events_kind ON improvement_events (kind, at);

INSERT INTO brain_switches (name, enabled, updated_at, updated_by, reason)
VALUES ('improvement_loop', 1, '2026-11-03T00:00:00.000Z', 'migration',
        'Owner order 2026-11-03: Claude routines improve Brain itself; Brain identifies weaknesses, submits engineering to Factory, measures and continues without owner direction.');
