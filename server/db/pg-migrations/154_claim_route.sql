-- ---------------------------------------------------------------------------
-- A CLAIM NAMES THE ROUTE IT IS ABOUT (2026-11-25)
-- ---------------------------------------------------------------------------
--
-- A goal's discovery answer describes several ways money could be made, one
-- claim per part of each way (the signal, the price, the channel, the
-- fulfiller, the market's size, the payment terms). A claim's `population` is
-- its fragment's declared scope, the same for every claim of the answer, so
-- nothing said which way a claim was about and the harvest could not join the
-- parts of one way onto one opening. `route` is the worker's own short name of
-- the way a claim describes — the kind of buyer and what they pay for — given
-- identically on every claim about that way. Null where a worker named none,
-- which is every claim written before this.
-- ---------------------------------------------------------------------------

ALTER TABLE research_claims ADD COLUMN route TEXT;
