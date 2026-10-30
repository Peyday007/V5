-- ---------------------------------------------------------------------------
-- A DATA-DRIVEN SOURCE REGISTRY, AND WHAT COLLECTING FROM IT LEAVES BEHIND
-- ---------------------------------------------------------------------------
--
-- A source of public information is a row: its kind, URL template, pagination
-- rule, parser, pull interval, per-host rate limit, what its robots/terms said
-- when they were last checked, and which project (if any) owns it. A source
-- with no owning project is public to every project; an owned source and the
-- items it brings are read only by that project.
--
-- Everything collected is RAW INFORMATION. This migration adds the memory that
-- collecting needs - a checkpoint per job, a content hash and canonical key per
-- item, a link from one stored item to every source that delivered it, a change
-- history - and the per-pull measurements a source is judged by. All additive.
CREATE TABLE collect_sources (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT REFERENCES projects(id),
  slug               TEXT NOT NULL,
  label              TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN
    ('RSS_ATOM', 'JSON_API', 'CSV_DATASET', 'SITEMAP', 'HTML_LIST', 'OVERPASS', 'PAGE_WATCH')),
  url_template       TEXT NOT NULL,
  pagination         TEXT,
  parser_id          TEXT NOT NULL,
  interval_ms        INTEGER NOT NULL CHECK (interval_ms > 0),
  host_rate_per_min  INTEGER CHECK (host_rate_per_min IS NULL OR host_rate_per_min > 0),
  robots_status      TEXT NOT NULL DEFAULT 'UNCHECKED'
    CHECK (robots_status IN ('UNCHECKED', 'ALLOWED', 'DISALLOWED', 'TERMS_FORBID')),
  robots_checked_at  TEXT,
  robots_note        TEXT,
  enabled            INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE (slug)
);
CREATE INDEX idx_collect_sources_project ON collect_sources (project_id);

-- Where an interrupted job resumes from, one live checkpoint per source.
CREATE TABLE collect_checkpoints (
  source_id    TEXT PRIMARY KEY REFERENCES collect_sources(id),
  cursor       TEXT,
  etag         TEXT,
  last_modified TEXT,
  content_hash TEXT,
  updated_at   TEXT NOT NULL
);

ALTER TABLE feed_items ADD COLUMN canonical_url TEXT;
ALTER TABLE feed_items ADD COLUMN dedupe_key TEXT;
ALTER TABLE feed_items ADD COLUMN content_hash TEXT;
ALTER TABLE feed_items ADD COLUMN duplicate_of TEXT;
ALTER TABLE feed_items ADD COLUMN first_seen_at TEXT;
ALTER TABLE feed_items ADD COLUMN last_seen_at TEXT;
ALTER TABLE feed_items ADD COLUMN removed_at TEXT;
ALTER TABLE feed_items ADD COLUMN project_id TEXT;
CREATE INDEX idx_feed_items_dedupe ON feed_items (dedupe_key);
CREATE INDEX idx_feed_items_hash ON feed_items (content_hash);

-- One stored item, every source that delivered it.
CREATE TABLE feed_item_sources (
  item_id      TEXT NOT NULL REFERENCES feed_items(id),
  source       TEXT NOT NULL,
  external_id  TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (item_id, source, external_id)
);

-- A change history: a new record, a field that changed, a record that disappeared.
CREATE TABLE feed_item_versions (
  id           TEXT PRIMARY KEY,
  item_id      TEXT NOT NULL REFERENCES feed_items(id),
  change_kind  TEXT NOT NULL CHECK (change_kind IN ('NEW', 'FIELD_CHANGED', 'DISAPPEARED', 'REAPPEARED')),
  field        TEXT,
  old_value    TEXT,
  new_value    TEXT,
  content_hash TEXT,
  observed_at  TEXT NOT NULL
);
CREATE INDEX idx_feed_item_versions_item ON feed_item_versions (item_id, observed_at);

-- What a pull measured, beside the pull. A source is judged on downstream
-- yield, so these are counts and times, never a score.
ALTER TABLE feed_pulls ADD COLUMN method TEXT;
ALTER TABLE feed_pulls ADD COLUMN duplicates INTEGER;
ALTER TABLE feed_pulls ADD COLUMN relevant INTEGER;
ALTER TABLE feed_pulls ADD COLUMN signals INTEGER;
ALTER TABLE feed_pulls ADD COLUMN failure_cause TEXT CHECK (failure_cause IS NULL OR failure_cause IN
  ('SOURCE_UNREACHABLE', 'NO_MATCHING_RECORDS', 'REFUSED', 'RATE_LIMITED', 'UNPARSEABLE', 'TIMEOUT', 'SERVER_ERROR'));
ALTER TABLE feed_pulls ADD COLUMN wall_ms INTEGER;
ALTER TABLE feed_pulls ADD COLUMN bytes INTEGER;
ALTER TABLE feed_pulls ADD COLUMN memory_bytes INTEGER;
ALTER TABLE feed_pulls ADD COLUMN cheap_calls INTEGER;
ALTER TABLE feed_pulls ADD COLUMN claude_jobs INTEGER;
