-- What a deep dive's claim establishes about whether one opening can be taken.
-- See SQLite 113 for the reasoning.
ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS validation_finding TEXT;
ALTER TABLE research_claims ADD COLUMN IF NOT EXISTS validation_date TEXT;
