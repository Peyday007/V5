-- ---------------------------------------------------------------------------
-- WHAT BRAIN READ OF A KNOWN LISTING, AND WHEN
-- ---------------------------------------------------------------------------
--
-- An opening found on a platform is a listing with an id and a link, carried
-- on its accepted source claim. Regular code retrieves that listing; a worker
-- judges it. One row per attempt, append-only: the response Brain received,
-- the time it received it, and which of four answers it was.
--
-- NOT_FOUND, BLOCKED and TEMPORARY are kept apart because their remedies are
-- different, and none of them is evidence about demand: nothing reads this
-- table to write a card fact, a ruled-out answer or a verdict. It is context
-- handed to the worker beside the original link.
CREATE TABLE listing_retrievals (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects (id),
  opportunity_id  TEXT NOT NULL REFERENCES cash_opportunities (id),
  platform        TEXT NOT NULL CHECK (platform IN ('FREELANCER')),
  platform_id     TEXT,
  seo_url         TEXT,
  original_url    TEXT NOT NULL,
  request_url     TEXT NOT NULL,
  outcome         TEXT NOT NULL CHECK (outcome IN ('RETRIEVED', 'NOT_FOUND', 'BLOCKED', 'TEMPORARY')),
  http_status     INTEGER,
  reason          TEXT NOT NULL,
  response_body   TEXT,
  body_truncated  INTEGER NOT NULL DEFAULT 0,
  retrieved_at    TEXT NOT NULL
);

CREATE INDEX idx_listing_retrievals_opportunity ON listing_retrievals (opportunity_id, retrieved_at);
