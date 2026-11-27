# Discovery brief: plan an owner's objective from nothing, through Brain

Follow AUTHOR.md (same directory) for the connector, the contract, the revision JSON, the ledger and fulfilment
rules and the review loop. Your world(s) hold NO openings: you must discover them. Additions:

1. Contract first (`brain_planning_contract`), from the words and `stored` terms.
2. Discover: use WebSearch / WebFetch to find several materially different, currently sold offers that a
   remote, AI-assisted operation could sell and fulfil within the window and limits stated in the objective. For each,
   find what buyers actually pay, who fulfils it and at what cost, how buyers are reached, and how fast money settles —
   from real, dated pages.
3. Submit 3–5 routes with `brain_planning_admit_routes` {goal_id, routes:[...], session_id, model}; each route:
   {"title","buyerKind":"B2B"|"B2C","mechanism":<one of the values a refusal lists>,
    "industry","payer","offer","price":<$ per sale>,"channel","performer":"BRAIN"|"SUBCONTRACTOR"|"OWNER","fulfiller","directCost":<$>|null,
    "capital":<$>,"ownerHoursPerDeal","acquisitionCostPerSale":<$>|null,"daysToFirstCash","buyerCount":<n>|null,"volumeBasis",
    "assumptions","ownerFit","searches":{"price":[urls/terms],"demand":[...],"volume":[...]}}
   A refused route comes back with the reason; fix or drop it. Admitted routes are hypotheses only.
4. `brain_planning_run_brain`, then `brain_planning_context`: Brain raises research questions (`questions`). For the
   1–3 questions that decide the strongest route, research them for real and submit claims with
   `brain_planning_research` (verbatim excerpt, locator, dated source). Never invent a source or an excerpt.
   Brain queues each answer for independent verification by its fleet; poll `brain_planning_context` (every ~2 min,
   `python3 -c "import time; time.sleep(120)"`) until the questions show their verification outcome. Unverified
   research is not evidence.
5. Your openings are hypotheses you discovered: in `sources`, cite for each opening your plan uses the public page(s) that show it exists (the buyers, the offer, the request), with `opportunityId` — not only Brain's card. Rerun brain and write the plan revision: EXECUTABLE only if the evidence establishes every link; otherwise
   CONDITIONAL with a validation test inside the objective's limits, or NO_PLAN naming the decisive gap with a concrete,
   costed experiment (proof/stop/continue) that resolves it. Submit until Brain's check is clean, then follow AUTHOR.md
   step 2 (review loop) to publication. Time limit: 180 minutes.
