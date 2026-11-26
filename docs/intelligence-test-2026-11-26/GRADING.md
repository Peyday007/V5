# Blind plan grading rubric

You are an independent evaluator. You did not write these plans and do not know which system or condition produced them.
For ONE goal you receive: the owner's verbatim words and limits, the verified fact list the planner was given (F-refs), and two or more plan outputs labelled X, Y (... ) — each is a planner reply (routes) plus the planner's own critic ranking.

For each labelled output, judge the TOP-RANKED surviving route (the critic's #1; if no critic ranking, the first route), and note whether any other route in that output is better.

Score each criterion PASS / FAIL with one line of reason:
1. OWNER_FIT — uses what the owner has / respects stated refusals; no invented skills or assets.
2. LIMITS — capital tied up <= limit, owner hours <= limit, first cash inside the window. Any breach = FAIL.
3. BUYER_DEMAND — a real, specific buyer segment that is buying now; supported by a fact (or plainly true and checkable).
4. PRICE — the price is what such buyers pay today, supported by a cited fact that actually states it (check the F-ref text).
5. CHANNEL — the channel can actually produce paying buyers inside the window with the stated budget.
6. FULFILMENT — who delivers is named and can start now at a known cost.
7. ECONOMICS — price × realistic volume − costs reaches the owner's target inside the window (show the arithmetic), or the plan states truthfully how far it reaches.
8. CASH_TIMING — money is collected (not just invoiced/pending platform clearance) inside the window.
9. EVIDENCE_USE — citations say what the fact says; no fact misused; no fact that contradicts the route ignored.
10. EXECUTABLE — a person could start executing tomorrow from what is written (first concrete steps are clear).

Verdict per output: USABLE (all of 1,2,4,5,6,8 pass and 7 passes or is honestly bounded with a credible path ≥ ~70% of target; plan executable) / CREDIBLE_INCOMPLETE (right direction, a fixable gap) / NOT_USABLE.

Then classify the main failure of each non-USABLE output into ONE category:
A. Information never found (the decisive fact was not in the fact list).
B. Information found but not verified (n/a to you unless stated).
C. Information verified but not delivered (the decisive fact exists in the full verified list but was NOT shown to this planner — you will be told which facts were shown).
D. Information delivered but misinterpreted (the fact was shown; the planner ignored, misread or mis-cited it, or broke a stated limit).
E. Correct information and reasoning, but planning/output failure downstream (parser/critic dropped the good route, truncated output, etc.).

Also state: what is the strongest viable strategy YOU see in the verified facts for this owner (one paragraph, citing F-refs), and whether any output found it.

Write JSON to the path you are given:
{"goal":"pXX","outputs":[{"label":"X","topRoute":"title","criteria":{"OWNER_FIT":["PASS","why"],...},"verdict":"USABLE|CREDIBLE_INCOMPLETE|NOT_USABLE","failureCategory":"A|B|C|D|E|null","failureDetail":"..."}],"strongestInEvidence":"...","foundBy":["X"...]}
Reply with a 6-line summary.
