-- The date a source publishes as an opening's deadline, declared by the worker
-- that read it (services/cash/discovery.ts copies it onto the opening).
--
-- A closing date was prose on a card: a closed RFP read "Closing was Friday
-- Sept 25" in its disqualifier field, and nothing could compare that with the
-- calendar, so a closed opening was discovered, harvested and researched before
-- anything noticed. YYYY-MM-DD, validated on submission; null when the source
-- states none, which is most claims and never means "open".
ALTER TABLE research_claims ADD COLUMN closes_on TEXT;
