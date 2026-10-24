-- ---------------------------------------------------------------------------
-- FEEDS: RAW LEADS PULLED BY PLAIN CODE FROM FREE PUBLIC SOURCES
-- ---------------------------------------------------------------------------
--
-- One row per item a feed returned (a job post, a new federal rule, a forum
-- post). Pulled by code, never by a model, and never evidence: an item becomes
-- part of the portfolio only after free models screened it, Brain's rules
-- checked it, and a Claude shortlist round verified it through the evidence
-- gate. `shortlisted_round_id` records the round that took it, so no item is
-- handed to Claude twice. Rows are never deleted.
CREATE TABLE feed_items (
  id                    TEXT PRIMARY KEY,
  source                TEXT NOT NULL,
  external_id           TEXT NOT NULL,
  url                   TEXT NOT NULL,
  title                 TEXT NOT NULL,
  body                  TEXT,
  organization          TEXT,
  published_at          TEXT,
  fetched_at            TEXT NOT NULL,
  shortlisted_round_id  TEXT,
  shortlisted_at        TEXT,
  UNIQUE (source, external_id)
);
CREATE INDEX idx_feed_items_fetched ON feed_items (fetched_at);
CREATE INDEX idx_feed_items_unlisted ON feed_items (shortlisted_round_id, fetched_at);

-- One row per pull attempt, so a source is not asked more often than it allows
-- and a source that keeps failing says why.
CREATE TABLE feed_pulls (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL,
  ok          INTEGER NOT NULL,
  fetched     INTEGER NOT NULL,
  inserted    INTEGER NOT NULL,
  error       TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_feed_pulls_source ON feed_pulls (source, created_at);
