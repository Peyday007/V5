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
  under /home/user/V5/bench, /home/user/V5/tests, /home/user/V5/docs, /home/user/V5-run11 (any of it), any `*.grader.json`, `.map.txt`, `.ports.txt`,
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
  "cash": [{"day","kind":"SPEND|FEE|COMMIT|RELEASE|RECEIPT|REFUND|FUNDING (the owner's own money advanced; never revenue)","amountCents","label","settlesDay":<RECEIPT>,"stepId":"<the step it pays/commits/releases>"}],
  "proofDay", "quantities": [{"name","status":"EVIDENCED|ESTIMATE|ASSUMED|UNKNOWN","value"|null,"unit","sources":["s1"],"needs"}],
  "sources": [{"id","url":"https://brain.local/card/<opportunityId>#<field>" for a card fact, or the public page you read,"dated","claim","population","matchesBuyer","opportunityId":<the opening it is about>}],
  "validation": null|{"proof","stop":[…],"continue":[…],"decides":[the chain link(s) whose measurement decides whether the plan goes on — the decisive missing evidence]}, "noPlan": null|{"decisiveGap","resolution","decisiveLinks":[the chain links the decisive gap is about; each must be missing in your chain]}, "reach": null,
  "answers": [{"finding","resolution"} — one per finding of the last review when revising; for each of the review's
             `conditions` (by index i) also {"condition": i, "decision": "ACCEPTED"|"REBUTTED", "records": [the card fact
             fields of that opening, or "brain:<LINK>" for Brain's link basis, that you checked it against]}],
  "chain": [for EVERY opening in the brain run: {"opportunityId","missing":[links YOU judge not established]}],
  "excluded": [{"opportunityId","why"}], "members": [{"opportunityId","deals","price","directCost"|null,"capital"|null,"settlesDay"|null}],
  "resolves": [chain links your test/research/next step measures — must include every link your conditional plan's members miss, and every decisive link of a no-plan],
  "disagreements": [{"opportunityId","link","reason"} — required wherever your chain differs from Brain's `links` for that opening, either way; give the evidence],
  "constraints": [{"constraint":"DEADLINE|CAPITAL|TARGET|OWNER_HOURS","suggestion","basis":[{"opportunityId","field":<the card's EVIDENCE fact that fixes the figure>}]}] }
Constraint rule: a constraint is arithmetic on ESTABLISHED figures (TARGET = counted buyers × an established price;
DEADLINE = a measured settlement time; CAPITAL = a stated capital need; OWNER_HOURS = stated hours). Missing or
contradicted evidence — an unknown buyer count, a price nobody established — sets no ceiling: name it as a decisive gap
(noPlan.decisiveLinks) to research, never as a constraint.
Ledger rule: every outflow (SPEND, FEE, COMMIT, RELEASE) names the `stepId` it pays, and each costed step's linked
outflows total exactly its cost — no omitted expense, no unlinked commitment, nothing counted twice. A supplier may
be paid by the DELIVER step itself (its cost) or by an ORDER step.
Fulfilment rule: a DELIVER step's performer is whoever the opening's own record says fulfils it (a named
`fulfillmentOwner` → that provider, or the owner if it names the owner; none named and a deliverable in
`requiredCapabilities` → BRAIN). `humanHours` is work per deal by that fulfiller, not owner work unless the owner
is the fulfiller. Brain attaches each step's capability record itself; a step Brain cannot perform is refused.

## Process (no one relays reviews to you: Brain's queue deals them to an independent fleet, and you read the outcome yourself)
1. For each world: run_brain, context, contract, then submit revisions until Brain's check is clean. A clean
   revision is queued for independent review automatically (`reviewItem` in the submit result).
2. Then poll `brain_planning_state` {goal_id} for each of your worlds (about every 2 minutes; use
   `python3 -c "import time; time.sleep(120)"` between rounds — never `sleep`). For a world whose current revision
   has a review:
   - PASS → `brain_planning_finalize` that revision.
   - REVISE → revise (parentRevisionId = the reviewed revision, an `answers` entry per finding — accept it and change
     the plan, or say with evidence why it is wrong), resubmit until clean; the new revision is queued for review.
   A reviewer's condition is an objection to weigh, not an instruction: before accepting it, read the records it cites
   (the card facts, Brain's link basis, the agreements) and decide whether they actually leave the link unestablished.
   Accept only what the records support; rebut, citing the records, what they do not.
3. Some worlds change while you work: if `brain_planning_context` shows the contract or a card changed (a check says
   the contract is stale, or a revision is superseded), re-read run_brain/context and plan the world as it now stands.
4. A published plan can go stale: `brain_planning_state` then shows `final: null`, the old plan under `staleFinal`, and `staleBecause` saying what changed (the owner's objective, the goal's terms, or an opening's record). Re-plan such a world as step 3 says. After every world is published, keep polling each world's state every ~2 minutes for 20 more minutes in case one goes stale.
5. Continue until every world is published (state shows a finalized plan) and has stayed published for those 20 minutes, or 150 minutes pass. Then reply with one
   line per world: `<world>  <stance>  <published revisionId or NONE>  <one-sentence reason>`, and stop.
