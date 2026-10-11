-- What a deep dive's claim establishes about whether one opening can be taken:
-- who pays, how a supplier reaches them, and whether anything rules it out.
-- Declared by the worker that read the source, from the closed set in
-- server/domain/validationFindings.ts, so the card reads a column rather than
-- inferring from the lane a claim was filed in. validation_date carries the
-- published closing date of a RESPONSE_DEADLINE finding and nothing else.
ALTER TABLE research_claims ADD COLUMN validation_finding TEXT;
ALTER TABLE research_claims ADD COLUMN validation_date TEXT;
