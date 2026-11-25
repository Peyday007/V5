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
- Decisive-10 (`d01–d10`, sealed routes unread), local harness, real web research,
  one discovery round + one validation-dive round (20 dives):
  - every goal was read and every goal's round produced routes (31 openings, 1–4
    modelled strategies per goal; before the route work: 0 modelled);
  - by Brain's own owner-usable standard (every link but CONVERSION established):
    **1/10** (d03: bid a live Michigan local-government wage study through MITN;
    price, payer, channel, fulfiller, settlement and market size all sourced);
  - the dives exposed readers that dropped evidence research had filed, all fixed
    (`tests/decisiveReaders.test.ts`): payer heads with a parenthesised kind
    list; per-unit-of-work rates a platform pays suppliers; the dive's dated
    current-demand answer never reached the buying signal (no column);
    payout schedules ("end of every workday", weekly, monthly + lag); stated
    no-fee costs; one-time costs read per deal; per-unit-per-month prices;
    award words before a qualified service ("grant prospect research");
  - after the fixes the remaining open links are research gaps, not reading
    defects: market size for the owner's own geography (d01, d02, d04), hours of
    a subcontracted fulfiller (d02, d05, d06), demand dated in the window
    (d01, d04, d05), owner capital of zero against a route that needs setup
    money (d07), inventory capital over the owner's limit (d08). Each needs a
    second research round, which Brain opens itself (`next`).
- Research budget: the local evaluation's web-search allowance (200 searches per
  session) was exhausted by the 20 dives, so further local rounds cannot run in
  this session. The decisive test's next rounds must run on production research.
- P2 (production research): stuck fragments were released forever with no attempt
  charged (1,255 released vs 746 succeeded in 6h), holding each project's grant
  slots; owner-directed goals were a hard-coded list. Both fixed (`87d4a433`,
  `3eee7672`).
- P3 (supplied routes): 33 → 40 / 40 owner-usable, 0 regressions; all 80 cases
  69 → 76 (`0ba2ef69`).

## 5. Next executable actions

1. Release the integrated branch (`claude/p1-route-synthesis`, P2 and P3 merged)
   after `test:impacted`; verify on production that free-lane releases fall and
   goal rounds harvest.
2. Decisive-10 round 2: Brain's own recovery rounds (`e2e.mts next`) on the nine
   goals without a usable plan — on production research (local search budget is
   spent); grade all ten with the independent grader (`GRADER-BRIEF.md`).
3. Production decisive test: create the 10 goals in production (operator path or
   Goals workflow `create` with `--admin`), watch research complete, grade.

## 6. Brain-created opportunity audit and the research-informed route loop (2026-11-25, evening)

**Audit (owner's request: which opportunities Brain created vs discovered, and how many are complete).**
Fresh read of dec1125 at about 16:00Z (serving 74691c7): 55 openings across 10 goals. All 55 are
Brain-created route proposals; none was discovered as an existing contract or listing. Not one
carries an EVIDENCE fact. At best 2 of 8 plan links are established (the buyer can be reached, and
a fulfiller is named). **Complete and credible: 0 / 55.** Research orchestrations had been
RESEARCHING for 2–4 h on every goal and had filed nothing (reported to the coordinator as a
blocker).

Where created opportunities could not be completed even with research, as traced in code:
- Proposals were priced, counted and costed before any research. The critique judged guesses,
  and research checked them only afterwards.
- CURRENT_DEMAND accepted only a dated buying signal for the exact offer. A new offer nobody has
  asked for by name could never establish it, even when buyers of that kind demonstrably spend on
  comparable offers now. (The price reader already accepts comparable market prices; probed
  across six industries.)
- A fixed spread was forced: at least three buyer kinds and three mechanisms, no two routes to
  one buyer type, and replacements requested until three routes survived.

**The loop (branch `claude/research-informed-routes`):**
1. **Scout.** With fewer than 3 read findings and nothing priced, the proposer names up to 5
   directions. Each gives a buyer problem, an offer from the owner's means, the comparable
   spending it expects, reach, fulfilment, and the one decisive unknown. Each is filed with
   **no price, count or cost** (`routeStage=SCOUT`).
2. **Decisive unknown first.** A scout's dive is short and ordered: the fact most likely to kill
   it comes first, then comparable price, comparable or exact demand, reach, fulfilment, cost,
   timing and count. A dead direction costs one question.
3. **Findings reach the proposer and the critic before selection.** The project's gated claims
   from read sources are listed as F1…Fn, together with each scouted direction's outcome. A fresh
   ask becomes due as soon as 3 new findings arrive, instead of after the ordinary 6 h.
4. **Grounded routes.** Every figure cites a finding or is marked as an estimate. Each cited claim
   is filed as the route's EVIDENCE through `writeEvidenceAnswer`, so the card holds the source's
   own words and figure and keeps every rule of that writer. The scouted directions that informed
   a route are archived as *superseded*, not refuted.
5. **Comparable vs verified demand.** Comparable demand has its own field and dive lane
   (`comparableDemand` / `comparable_demand`, dated or refused). CURRENT_DEMAND reads
   `VERIFIED:` for a fresh signal about this exact offer, and `COMPARABLE: … demand for this exact
   offer is not verified` for comparable demand. CONVERSION stays the market test's to establish.
6. **No forced variety.** The proposer asks for up to k routes, only as many as the evidence
   supports. The same-buyer-type rejection is removed. Replacements are requested only when no
   route survives.
7. **Rethink.** Ruled-out directions are shown with the evidence that ruled them out. The reply's
   `rethink` is recorded as a goal-scoped operator learning, and the next ask must change
   approach rather than restate.

Tests: `tests/researchInformedRoutes.test.ts` (11), with the existing route suites updated to the
new rules.

Not done in this change:
- Knowledge-library facts (Census counts by industry and geography) are not yet fed into the
  findings.
- Cross-goal lessons are kept goal-scoped. Generalising them across goals would leak between
  evaluation goals that share request text, so it waits for a fresh-request design.

## 7. First measurement of the loop (blind, 2026-11-25 ~21:00Z)

Same 10 requests. dec1125b ran on 74691c7 (before) and dec1125c on ec0131a (research-informed loop,
scouting stage only, because no research had returned). An independent grader worked blind
(shuffled labels) with GRADER-BRIEF and the sealed feasibility notes.

| | before (dec1125b) | after (dec1125c) |
|---|---|---|
| goals with ≥ 1 credible route | 5 / 10 | 6 / 10 |
| credible routes / total | 8 / 30 | 7 / 31 |
| complete plans | 0 | 0 |

- **Recovered:** p03 (legal translation for law firms), p05 (corporate holiday cookie boxes),
  p07 (loan signings; the licence rule), p10.
- **Lost:** p02 (every direction refused over a missing ownerFit field or as physical work),
  p06 and p08 (generic and design-file menus).
- **Empty in both:** p04.

The losses are fixed on `claude/route-ask-cheap` (f9290684): a review of directions before research
is spent, tolerant parsing of direction replies, and stated activity hours read as the owner's own
labour. The same branch also removes the per-pass claim read #1322 added.

No plan can complete until research returns claims: 0 evidence facts on 118 Brain-created openings
across four runs. Restoring research is the coordinator's critical-path fix.

## 8. Two-hour sprint (2026-11-25, 21:30–23:30Z)

**Direct intelligence comparison.** Blind grading against GRADER-BRIEF on the ten dec1125 goals,
with feasibility checked against the sealed notes.

| | usable plans | goals with ≥ 1 credible route | critical errors |
|---|---|---|---|
| Claude + live web search (two agents, about 4 minutes per goal) | **7 / 10** | 10 / 10 | 2 (an hours overrun; a refundable deposit counted as revenue) |
| Brain, previous build (dec1125b) | 0 / 10 | 5 / 10 | 0 |
| Brain, research-informed loop (dec1125c) | 0 / 10 | 7 / 10 | 0 |

Model choice was isolated by running Brain's identical direction prompt, graded blind:

| | goals with ≥ 1 credible direction | credible directions |
|---|---|---|
| Claude | 10 / 10 | 27 / 33 |
| gpt-oss-120b (production) | 5 / 10 | 6 / 31 |

Brain's rules and gates are not the gap. The gap is the reasoning model behind proposals and
research that can read the web.

**Production state at the deadline:**
- Keyed Google search is unconfigured: `BRAIN_SEARCH_API_KEY` and `BRAIN_SEARCH_ENGINE_ID` are
  missing. Research is left with DuckDuckGo, which refuses Brain, and Firecrawl at about 15 a day.
- Routine-bound workers are members of no evaluation project, so they were refused goal bins
  1,137 times in 6 hours.
- The claim → card fact → plan link chain was proven by the coordinator on cop_a167: 13 EVIDENCE
  facts, and three links turned. The first broken link it found (a per-unit range read as a whole
  price) is fixed in #1329.

**Shipped in batch #1330 (788142a):**
- The strong route model, inert until `ANTHROPIC_API_KEY` and `BRAIN_ROUTE_MODEL` are both set.
- A review of directions, tolerant parsing, stated activity hours read as owner labour, and the
  claim count only when needed.

**Owner prerequisites:**
1. The search secrets.
2. The Anthropic key and the model name.
3. `admin access grant` for the routine workers' project membership.
