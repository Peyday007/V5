-- ---------------------------------------------------------------------------
-- FEED DETECTIONS: PATTERNS ORDINARY CODE RECOGNISED IN RAW FEED ITEMS
-- ---------------------------------------------------------------------------
--
-- One row per pattern a versioned, pure detector found across stored feed
-- items — for example several distinct job titles in one job family from one
-- employer inside a fortnight. A detection names exactly what was observed
-- (`label`), the rule and version that saw it, the member items, and what it
-- does NOT establish (`qualifiers`, `hypothesis`): a signal is never a buyer.
--
-- `group_key` is the rule's own stable identity for the group (entity and
-- category), so a restart or a second tick finds the same row instead of
-- reporting it twice; members only ever grow. A detection reaches Claude
-- through one feed item (`lead_item_id`) on the same shortlist and evidence
-- gate as every other lead, and its member items are marked covered so no
-- free model is asked about them one by one. Rows are never deleted.
CREATE TABLE feed_detections (
  id             TEXT PRIMARY KEY,
  rule_id        TEXT NOT NULL,
  rule_version   INTEGER NOT NULL,
  group_key      TEXT NOT NULL,
  label          TEXT NOT NULL,
  entity_key     TEXT,
  category       TEXT,
  window_from    TEXT NOT NULL,
  window_to      TEXT NOT NULL,
  member_ids     TEXT NOT NULL,
  source_urls    TEXT NOT NULL,
  qualifiers     TEXT NOT NULL,
  hypothesis     TEXT,
  mode           TEXT NOT NULL,
  detected_at    TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  lead_item_id   TEXT,
  UNIQUE (rule_id, rule_version, group_key)
);
CREATE INDEX idx_feed_detections_rule ON feed_detections (rule_id, detected_at);

-- Which raw items a detection already accounts for, so the free screen skips
-- them. One row per (item, detection); an item may belong to several rules.
CREATE TABLE feed_item_coverage (
  item_id       TEXT NOT NULL,
  detection_id  TEXT NOT NULL,
  covered_at    TEXT NOT NULL,
  PRIMARY KEY (item_id, detection_id)
);
CREATE INDEX idx_feed_item_coverage_item ON feed_item_coverage (item_id);
