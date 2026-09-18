-- The Postgres half of SQLite migration 052. Same seven tables, same rules.
--
-- `seq BIGSERIAL` on every one, because `dialect.ts` rewrites `rowid` to `seq`
-- and a table without it fails every cursor-ordered query on this backend while
-- passing the whole SQLite suite. That has now happened four times —
-- `012_checkpoint_seq`, §25's three connect tables, `worker_sessions` through
-- `workerSessionForBin` — so it goes in whether or not these tables' own
-- queries order by it today.
--
-- `REAL` is `double precision` here, which is what `generate-pg-baseline.mjs`
-- translates it to.
CREATE TABLE IF NOT EXISTS cash_modes (
  id                    TEXT PRIMARY KEY,
  seq                   BIGSERIAL,
  project_id            TEXT NOT NULL UNIQUE REFERENCES projects(id),
  owner_user_id         TEXT NOT NULL,
  objective             TEXT NOT NULL,
  horizon_days          INTEGER NOT NULL,
  envelope_id           TEXT NOT NULL,
  state                 TEXT NOT NULL
                        CHECK (state IN ('ACTIVE', 'WINDING_DOWN', 'ARCHIVED')),
  activated_at          TEXT NOT NULL,
  wound_down_at         TEXT,
  archived_at           TEXT,
  state_reason          TEXT,
  created_by_user_id    TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cash_authorities (
  id                       TEXT PRIMARY KEY,
  seq                      BIGSERIAL,
  project_id               TEXT NOT NULL REFERENCES projects(id),
  owner_user_id            TEXT NOT NULL,
  name                     TEXT NOT NULL,
  policy_version           INTEGER NOT NULL,
  allowed_actions          TEXT NOT NULL,
  prohibitions             TEXT NOT NULL,
  max_committed_cents      INTEGER NOT NULL CHECK (max_committed_cents >= 0),
  max_per_action_cents     INTEGER NOT NULL CHECK (max_per_action_cents >= 0),
  max_concurrent           INTEGER NOT NULL CHECK (max_concurrent >= 0),
  currency                 TEXT NOT NULL,
  starts_at                TEXT NOT NULL,
  expires_at               TEXT,
  state                    TEXT NOT NULL
                           CHECK (state IN ('ACTIVE', 'REVOKED', 'EXPIRED')),
  revoked_at               TEXT,
  revoked_by_user_id       TEXT,
  revoked_reason           TEXT,
  created_by_user_id       TEXT NOT NULL,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cash_authorities_live
  ON cash_authorities(project_id, state, created_at);

CREATE TABLE IF NOT EXISTS cash_opportunities (
  id                     TEXT PRIMARY KEY,
  seq                    BIGSERIAL,
  project_id             TEXT NOT NULL REFERENCES projects(id),
  cash_mode_id           TEXT NOT NULL REFERENCES cash_modes(id),
  owner_user_id          TEXT NOT NULL,
  title                  TEXT NOT NULL,
  mechanism              TEXT NOT NULL,
  industry               TEXT,
  source                 TEXT,
  candidate_id           TEXT,
  external_record_id     TEXT,
  payer                  TEXT,
  reachable_channel      TEXT,
  buying_signal          TEXT,
  signal_observed_at     TEXT,
  offer_scope            TEXT,
  acceptance_condition   TEXT,
  price_cents            INTEGER,
  currency               TEXT NOT NULL,
  payment_terms          TEXT,
  fulfillment_owner      TEXT,
  delivery_method        TEXT,
  required_inputs        TEXT,
  deadline               TEXT,
  economics_note         TEXT,
  peak_funding_cents     INTEGER,
  human_hours            DOUBLE PRECISION,
  expires_at             TEXT,
  expiry_reason          TEXT,
  depends_on_id          TEXT,
  duplicate_of_id        TEXT,
  required_capabilities  TEXT NOT NULL,
  execution_asset        TEXT,
  asset_revision         TEXT,
  state                  TEXT NOT NULL
                         CHECK (state IN (
                           'DISCOVERED', 'EVIDENCE_CARD', 'READY', 'EXECUTING',
                           'DELIVERING', 'COLLECTED', 'DECLINED', 'ARCHIVED'
                         )),
  exhausted_at           TEXT,
  exhausted_reason       TEXT,
  next_action            TEXT,
  next_action_due        TEXT,
  outcome                TEXT,
  stop_rule              TEXT,
  declined_by_user_id    TEXT,
  declined_reason        TEXT,
  reoffered_from_id      TEXT,
  archived_reason        TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cash_opportunities_project
  ON cash_opportunities(project_id, state, created_at);

CREATE INDEX IF NOT EXISTS idx_cash_opportunities_candidate
  ON cash_opportunities(candidate_id);

CREATE TABLE IF NOT EXISTS cash_commitments (
  id                 TEXT PRIMARY KEY,
  seq                BIGSERIAL,
  authority_id       TEXT NOT NULL REFERENCES cash_authorities(id),
  project_id         TEXT NOT NULL REFERENCES projects(id),
  opportunity_id     TEXT,
  amount_cents       INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency           TEXT NOT NULL,
  purpose            TEXT NOT NULL,
  expected_result    TEXT NOT NULL,
  stop_condition     TEXT NOT NULL,
  idempotency_key    TEXT NOT NULL,
  state              TEXT NOT NULL CHECK (state IN ('HELD', 'SETTLED', 'RELEASED')),
  settled_at         TEXT,
  released_at        TEXT,
  release_reason     TEXT,
  created_by         TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_commitments_key
  ON cash_commitments(idempotency_key);

CREATE INDEX IF NOT EXISTS idx_cash_commitments_held
  ON cash_commitments(authority_id, state);

CREATE TABLE IF NOT EXISTS cash_money_entries (
  id                  TEXT PRIMARY KEY,
  seq                 BIGSERIAL,
  project_id          TEXT NOT NULL REFERENCES projects(id),
  opportunity_id      TEXT,
  kind                TEXT NOT NULL CHECK (kind IN (
                        'CAPITAL_IN', 'CAPITAL_OUT', 'PIPELINE_AGREED',
                        'CUSTOMER_PAYMENT', 'SETTLEMENT', 'REFUND',
                        'COST', 'UNPAID_COMMITMENT', 'COMMITMENT_PAID',
                        'RESERVE', 'RESERVE_RELEASE'
                      )),
  amount_cents        INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency            TEXT NOT NULL,
  verified_reference  TEXT,
  funds_available_at  TEXT,
  occurred_at         TEXT NOT NULL,
  note                TEXT,
  recorded_by         TEXT NOT NULL,
  created_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cash_money_project
  ON cash_money_entries(project_id, occurred_at);

CREATE INDEX IF NOT EXISTS idx_cash_money_opportunity
  ON cash_money_entries(opportunity_id, occurred_at);

CREATE TABLE IF NOT EXISTS cash_needs (
  id                   TEXT PRIMARY KEY,
  seq                  BIGSERIAL,
  project_id           TEXT NOT NULL REFERENCES projects(id),
  opportunity_id       TEXT,
  blocked_action       TEXT NOT NULL,
  why_it_matters       TEXT NOT NULL,
  recommended_path     TEXT NOT NULL,
  expected_cost_cents  INTEGER,
  setup_effort         TEXT NOT NULL,
  next_step            TEXT NOT NULL,
  state                TEXT NOT NULL CHECK (state IN ('OPEN', 'RESOLVED', 'WITHDRAWN')),
  resolution           TEXT,
  resolved_by_user_id  TEXT,
  resolved_at          TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cash_needs_open
  ON cash_needs(project_id, state, created_at);

CREATE TABLE IF NOT EXISTS cash_events (
  id             TEXT PRIMARY KEY,
  seq            BIGSERIAL,
  project_id     TEXT NOT NULL,
  opportunity_id TEXT,
  kind           TEXT NOT NULL,
  actor_ref      TEXT NOT NULL,
  summary        TEXT NOT NULL,
  detail         TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cash_events_project
  ON cash_events(project_id, created_at);
