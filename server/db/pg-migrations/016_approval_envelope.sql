-- The Postgres half of migration 025. See that file for the reasoning; this
-- chain is numbered independently and the two versions do not mean the same
-- thing.

ALTER TABLE research_orchestrations ADD COLUMN approval_envelope_id text;
ALTER TABLE research_orchestrations ADD COLUMN approval_envelope_authorized_by text;
ALTER TABLE research_orchestrations ADD COLUMN approval_envelope_authorized_at text;
