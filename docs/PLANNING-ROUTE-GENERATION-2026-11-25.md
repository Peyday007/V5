# Autonomous route generation — state of the mission (2026-11-25)

Owner's mission (2026-11-25): Brain independently produces credible, researched,
executable plans for ≥ 90% of fresh, feasible, unfamiliar objectives given only the
objective and the owner's normal constraints. Final acceptance: ≥ 27/30 sealed fresh
requests on a frozen, deployed version, zero critical errors, routes originated by
Brain. Baseline (2026-11-24, `docs/PLANNING-9-10-INVESTIGATION-2026-11-24.md`):
goal-only 0/46.

This file is the resumable record: what is built, what is measured, how the
evaluation runs, and the next executable actions.

## 1. Where the route was lost (production trace, 2026-11-25)

A goal's discovery round already asked, in prose, for whole routes. The code split
each answer apart:

1. the harvest filed only the claim carrying an `opportunity_signal`, as a card with
   a buying signal and nothing else — the same answer's price, channel, fulfiller,
   market size and settlement claims were left behind;
2. the goal profile had no lanes for channel, fulfiller, volume or settlement;
3. a claim's `population` is its fragment's scope, so nothing said which way a claim
   described;
4. the goal's own words never reached the question (it named the sprint's standing
   objective), so a named business, hinted industry, place or condition was invisible;
5. per-route research (validation dives) had no lanes for market size, current
   demand or the fulfiller;
6. answers to pathway and constructed rounds returned to map nodes or to new,
   unrelated openings instead of the route that asked;
7. Brain's own proved capability was never credited as a route's fulfiller unless a
   play bucket had asked;
8. intake refused or misread ordinary phrasings ("I can put $1,500 in", "get me
   $1,500 in paid invoices", "I'm not doing any of the work").

## 2. What is built (branch `claude/p1-route-synthesis`, merged P1b `claude/p1b-route-return`)

| step of the loop | change |
|---|---|
| understand the objective | intake reads capital by what the owner says they have/put in; amount verbs take objects; payment nouns; plain-spoken no-money/no-hours read as limits of nothing |
| generate strategies around the objective | `ownerBrief`: every goal round quotes the owner's words as the brief; `questionFor` framed by the goal |
| combine partial evidence into routes | `research_claims.route` (migrations 163 / 154); MCP + provider parsers accept it; `GOAL_MECHANISM` route lanes (channel, fulfiller, cost, effort, volume, settlement); `joinRouteEvidence` writes one answer's same-route claims onto one opening through `writeEvidenceAnswer` |
| Brain's own facts | a route whose offer is a deliverable kind Brain proved requires that capability (fulfilment from Brain's proof); research hours reach `human_hours` |
| research decisive unknowns per route | dive lanes `buyer_volume`, `current_demand`, `fulfiller`; pathway answers return to the asking opening (`applyPathwayAnswers`); constructed-round numbers map unmapped buyers |
| compare / select | capture thesis composed for a harvest-assembled route, so it leaves SIGNAL and is modelled |
| map quality | supplier/need parts must name a kind (`namesAMarketPart`); plan signatures use fulfilment kinds |

## 3. Evaluation harness (`scripts/goal-only-eval/`)

Real Brain code, real research. `e2e.mts questions` creates each goal from the
objective alone and has Brain open its own discovery round; a research worker (an
agent following `WORKER-BRIEF.md`, live web sources only, no route hints) answers
Brain's question; `e2e.mts file` files the answer through `recordFragmentClaims` and
the evidence gate (`gateFragment`), harvests, runs the operating tick and reads the
plan; `dives`/`filedive` run Brain's per-route validation dives the same way
(`DIVE-BRIEF.md`); `next` lets Brain open its own next round (recovery). Plans are
graded by an independent reviewer (`GRADER-BRIEF.md`) against sealed feasibility
notes. Request sets and sealed routes live outside the repository.

This is the local proof of the loop. The owner's decisive test and final acceptance
run on production: goal creation there needs Brain's operator credential or the
Goals workflow with an administrator's `--admin` identity.

## 4. Measurements so far

- Single answer filed as a worker files it → harvest → tick → plan: a
  sell/deliver/collect plan whose only open link is the close rate
  (`tests/routeEvidenceJoin.test.ts`).
- Smoke r04 ("start a resume-writing service, $1,000 in 21 days, no capital"), real
  research: round 1 produced 3 routes, all modelled (before: 0 modelled); dives
  established most parts; the plan concluded NOT_VIABLE with evidenced reasons
  (agency invoices settle in 30 days > 21; outplacement needs capital); Brain's own
  recovery opened a consumer round. Result of round 2: pending.
- Decisive-10 (`d01–d10`, independent reviewer, sealed routes unread): round-1
  research running.

## 5. Next executable actions

1. File decisive-10 round-1 answers (`e2e.mts file`), run dives, recovery rounds;
   grade with the independent grader; report the goal-only rate.
2. Merge `claude/p1-route-synthesis` (+ P2 `claude/p2-research-execution`, P3
   `claude/p3-planner-residuals` when they report) after `test:impacted`; release.
3. Production decisive test: create the 10 goals in production (operator path or
   Goals workflow `create` with `--admin`), watch research complete, grade.
