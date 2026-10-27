-- ---------------------------------------------------------------------------
-- SITE CHECKS: NAMED LOCAL BUSINESSES WHOSE WEBSITE IS LOSING THEM MONEY
-- ---------------------------------------------------------------------------
--
-- One row per business website plain code checks. The business comes from
-- public map data (a real name, a city, a website), never from a model. A
-- problem is something code can show: the security certificate is invalid,
-- the address does not resolve, the site answers an error, or the domain is
-- parked. A problem must be seen on two checks at least an hour apart before
-- it becomes a lead (`confirmed_at`), because one failed request proves
-- nothing. A confirmed problem is filed once as a feed item (`lead_item_id`)
-- and goes through the same free screen, rules and Claude shortlist as every
-- other lead. Rows are never deleted.
CREATE TABLE site_checks (
  id              TEXT PRIMARY KEY,
  business_key    TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  city            TEXT NOT NULL,
  category        TEXT,
  website         TEXT NOT NULL,
  phone           TEXT,
  found_at        TEXT NOT NULL,
  checked_at      TEXT,
  checks          INTEGER NOT NULL DEFAULT 0,
  problem         TEXT,
  problem_detail  TEXT,
  first_seen_at   TEXT,
  confirmed_at    TEXT,
  lead_item_id    TEXT
);
CREATE INDEX idx_site_checks_due ON site_checks (checked_at);
