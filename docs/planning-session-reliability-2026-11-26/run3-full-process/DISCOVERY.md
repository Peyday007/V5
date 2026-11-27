# Discovery brief: plan an owner's objective from nothing, through Brain

World W = /tmp/claude-0/-home-user-V5/67b503dd-6d2b-5998-8d68-dfde5cc723e6/scratchpad/rel3/d01. The owner's objective is
W/OBJECTIVE.txt. Brain holds NO openings for it: you must discover them. Follow AUTHOR.md (same directory as this file)
for the connector, the contract, the revision JSON, the ledger and fulfilment rules — with these additions:

1. Contract first (`brain_planning_contract`), from the words and `stored` terms.
2. Discover: use WebSearch / WebFetch to find several materially different, currently sold offers that a
   remote, AI-assisted operation could sell and fulfil within the window and limits (no owner physical work;
   do not use the owner's own businesses or past campaigns). For each, find what buyers actually pay, who
   fulfils it and at what cost, how buyers are reached, and how fast money settles — from real, dated pages.
3. Submit 3–5 routes with `brain_planning_admit_routes` {goal_id, routes:[...], session_id, model}; each route:
   {"title","buyerKind":"B2B"|"B2C","mechanism":"CAPABILITY_ARBITRAGE"|"EXISTING_BUYING_SIGNAL"|"EXPLICIT_PAID_REQUEST"|"SUPPLY_DEMAND_MISMATCH"|"PAIN_TRIGGERED_IMPLEMENTATION",
    "industry","payer","offer","price":<$ per sale>,"channel","performer":"BRAIN"|"SUBCONTRACTOR"|"OWNER","fulfiller","directCost":<$>|null,
    "capital":<$>,"ownerHoursPerDeal","acquisitionCostPerSale":<$>|null,"daysToFirstCash","buyerCount":<n>|null,"volumeBasis",
    "assumptions","ownerFit","searches":{"price":[urls/terms],"demand":[...],"volume":[...]}}
   A refused route comes back with the parser's reason; fix or drop it. Admitted routes are hypotheses only.
4. `brain_planning_run_brain`, then `brain_planning_context`: Brain raises research questions (`questions`) on the
   openings. For the 1–3 questions that decide the strongest route, research them for real and submit claims with
   `brain_planning_research` (verbatim excerpt, locator, dated source). Never invent a source or an excerpt.
5. Reply with: the routes admitted (ids), the questions researched (need ids and claim ids), then stop. An independent
   verifier will judge your research through Brain's evidence gate; you will then be told the outcome.
6. After that: rerun brain, write the plan revision (EXECUTABLE only if the evidence establishes every link; most
   likely CONDITIONAL with a validation test inside the $300 pre-proof cap, or NO_PLAN with the decisive gap),
   submit until Brain's check is clean, reply with the revision id, and wait for review as in AUTHOR.md step 3.
