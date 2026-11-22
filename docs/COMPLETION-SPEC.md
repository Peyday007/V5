# Completion specification — version 1

**Status:** authoritative. Owner's critical correction, recorded 2026-11-21 (§114 in
`docs/ARCHITECTURE-RECORD.md`). Where any other document, test, verdict or report
says what "done" means for Brain's commercial planning, this file decides.

## 1. The standard

> Brain reliably produces economically credible, research-backed, AI-executable
> commercial plans across unfamiliar financial objectives, industries, capital
> levels, deadlines and constraints.
>
> **Target: at least 90% PLANNING RELIABILITY across a representative,
> independently evaluated set of unfamiliar objectives.**

What it does **not** mean:

- that every business Brain plans has a 90% chance of making money;
- that every target an owner names is achievable;
- that a test project needs permission to contact buyers.

Planning correctness and financial-outcome probability are two different
measurements and are kept apart. Evaluation is never weakened to make either one
pass.

**The 90% financial-reach "ACCEPTED" verdict on an individual goal**
(`RECOMMENDATION_POLICY.requiredProbability`, `judgeAcceptance` in
`server/services/goals/plan.ts`) **is a financial-outcome reading and NOT the
completion standard.** It says how likely one plan is to collect one target; it
says nothing about whether Brain plans correctly. No completion claim may be made
or refused on it.

## 2. A correct planning result

For one objective, a planning result is correct when it is one of:

- **(A) a defensible executable plan supported by adequate evidence** — every link
  of the plan's chain (a reachable buyer, current demand, an evidenced offer and
  price, measured or agreed conversion, enough market volume, an established
  fulfiller, known economics inside the limits, cash that settles before the
  deadline) rests on evidence, and the plan's cautious arithmetic carries the
  target; or
- **(B) a justified conclusion that no executable plan is yet established**, which
  identifies the decisive missing evidence or the infeasible condition.

(B) counts only when its reasoning is validated: it must name the blocker the
evidence actually decides. A generic refusal, unproductive research, or failing to
find opportunities is not a correct result.

Every executable plan must also:

- respect the objective's constraints — capital, deadline, named industry,
  recurring-revenue unit, owner hours;
- use sound economics — no member whose direct cost meets or exceeds its price, and,
  when the objective counts money kept (net settled cash, profit, contribution), the
  deals the plan counts must keep the target after their direct costs, agreed deals
  included — a plan that reaches a net target only on gross revenue is unsound;
- need minimal routine owner labour — inside the hours the objective allows;
- rest on no assumption counted as evidence (invariant 39).

## 3. Case outcome classes

Every case run ends in exactly one correct outcome or one or more failure classes.

| class | meaning | critical |
|---|---|---|
| `EXECUTABLE_PLAN_CORRECT` | expected (A); the planner gave an executable plan that passes every check in §2 | — |
| `NO_PLAN_JUSTIFIED_CORRECT` | expected (B); the planner concluded no plan and named the decisive blocker | — |
| `FALSE_EXECUTABLE` | the planner called a plan executable where none is established | yes |
| `UNJUSTIFIED_REFUSAL` | the planner concluded no plan where one exists, or its no-plan conclusion names the wrong blocker or none | no |
| `CONSTRAINT_VIOLATED` | an executable plan breaks a constraint: an out-of-scope opening, capital over the limit, cash collected after the deadline | yes |
| `UNSOUND_ECONOMICS` | an executable plan uses a member whose cost is at or over the case's economics bound, or, under a net objective, the deals it counts keep less than the target after their direct costs | yes |
| `UNCERTAINTY_AS_FAVOURABLE` | an executable plan rests on an unestablished price, cost, capital or settlement, or on a price that is only a person's word or is contradicted by other evidence | yes |
| `OWNER_LABOR_EXCEEDED` | an executable plan needs more owner hours than the objective allows | yes |
| `OBJECTIVE_CHANGE_IGNORED` | after the objective changed, the plan still follows the old one (its scope or its target) | yes |

A critical failure would send Brain executing a wrong plan; an unjustified refusal
loses value but commits nothing. The suite reports both, and the critical count is a
guard that may not regress.

## 4. The metric

```
planning reliability = passed cases ÷ cases run
```

reported **with its denominator** and the **Wilson 95% score interval** of that
proportion (`wilson` in `server/services/cash/goalScenario.ts`, z = 1.96). This is
arithmetic on the cases run — never an invented confidence, never weighted, never
extrapolated beyond the case set. A malformed or erroring case counts as run and
failed; it is never skipped.

The standard is met when accuracy ≥ 0.90 on a representative, independently
evaluated set (public plus hidden cases) with zero critical failures. A result is
always quoted in the form "passed/run = accuracy (Wilson 95% low–high)", with the
SHA it was measured on.

### Coverage dimensions

Every case is tagged on each dimension, and the public set covers every value:

| dimension | values |
|---|---|
| capital | none · small · large |
| target | small · medium · large · out-of-reach |
| deadline | short (≤ 14 days) · long |
| industry | the opening's industry (the public set spans 20+) |
| mechanism | the `CASH_MECHANISMS` value |
| autonomy / owner hours | unlimited · owner-hours-limited |
| missing evidence | the chain link whose evidence is missing, or none |
| contradictory evidence | true · false |
| objective changed mid-plan | true · false |

### Familiar and held-out

- **Familiar** cases use the sectors and mechanisms of Brain's existing fixtures
  (`tests/planTransfer.test.ts`, `bench/feasibility/cases.ts`): property management,
  dental practices, restaurant equipment, commercial cleaning, farm grant planning,
  credit-union reports, roofing lead lists, corporate gifts, HVAC, records
  digitisation.
- **Held-out** cases use industries and mechanisms none of those fixtures use. The
  suite reports `accuracy.familiar` and `accuracy.heldOut` separately, so a planner
  fitted to its fixtures is visible as the gap between them.
- **Hidden** cases are not in the repository. Another agent authors them; they live
  in Brain's database and are read only by the evaluator. They count as held-out.

## 5. The suite: `planningReliability`

Declared in `server/domain/evolutionSuites.ts` (primary metric `accuracy`, HIGHER,
target 0.90, guard `criticalFailures` LOWER with tolerance 0). Runner:
`bench/planningReliability/`, dispatched by `npm run bench -- --suite
planningReliability [--cases hidden.json] [--out result.json]`.

For each case the runner files the case's openings on a database of its own (a copy
of one migrated template with Cash Mode on and Brain's deliverables proved, as the
server proves them at boot), creates the goal from the objective's words through
`createGoal`, changes it through `changeObjective` when the case says so, and reads
**the real planner**, `readGoalPlan`. The grader (`bench/planningReliability/grade.ts`)
then judges the reading against the case's rubric in code:

- **the planner's stance** is read from its own verdicts: executable when it holds a
  candidate and the plan is accepted, quantitatively constructed, or the chosen
  strategy's chain is complete (`chainComplete`); no plan otherwise. NOT_SUPPORTED's
  constraints to relax, each strategy's failed constraints and the chain links the
  planner judged missing are what a no-plan conclusion names.
- the grader **never reads reach against 90%**: a complete chain at 12% reach is an
  executable plan; an incomplete chain at 99% coverage is not.

Metrics: `accuracy`, `wilsonLow`, `wilsonHigh`, `passed`, `cases`,
`criticalFailures`, `errors`, `accuracy.familiar`, `accuracy.heldOut`, and
`failures.<CLASS>` for each failure class.

## 6. Case format

A case is one JSON object (`PlanningCase`, `bench/planningReliability/case.ts`). A
hidden case is added in exactly this shape with `brain_operator_add_hidden_case`
(`suite: "planningReliability"`, at most 20,000 bytes, `id` a short identifier) and
read back by `npm run evolution -- hidden --suite planningReliability`; the evaluator
passes them to the runner with `--cases`.

```jsonc
{
  "id": "ho-07-translation-owner-hours-exceeded",
  "heldOut": true,
  "description": "why the rubric's answer is the correct one",
  "dimensions": {
    "capital": "none", "target": "small", "deadline": "long",
    "industry": "immigration law", "mechanism": "CAPABILITY_ARBITRAGE",
    "autonomy": "owner-hours-limited", "missingEvidence": "none",
    "contradictoryEvidence": false, "objectiveChanged": false
  },
  // The owner's words; a goal is created from them exactly as a person's would be.
  "objective": "Collect $4,000 of settled cash within 30 days with no more than 3 hours a week of owner time.",
  // Optional: the plan is read once, the objective changed to these words, and the second reading graded.
  "changedObjective": "…",
  "openings": [
    {
      "key": "translation",                  // the case's own name; the rubric names openings by it
      "title": "Certified document translation for immigration law firms",
      "mechanism": "CAPABILITY_ARBITRAGE",    // a CASH_MECHANISMS value
      "industry": "immigration law",
      "payer": "Immigration law firms",       // null: nobody established who pays
      "channel": "…",                         // null: nobody established how to reach them
      "signalDaysAgo": 3,                     // null: no dated buying signal
      "price": 400,                           // USD a deal (a month, with "monthly": true)
      "priceBasis": "EVIDENCE",               // or "PERSON": somebody only said so
      "priceContradiction": 40,               // optional: the sourced price contradicts the card's
      "cost": 0,                              // omitted or null: unknown
      "capital": 0,                           // money tied up before it pays
      "daysToCash": 7,                        // omitted or null: unknown
      "hours": 6,                             // hours a deal
      "performer": "OWNER",                   // BRAIN | SUBCONTRACTOR | OWNER | NOBODY
      "subcontractor": "…",                   // the named fulfiller, with SUBCONTRACTOR
      "volume": "…", "volumeBasis": "EVIDENCE", // or "ESTIMATE": Brain's own, establishes nothing
      // The offer's own measured commitments, in the unit they were counted against (below).
      "conversion": { "paid": 40, "of": 400, "unit": "VISITORS" },
      "agreements": [400, 400]                // written buyer acceptances held, USD each
    }
  ],
  "expect": {
    "verdict": "NO_PLAN",                     // or "EXECUTABLE_PLAN"
    // NO_PLAN only. INFEASIBLE: constraints DEADLINE | CAPITAL | TARGET | OWNER_HOURS, with optional
    // alternative links that carry the same constraint. MISSING_EVIDENCE: links from REACHABLE_BUYER,
    // CURRENT_DEMAND, OFFER_AND_PRICE, CONVERSION, MARKET_VOLUME, FULFILMENT, ECONOMICS, SETTLES_IN_TIME,
    // optionally on one opening.
    "blocker": { "kind": "INFEASIBLE", "constraints": ["OWNER_HOURS"], "links": ["FULFILMENT"] },
    "mustNotUse": ["…"],                      // openings a correct plan may not use
    "capitalMax": 0,                          // USD one member may tie up
    "ownerHoursMax": 13,                      // owner hours the plan's members may take in all
    "maxCostShare": 1,                        // a member's cost may be at most this share of its price
    "targetAfterChange": 1500                 // with changedObjective: the target the new words state
  }
}
```

A conversion carries its real unit, and the world writes it on the card's
`conversionRates` field in that unit's own words (`conversionSentence`,
`bench/planningReliability/case.ts`), never restated as visitors:

| `unit` | written as |
|---|---|
| `VISITORS` (the default) | "40 paid pre-orders from 400 unique visitors" |
| `QUOTES` | "6 wins from 40 quotes" |
| `PROPOSALS` | "3 bookings from 18 proposals" |
| `BIDS` | "2 contracts won from 15 bids" |
| `CLICKS` | "11 bookings from 138 clicks" |
| `CONTACTS` | "5 agreements from 60 contacts" |
| `MEMBERS` | "18 orders from 14,000 members" |

A conversion without a `unit` is VISITORS, and the format's first spelling,
`{ "paid": 40, "visitors": 400 }`, still reads as VISITORS, so every case written
before units existed reads exactly as it did. Before this, every conversion was
written as pre-orders from unique visitors: "6 wins from 40 quotes" reached the
planner as 40 visitors, fell under the landing-page visitor floor
(`INBOUND_MIN_VISITORS`, pinned by `tests/inboundBuyerValidationA10K.test.ts`) and
was graded as a refusal the evidence would not cause. The floor is the planner's and
stays; the bench was misstating the evidence.

The rubric is written from the arithmetic and the evidence the case files, never from
what the planner answers today. A case the planner fails is a measurement, recorded
in `bench/planningReliability/BASELINE.md`; it is never edited to pass, and neither is
the grader.

## 7. The fast development loop: `npm run loop`

An agent changing reasoning code gets a verdict in minutes, without a deploy:

```
npm run loop                                   # this tree vs origin/production
npm run loop -- --cases held-out.json          # plus held-out cases (repeatable; never committed)
npm run loop -- --base <ref>                   # vs another base
npm run loop -- --merge branchA,branchB        # several origin branches merged together
```

It runs `tsc --noEmit`, `test:impacted --base <base>` and the suite on this tree
concurrently when the machine's available memory holds all three (else the bench
follows the other two), diffs the suite's result against the base's case by case
(`bench/diff.ts`), and prints one block: **PASS**, or **REJECT** with every reason —
a failed stage, a REGRESSED case, a NEW CRITICAL failure (a critical class a case did
not carry before, even one that was already failing), or a baseline case that did
not run — then each stage's elapsed time. Exit 0 PASS, 1 REJECT, 2 the loop could not
run. Changed cases are listed with their verdict before → after and the grader's
reason; a hidden case shows its id and verdict only.

- **The runner is parallel.** `npm run bench` runs planningReliability's cases on a
  pool of case processes (`bench/planningReliability/pool.ts`; default cores − 1,
  bounded by half the available memory at 2 GB a worker; `--workers 1` is serial,
  `BRAIN_BENCH_WORKERS` overrides). The template is migrated once; every case, in any
  worker, opens its own copy, so a parallel run gives the serial verdicts
  (`tests/benchLoop.test.ts`). Nearly all of a run is the planner itself
  (`readGoalPlan`, mostly `quant/reconstruct.ts`), not setup: template and boot are
  ≈5 s of a 430 s serial run. `--baseline prior.json` prints the same diff for any
  bench run; `--only id,id` narrows one; the result carries per-case `ms`, `verdict`,
  `failures`, `critical` and (public only) `reason`, and a top-level `timing`.
- **The base result is cached** per base SHA, runner files and held-out case set in
  `<git-common-dir>/brain-loop/baselines/` (shared by all worktrees, never committed;
  `BRAIN_LOOP_CACHE` overrides). A miss computes it once on a clean detached worktree
  of the base. A base that predates the parallel runner is given this checkout's
  runner files only (`RUNNER_FILES` in `scripts/loop.ts`) — never its cases, grader or
  world — so both sides are measured by one runner.
- **Integration mode** makes a temporary worktree at the base and merges the branches
  in order. The first conflict stops it, naming each file and the branch pair (an
  earlier branch that touched the file, or the base). Otherwise it runs the same loop
  on the combination and attributes each regressed case to the first branch whose
  prefix of the merge order produces it (re-running only those cases). Its worktrees
  are removed afterwards.
- **It is level A (developmental) feedback, and it prints so.** It is the same runner
  and public cases the evaluator uses, on this machine. It is not the evaluator's
  verdict on hidden cases (§111) and never production verification.

On a shared 4-core machine, under `flock` and beside another worker's runs, the
public suite took 433 s serially and 196 s on 3 workers. With the base result cached,
a no-op change's loop took 195 s and a two-branch `--merge` 206 s; with it uncomputed,
343 s. On PR #1214's diff against its parent (with 21 held-out cases) the bench
verdict — 25 IMPROVED, 0 REGRESSED, critical 6 → 0 — took 409 s after a 613 s base;
its impacted selection was 107 planner test files, which is the slow stage of a wide
change and is why a selection over 12 files runs after the bench, not beside it.
