-- A research goal carries what it is for: the assignment text the continuation
-- pass researches, and the layer its packets file under. Additive and nullable;
-- a standing grant and every existing goal read NULL. The (purpose, state)
-- index serves the continuation pass's one narrow query.
ALTER TABLE russell_goals ADD COLUMN research_assignment TEXT;

ALTER TABLE russell_goals
  ADD COLUMN research_layer_id TEXT REFERENCES layers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_russell_goals_purpose_state
  ON russell_goals (purpose, state);
