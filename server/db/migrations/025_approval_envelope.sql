-- A preauthorized envelope a plan may be approved against, without a person.
--
-- The same shape as the gap authorization in 022, and for the same reason: an
-- authorization with no author is not one. What is stored here is a *reference*
-- to an envelope defined in code, never the envelope itself — so the limits a
-- plan is judged against cannot be edited by whoever starts the packet, and a
-- row that names an envelope this build does not define validates against
-- nothing and is refused.

ALTER TABLE research_orchestrations ADD COLUMN approval_envelope_id text;
ALTER TABLE research_orchestrations ADD COLUMN approval_envelope_authorized_by text;
ALTER TABLE research_orchestrations ADD COLUMN approval_envelope_authorized_at text;
