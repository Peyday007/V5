-- ---------------------------------------------------------------------------
-- A DECISION BRAIN PREPARED, AND DID NOT SEND
-- ---------------------------------------------------------------------------
--
-- A preliminary opening can be moved most of the way to execution without any
-- external effect: the buyer's request read and quoted, a scope, a price, a way
-- to fulfil it, the questions still open, and a finished proposal ready for a
-- person to submit. Until now that lived in a scratch file, so the card a
-- person reads said none of it.
--
-- One row per version, append-only: a re-preparation is a new version and the
-- old one keeps its row. `prepared_by` is always BRAIN and `state` is always
-- PREPARED_NOT_SENT, by CHECK, so nothing written here can read as a person's
-- approval or as an effect that happened. Submitting is a commercial action a
-- person takes outside Brain; nothing reads this table to decide anything.
--
-- `submission_blockers` and `open_questions` are JSON arrays of sentences.
-- `price_basis` says what the proposed price rests on, because a price with no
-- stated basis reads as a measurement.
CREATE TABLE cash_prepared_decisions (
  id                   TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL REFERENCES projects (id),
  opportunity_id       TEXT NOT NULL REFERENCES cash_opportunities (id),
  version              INTEGER NOT NULL,
  content_hash         TEXT NOT NULL,
  buyer_request        TEXT NOT NULL,
  buyer_request_url    TEXT NOT NULL,
  observed_at          TEXT NOT NULL,
  observed_status      TEXT NOT NULL,
  scope                TEXT NOT NULL,
  price_proposal       TEXT NOT NULL,
  price_basis          TEXT NOT NULL,
  fulfillment          TEXT NOT NULL,
  cash_timing          TEXT NOT NULL,
  open_questions       TEXT NOT NULL,
  proposal_text        TEXT NOT NULL,
  submission_blockers  TEXT NOT NULL,
  decision_needed      TEXT NOT NULL,
  prepared_by          TEXT NOT NULL CHECK (prepared_by = 'BRAIN'),
  state                TEXT NOT NULL CHECK (state = 'PREPARED_NOT_SENT'),
  created_at           TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_cash_prepared_version
  ON cash_prepared_decisions (opportunity_id, version);
CREATE INDEX idx_cash_prepared_project
  ON cash_prepared_decisions (project_id, opportunity_id);
