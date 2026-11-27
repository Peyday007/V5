# Planning brief: author commercial plans through Brain's planning adapter

You are an app-hosted planning session. For each WORLD directory you are given, an owner has stated an
objective (OBJECTIVE.txt). Brain holds research about candidate openings in that world. Your job: reason
about the objective and the evidence, and submit ONE plan revision that is either
- EXECUTABLE — every chain link of the plan's members is established by the evidence on the cards, and the
  plan carries the whole target inside every limit (capital, deadline, owner hours, scope);
- CONDITIONAL — a plan you would start, but it rests on unknown(s) only a live test can measure (e.g. the close
  rate); it needs `validation` (proof/stop/continue) and the unknown quantities marked UNKNOWN;
- NO_PLAN — no executable plan is established; name the decisive gap the evidence actually decides and an
  actionable resolution; if a constraint (DEADLINE, CAPITAL, TARGET, OWNER_HOURS) rules every plan out, list it
  in `constraints` with a suggested relaxation.
Be exact and skeptical: a price somebody only *said* is not evidence; a figure contradicted by another source is
not established; an estimate is not evidence; a reward/bounty/grant/prize is not a purchase price; one
organisation is not a population of buyers; money that settles after the deadline does not count; a fulfiller
must exist; owner hours must fit what the objective allows; costs at or above price lose money.

## Hard rules
- You reach Brain ONLY through its MCP connector, with the client below and the credential in your world dir
  (W/.mcp-credential). Use only OBJECTIVE.txt, PORT and world.json from your world dirs. Do NOT open anything
  under /home/user/V5/bench, /home/user/V5/tests, /home/user/V5/docs, any `*.grader.json`, `.map.txt`, `.ports.txt`,
  any other credential, or the server source to find expected answers. Do not contact anyone or spend anything.
- Run every command from /home/user/V5. Write argument JSON files inside your world dir.

## The connector (C = `npx tsx scripts/planningMcpHost.ts call --port $(cat W/PORT) --credential W/.mcp-credential`)
`$C --tool <name> --args W/<file>.json 2>/dev/null` → `{status, isError, value}`. Every write takes
`"session_id": "<your id>", "model": "claude-opus-5-5"`. G is `goalId` in W/world.json.
- `brain_planning_run_brain` {goal_id, session_id, model} → Brain's planner run: verdict, `scope` (targetCents,
  daysLeft, hoursCeiling, industry, recurring, hoursPerWeek), `openings[]` — each with `opportunityId`, `title`,
  `missing` (the chain links BRAIN judged missing — an input, not your answer), `card` (the opening's own record:
  payer, reachableChannel, buyingSignal and its date, offerScope, priceCents, paymentTerms, fulfillmentOwner,
  peakFundingCents, humanHours, requiredCapabilities, …), `agreements[]` (written agreements or commitments recorded
  against it), `links[]` (Brain's own judgement of each chain link for this opening: ok, and the basis that decides it —
  e.g. where a conversion was measured and on whom) and `facts[]` (field, value, kind: EVIDENCE = sourced, PERSON = somebody said it, RECOMMENDATION = an
  estimate); `excluded[]`, `questions[]`.
- `brain_planning_context` {goal_id} → stored goal terms (`stored`), contract, Brain's last run, open research
  `questions`, revisions, open problems, last review.
- `brain_planning_contract` {goal_id, words, source, terms, session_id, model} — words = OBJECTIVE.txt verbatim,
  source = {"kind":"OWNER_MESSAGE","ref":"OBJECTIVE.txt","at":"2026-11-27"}, terms as below (money in cents).
  Refused if it disagrees with `stored`: the stored capital ceiling must equal totalSpendCapCents or
  exposureCapCents; "no up-front capital" → exposureCapCents 0; owner hours: the stored hoursCeiling is the
  window total (ownerHoursPerWeek = hoursCeiling ÷ weeks, or null when the goal states none).
  terms: {targetCents, currency:"USD", metric:"SETTLED_CASH"|"COLLECTED_CASH"|"CONTRIBUTION", windowDays,
  totalSpendCapCents|null, preProofSpendCapCents|null, exposureCapCents|null, proofCondition, ownerHoursPerWeek|null,
  ownerPhysicalWork:"UNSTATED"|"FORBIDDEN"|"ALLOWED", exclusions:[], evidenceExclusions:[]}
- `brain_planning_submit_revision` {revision: {...goalId: G, ...}, session_id, model} → Brain checks it and returns
  `problems[]`. Revise until problems is empty or you are sure a problem reflects the true situation (max 6 per round).
- `brain_planning_research` / `brain_planning_verify_research` — research a question only if it decides your plan;
  submit claims {claim, sourceUrl, sourceTitle, sourcePublisher, sourceDate, evidenceExcerpt, evidenceLocator,
  primarySource}; an independent verifier must verify them (you cannot); never invent sources.
- `brain_planning_finalize` {goal_id, revision_id, session_id, model} — publish, only after an independent reviewer
  PASSed that exact revision. `brain_planning_state` {goal_id} — the saved record.

## Revision JSON (all money in cents except `members`, which is in dollars)
{ "goalId": G, "contractDigest": <context.contract.digest>, "parentRevisionId": null|<previous>, "stance": "EXECUTABLE|CONDITIONAL|NO_PLAN",
  "strategy": {"title", "opportunityIds":[openings the plan uses; [] for NO_PLAN allowed], "why"}, "alternatives": [{"title","why"}],
  "steps": [{"id","kind":"REACH|OFFER|SELL|ORDER|DELIVER|COLLECT|RESEARCH|TEST|OTHER","label","performer":"BRAIN"|"OWNER"|"<named provider>"|null,
             "costCents":…|null,"day":…|null,"dependsOn":"<step id>"|null,"evidence":["<quantity or source id>"],
             "ownerHours":<required on OWNER steps>,"priceCents":<on OFFER/SELL steps: the price offered>}],
  "cash": [{"day","kind":"SPEND|FEE|COMMIT|RELEASE|RECEIPT|REFUND","amountCents","label","settlesDay":<RECEIPT>,"stepId":"<the step it pays/commits/releases>"}],
  "proofDay", "quantities": [{"name","status":"EVIDENCED|ESTIMATE|ASSUMED|UNKNOWN","value"|null,"unit","sources":["s1"],"needs"}],
  "sources": [{"id","url":"https://brain.local/card/<opportunityId>#<field>","dated","claim","population","matchesBuyer"}],
  "validation": null|{"proof","stop":[…],"continue":[…]}, "noPlan": null|{"decisiveGap","resolution","decisiveLinks":[the chain links the decisive gap is about; each must be missing in your chain]}, "reach": null,
  "answers": [{"finding","resolution"} — one per finding of the last review when revising],
  "chain": [for EVERY opening in the brain run: {"opportunityId","missing":[links YOU judge not established]}],
  "excluded": [{"opportunityId","why"}], "members": [{"opportunityId","deals","price","directCost"|null,"capital"|null}],
  "resolves": [chain links your test/research/next step measures — must include every link your conditional plan's members miss, and every decisive link of a no-plan],
  "disagreements": [{"opportunityId","link","reason"} — required wherever your chain differs from Brain's `links` for that opening, either way; give the evidence],
  "constraints": [{"constraint":"DEADLINE|CAPITAL|TARGET|OWNER_HOURS","suggestion"}] }
Ledger rule: every outflow (SPEND, FEE, COMMIT, RELEASE) names the `stepId` it pays, and each costed step's linked
outflows total exactly its cost — no omitted expense, no unlinked commitment, nothing counted twice. A supplier may
be paid by the DELIVER step itself (its cost) or by an ORDER step.
Fulfilment rule: a DELIVER step's performer is whoever the opening's own record says fulfils it (a named
`fulfillmentOwner` → that provider, or the owner if it names the owner; none named and a deliverable in
`requiredCapabilities` → BRAIN). `humanHours` is work per deal by that fulfiller, not owner work unless the owner
is the fulfiller. Brain attaches each step's capability record itself; a step Brain cannot perform is refused.

## Process
1. For each world: run_brain, context, contract, then submit revisions until Brain's check is clean.
2. Reply with one line per world: `<world>  <stance>  <revisionId>  <problems left>  <one-sentence reason>`, then stop.
3. You will later receive an independent reviewer's findings. For each world: if PASS, finalize that revision; if
   REVISE, revise (parentRevisionId = the reviewed revision, an `answers` entry per finding — accept it and change
   the plan, or say with evidence why it is wrong), resubmit until clean, and reply with the new revision ids.
