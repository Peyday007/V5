-- ---------------------------------------------------------------------------
-- THE CHEAP LANE: GRUNT WORK DONE BY FREE MODELS, AND WHAT EACH ONE SAID
-- ---------------------------------------------------------------------------
--
-- One row per (task kind, input, model): a free model's answer to one small,
-- fixed-format task, such as whether an opening is worth a deep look. It is a
-- sorting signal and never evidence: no gate, card, tier or ledger reads it.
-- The input hash is the cache, so the same page is never asked twice, and the
-- rows are the model's track record, counted per kind. Rows are never deleted.
CREATE TABLE cheap_results (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  input_hash   TEXT NOT NULL,
  subject_id   TEXT,
  model        TEXT NOT NULL,
  ok           INTEGER NOT NULL,
  output       TEXT,
  error        TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE (kind, input_hash, model)
);
CREATE INDEX idx_cheap_results_subject ON cheap_results (kind, subject_id);
CREATE INDEX idx_cheap_results_day ON cheap_results (kind, created_at);
