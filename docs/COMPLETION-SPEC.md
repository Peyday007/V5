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
| `NON_PURCHASE_PRICE` | the reading counts (candidate, quant best or pathway leading combination) an opening at an established price the rubric's `notAPurchasePrice` says is not a payment for the deliverable — a reward, bounty, grant, prize, rebate, settlement, a price from another buyer's claim — whatever its stance | yes |
| `PAYER_POPULATION_INFLATED` | the reading counts an opening and models more deals from it (quant demand p90, or the deals its strategy counts) than the rubric's `payerDealsMax` allows: one organisation swept as a population | yes |
| `UNSUPPORTED_REACH` | the candidate reports reach above zero while a member of it is one the reading itself says cannot transact (no reachable buyer, no offer and price, nobody to fulfil it) | no |
| `ACCEPTANCE_UNFEASIBLE` | the reading accepts, certifies a probability or a quantitatively constructed plan, or calls a plan executable, while it holds a member it judges unacquirable, unfulfillable or unpaid, or one priced by a non-purchase | yes |

The last four (audit 2026-11-23, `docs/audits/2026-11-23-10k-plan-audit.md`; cases
`bench/planningReliability/mechanismCases.ts`) are read from structured fields only
(`observeMechanism`) and fire only where the reading counts the money: a conclusion that
judges the price missing, or does not count the opening, is not failed for them.

A critical failure would send Brain executing a wrong plan; an unjustified refusal
loses value but commits nothing. The suite reports both, and the critical count is a
guard that may not regress.

## 3a. The end-to-end level: a complete, AI-executable plan

The verdict level above judges what the planner concluded. The end-to-end level
judges whether what it produced can be carried out. It is graded by the same
grader (`gradeE2E` in `bench/planningReliability/grade.ts`) from the same reading
(`observeExecution`: the plan's `steps` with their `executor` records, its
strategies, considered and excluded openings, next tests, sales, research
priorities, infeasibility and the portfolio's per-member economics) — never from
prose. It is reported **beside** the verdict level, never folded into it: a case's
`pass`, `outcome` and `failures` are the verdict level exactly as in §3, so the
history stays comparable.

A case passes end to end when its verdict is correct **and**:

- **an executable plan is complete** — its steps include reaching buyers (a REACH or
  OFFER step whose operation sends: unless written agreements already cover the
  target), fulfilment (a DELIVER step), collecting payment (a COLLECT step) and,
  when a subcontracted member has a direct cost, paying the supplier (an ORDER step,
  or a delivery step that makes the payment);
- **every step is executable** — it names who performs it (Brain, a provider, or the
  owner; never CAPABILITY_MISSING or NOT_ESTABLISHED), through capabilities Brain's
  registry declares; the fulfilment step's performer is the fulfiller the evidence
  names (Brain only where the evidence says Brain delivers it, §39/§42); it states
  its cost, its day, the step it follows (for an order, delivery, collection or
  repeat) and the evidence it rests on;
- **the money steps are inside the deadline** — collecting payment and paying the
  supplier are scheduled, on or before the goal's last day;
- **the owner does no routine work the objective gives no hours for**;
- **the steps use the economics the strategy was judged on** — a delivery step's
  modelled cost and any price a step states lie within the member's judged range
  (`portfolio.demand`: price, `costHeld`);
- **a no-plan conclusion says what would resolve it** — a next test, sale or research
  priority (RESEARCH_FIRST or LEARN_WHILE_EXECUTING) measuring the decisive blocker's
  link, or, for an infeasible goal, a relaxation of the constraint with a suggestion —
  and **shows it compared the alternatives**: where openings existed, at least one
  strategy and at least one opening considered or excluded;
- **every opening research filed is accounted for** — considered or excluded.

| end-to-end class | meaning |
|---|---|
| `VERDICT_INCORRECT` | the verdict level failed |
| `NOT_OBSERVED` | no execution reading was observed (an erroring case) |
| `CHAIN_STEP_MISSING` | no step for buyer reach, fulfilment, payment collection or supplier payment |
| `STEP_FIELD_ABSENT` | the planner's output does not carry a field the rubric needs (listed as `gaps`) |
| `STEP_PERFORMER_UNESTABLISHED` | a step nobody performs |
| `BRAIN_CAPABILITY_NOT_HELD` | Brain performs a step through an undeclared capability, or fulfils work the evidence gives to someone else |
| `PERFORMER_MISMATCH` | the fulfilment step's performer is not the fulfiller the evidence names |
| `STEP_COST_UNESTABLISHED` | a step whose cost is null |
| `STEP_UNSCHEDULED` | an execution step with no day |
| `STEP_DEPENDENCY_ABSENT` | an order, delivery, collection or repeat step names nothing it follows |
| `MONEY_STEP_OUTSIDE_DEADLINE` | collection or supplier payment unscheduled or after the deadline |
| `OWNER_ROUTINE_WORK` | routine owner work where the objective allows no owner hours |
| `ECONOMICS_DRIFT` | a step's cost or price outside what the strategy was judged on |
| `RESOLUTION_ABSENT` | a no-plan conclusion names nothing that would resolve its blocker |
| `ALTERNATIVES_NOT_COMPARED` | a no-plan conclusion compared no strategy and considered no opening |
| `OPENING_UNACCOUNTED` | an opening neither considered nor excluded |
| `ESTIMATES_CONTRADICT` | the pathway portfolio's net p10 and the simulated adverse quantile, both capped at the gap, differ more than twofold and by more than a tenth of the gap (on production it is true of most readings, so it is measured here rather than in the verdict) |

**A field the planner does not carry is a measured gap, never a guess.** `PlanStep`
carries a `basis` label but no reference to the rows or claims a step rests on
(`step.evidence`), no price on the step that sells (`step.price`) and no hours on a
step the owner performs (`step.hours`). Each is recorded as `STEP_FIELD_ABSENT` with
the field in `gaps`; when the planner adds the field (`evidence: string[]`,
`price: number`, `hours: number` on `PlanStep`) the grader reads it and the gap
closes by itself. `e2e.passedBarFieldGaps` counts the cases that would pass end to
end but for those fields.

Metrics: `e2e.passed`, `e2e.accuracy`, `e2e.wilsonLow`, `e2e.wilsonHigh` over the
same denominator as `accuracy`, `e2e.passedBarFieldGaps`, and
`e2e.failures.<CLASS>`. Each case result carries `e2e: { pass, failures, gaps }`
(and its reason, for a public case only).

## 3b. The owner-usable level

The owner's measure (2026-11-24): on a feasible request, does Brain return a plan he could
start without supplying the strategy or repairing it? The verdict level reads the
planner's own stance, which calls a plan executable only once a close rate is measured or
buyers have agreed — never true of a fresh request — so a startable plan was scored a
refusal. `gradeUsable` (`bench/planningReliability/grade.ts`) grades it beside the other
two levels and never into them: on an `EXECUTABLE_PLAN` case a reading passes when no
critical class fires, nothing is infeasible or broken, some opening has every chain link
established but CONVERSION (or the stance is executable), and the end-to-end chain holds
(absent fields and contradicting estimators aside). A `NO_PLAN` case passes it exactly as
it passes the verdict level. Metrics `usable.passed`, `usable.accuracy`,
`usable.wilsonLow/High`; each case carries `usable: { pass }`; the diff report prints its
recovered, regressed and net percentage points, and rejects a case that loses it.

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
`failures.<CLASS>` for each failure class; beside them, the end-to-end level's
`e2e.*` metrics (§3a).

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
      "priceEvidence": "…",                   // optional: what the price's source says, filed as the price fact (must restate the price)
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
    "targetAfterChange": 1500,                // with changedObjective: the target the new words state
    "notAPurchasePrice": ["…"],               // openings whose evidenced figure is not a purchase of the deliverable
    "payerDealsMax": { "…": 1 }               // the most deals an opening's payer(s) can make in the window
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
