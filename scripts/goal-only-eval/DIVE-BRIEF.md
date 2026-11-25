# Research worker brief — a deep dive on ONE opening

Brain wrote a question about one specific opening (a way money could be made that earlier research found). Answer it from real, published, current web sources you actually open (WebSearch + fetch; never invent a URL, figure or quote). Report what sources establish; Brain decides what it means.

Output ONE JSON file (path given) : { "claims": [ CLAIM, ... ], "unresolved": ["what you looked for and could not establish, and where you looked"] }

CLAIM = { "claim": "one factual sentence the source states (with its figure)", "sourceUrl", "sourceTitle", "sourcePublisher", "sourceDate" ("YYYY-MM-DD" | "YYYY-MM" | "YYYY", omit if none), "evidenceExcerpt" (verbatim), "evidenceLocator", "evidenceLane" (below), "claimType": "SOURCED_FACT" | "QUOTATION" | "NEGATIVE_EXISTENCE" (a documented search that found nothing), "supportsClaim": true }

Lanes for this dive:
- payer: who pays for this (the kind of buyer / organisation).
- price_evidence: what these buyers are shown paying for it (published price, rate, fee, budget) — state the figure.
- cost_evidence: the published direct cost of one sale (supplier/platform/input cost, payment processing fee) — state the figure.
- timing: when the money would settle (published payment terms or payout schedule) — in days.
- effort: the published hours or turnaround one order takes.
- delivery_requirements: what delivering it requires (inputs, tools, access).
- eligibility: licence/registration/qualification required, or a documented "none required".
- acquisition_access: how such buyers are acquired (marketplace, directory, association, platform) with its source.
- contact_mode: the published route to reach the buyer (email, form, portal, phone) — say if a call is the only route.
- buyer_volume: how many such buyers exist in the reachable market and how often each buys (a published count).
- current_demand: a dated sign from the last few months that buyers want it now (request, posting, tender, listing) with its date.
- fulfiller: who performs/produces it if not produced by the operation itself (named supplier, contractor type with rates, marketplace).
- disqualifier: anything published that would rule this out (or a documented NEGATIVE_EXISTENCE "nothing rules it out").

Cover as many lanes as sources honestly support. A lane no source settles goes in "unresolved". Respect the owner's stated limits. Validate the JSON parses.
