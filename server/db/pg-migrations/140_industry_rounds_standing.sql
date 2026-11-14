-- A kernel round may be filed under the standing research authority rather than
-- a cash sprint: NULL cash_mode_id means "asked under a standing grant". The
-- SQLite chain's 149 rebuilds the table for the same change.
ALTER TABLE industry_rounds ALTER COLUMN cash_mode_id DROP NOT NULL;
