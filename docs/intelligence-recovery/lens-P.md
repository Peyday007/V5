# Lens P: plan-read speed and the shared price pool

Repo /home/user/V5, branch claude/brain-intelligence-recovery-s0dl4l. Read-only. The scratch tests
(tests/zz-lensP-*.test.ts) are deleted. Raw outputs are in this directory: run50.json, run500.json,
recon500.json, pricepool.json and prof/*.cpuprofile.

## 1. Planning speed

### Fixture
I used `readGoalPlan({persist:false})`, the same call `goals plan` makes (scripts/goals.ts:661), on
SQLite with a 4-core local machine. The fixture had:
- 500 qualified, repeatable openings across 80 payers and 20 industries, all with prices.
- 30 seeded sectors, each with 2 buyers, 2 bottlenecks and 2 suppliers. That gives 404 constructed
  arrangements, the same count as production.
- A $10K goal over 30 days with a $3K capital ceiling.

I set `BRAIN_REASONING_THREADS=1`, which is what a 2-CPU Fly VM gets (`threadsAvailable` = cores-1).
I wrapped `getDb().all/get/run` to count statements, and stamped each `planTrace` line with the count.

### Cold read, N=500: 315.8 s in total, 166 SQL statements
| stage (plan.ts / goalScenario.ts trace) | ms | stmts |
|---|---|---|
| target + goalArrangements → constructArrangements (construct.ts:208; composeConstruction on the pool thread, 404 designs) | 8,737 | 12 |
| compose: shared frontier, live openings, lessons, cash knowledge (DB reads) | 386 | 93 |
| compose: per-opening modelOpportunity + selectEstimatedArrangements | 718 | 3 |
| compose: baseline quant portfolio (evaluateGoalPortfolio, 2000 worlds, about 1,500 activities = 500 openings × OUTREACH_SHARES[3]) | 23,469 | 0 |
| scenario engine run (runIsolated, 8-opening model) | 3,063 | 2 |
| gate: considered openings, strategies, market tests, pathways | 32 | 33 |
| **reconstruction (reconstructionFor → reconstructPlan → sweep + exploreDirections)** | **279,343 (88%)** | 1 |
| acceptance / steps / assembly | ~0 | 0 |

- **Warm re-read in the same process: 17.8 s.** Construction and exploration are memoised in
  process. The baseline portfolio is not memoised, and it costs 15.5 s on its own.
- **N=50 cold: 51 s.** Reconstruction 40.5 s, construction 6.7 s, portfolio 2.6 s, 153 statements.
- **DB load is flat in openings:** going from 50 to 500 openings adds 13 statements. There is no
  N+1, and the read-scope cache works. At 1 pool connection and ~50–100 ms per round trip, 166
  statements cost about 8–17 s of the 26 min. So DB is a minor share (Surge A).

### Inside the reconstruction (N=500, inline evaluator, timed wrapper plus `--cpu-prof`): 136.6 s
- **§99 diagnose, singles and greedy:** 19 evaluations at 150 worlds, 11.5 s. This phase has no
  time cap.
- **Variable sweep (variables.ts sweepVariables):** 51.5 s. It runs to its 60 s cap (DEFAULT_SWEEP_MS).
- **exploreDirections:** 188 evaluations at 100 worlds, 103 s (median 0.52 s each, max 1.6 s).
  It is capped at 180 s or 400 evaluations (directions.ts:71-73).
- **Total engine evaluations: 207.** Every one carries all 500 openings, because
  `movableOpenings` keeps every repeatable opening (reconstruction.ts:251).
- **The pool thread is about 2× slower than inline:** 279 s on the thread against 137 s inline.
  Two causes: each evaluate posts the full 500-opening input (structured clone), and the worker
  heap is capped at 384 MB, so it collects garbage often. With threads=1 on 2 CPUs, the
  exploration's "chunk = threads×2" runs serially. That is runtime/contention (Surge A).
- **Production ratio:** 26.7 min against 5.3 min locally is about 5×. That is consistent with
  shared vCPUs, the server process competing on the same 2 CPUs, and the thread overhead.

CPU profile, 173 s, inclusive:
- evaluateGoalPortfolio 47%
  - optimizePortfolio 24%
  - demandWorlds 13%
  - drawPicks/drawWorlds 7%. drawPicks sorts every activity's worlds on every evaluation.
- sweepVariables 24% (fastReading/evalLevels/finish)
- **garbage collector 18.5% self time**, from per-evaluation arrays: spread() sorts and Worlds objects

### Why reconstruction dominates
Each read costs worlds × activities × greedy rounds × evaluations:
- **activities** = 3 shares × every movable opening (500).
- **greedy rounds:** optimizePortfolio's greedy step (quant/portfolio.ts:968-985) evaluates every
  remaining activity in every round, so it is O(n²·worlds) in the worst case.
- **evaluations** is about 200–370.

Almost all of it recomputes inputs that did not change. A direction moves a few openings or a
limit, yet each evaluation re-draws demandWorlds for all 500 openings (goals/portfolio.ts:455).
It also re-ranks drawPicks (quant/portfolio.ts:330) and re-scores 1,500 singles. Most of the 500
openings never enter the best combination or its alternatives.

### Three highest-leverage speedups
1. **(Algorithmic, Surge B) Bound the openings the reconstruction moves.**
   - Change: in reconstruction.ts:248-252 `movableOpenings`, keep baseline best + alternatives +
     the top K (about 24) by baseline demand revenue p50 or value per contact. Today it keeps every
     repeatable opening. Pass the rest only as a reserve for an explicit INCLUDE move, which already
     exists (S-6).
   - Gain: per-evaluation cost is linear-to-quadratic in activities, so 500→24 openings is about
     20× or more per evaluation. The sweep and exploration then finish their evaluation budgets
     instead of hitting the clock.
   - Expected: reconstruction 137–279 s → ~10–20 s locally; production ~26 min → ~2–4 min.
   - The same cut applied to the baseline portfolio's activities (goalScenario.ts:1003, which
     today passes all candidates + estimates) takes the 23 s compose portfolio to about 2 s.
2. **(Algorithmic, Surge B) Memoise per-opening Monte Carlo across evaluations.**
   - Change: cache `demandWorlds(one, share, daysLeft, reach, worlds, seed)` and the activity's
     drawPicks order/picks in goals/portfolio.ts:455 and quant/portfolio.ts:330. Key them by the
     opening's content hash, because a transform changes only the openings it touches. Add a
     candidate screen in optimizePortfolio's greedy step (quant/portfolio.ts:972): try only the
     top-M by single reading, since singles are already computed.
   - Gain: about 2–3× per evaluation on top of #1, and it removes most of the 18.5% GC.
3. **(Re-evaluation; algorithmic + runtime) Make unchanged inputs free across processes.**
   - Problem: exploration is held only in a process Map (plan.ts:481, key plan.ts:1410), and so is
     construction (construct.ts:303-306 memoKey). `goals plan` and each fresh Fly machine run cold,
     so a re-evaluation with nothing changed costs the full 26 min. The baseline portfolio
     (goalScenario.ts:1034) has no memo at all: 15.5 s warm.
   - Change: persist the three results, keyed by the hashes the code already computes, on the
     goal's reading row. Then a re-read re-runs only what moved. The target is the 18 s warm path
     locally, plus the 1 s of DB reads, which meets the 30–90 s re-evaluation target.
   - Runtime side (Surge A): stop cloning the full input per evaluate. Send openings once per
     reconstruction and reference them by id, and raise or drop the 384 MB worker heap cap. That is
     about 2× while threads=1 on 2 CPUs.

DB/runtime (Surge A) is not the cost driver: 166 statements, flat. What is runtime is the thread
clone/heap overhead (2×) and the 2-vCPU contention (about 5× against local).

## 2. Price pool: confirmed, reproduced

### Where it happens
- **construct.ts:275-299.** `priced` is every held opening's price in the project, and `tiedUp` is
  every opening's `peak_funding_cents`.
- **construct.ts:545-546** (`compose`). Every arrangement gets **all** of those observations:
  `valueObs = args.priced.map(o => ({...o, broad: o.context.payer !== norm(demand.name)}))`, and
  the same for `riskObs`.
  - For an INDUSTRY_MAP buyer ("dog groomers") or a reverse arrangement ("buyers to be found"),
    no payer matches, so every observation is `broad`.
- **quant/reconstruct.ts:314-329.** With only broad observations, `a_value` takes the MECHANISM
  route: it pools *every* project price into one wide bound (SPREAD_FLOOR.MECHANISM). Every
  arrangement without its own payer evidence therefore gets the identical p10/p50/p90.
- **goalScenario.ts:196-225, 261** (`estimatedFromArrangement`). This turns the one pooled value
  into all three displayed fields:
  - price = inferred p50 (281), swept low=p10 / high=p90·widen (72,769)
  - `directCost = unknown(0, 0.6·high)` → 43,661 (0.6 × 72,769 = 43,661.4)
  - `capital = unknown(0, high)` → 72,769. The worst case is null because the MECHANISM risk
    estimate is not distributionJustified.
  - goalScenario.ts:198 refuses only tier UNKNOWN, so a MECHANISM pool passes.
- **pathways.ts:454 `factOf`.** It shows inferred.p50 as "E 281", which reads as an estimate.

### Reproduction (pricepool.json)
I created 5 held openings: Dentists $900/$1,200, Wedding planners $40/$60, Roofers $15,000.
- "Dog groomers", "Trucking dispatchers" and reverse arrangements all got **MECHANISM p50 522 /
  p90 15,708 (obs 5)**. Their fields were price high 15,708, direct 9,425 (= 0.6×), and capital
  15,708.
- Only "Dentists", whose payer matches, got its own COMPARABLE 1,039 / 1,694 from 2 observations.

### Minimal repair
1. **construct.ts:545-546.** Filter instead of tagging broad. Keep an observation only when its
   payer matches the arrangement's demand. Optionally also keep same-industry (`context.industry`)
   or a matched need; these are comparable with distance. Drop everything else; never pool it.
   Apply the same filter to `riskObs`.
   - Result: an arrangement with no matching observations reconstructs `a_value` as UNKNOWN.
2. **goalScenario.ts:196-198.** Do not lift a MECHANISM-only value into a price either.
   - Change: treat `value.tier === 'MECHANISM'` like UNKNOWN for the price. Give the arrangement
     `price = unknown(...)` with value null and no `inferred`, so pathways shows "price ? —".
     Leave capital and directCost unknown, not derived from the borrowed top price. Lines 225 and
     261 currently derive both from `high`.
   - Alternative: keep today's cut "nothing reconstructs its value".
   - The arrangement still competes as a research target, and its question already asks for the
     price (PART_ASK).
3. **Tests.** tests/goalEstimatedArrangements.test.ts builds MECHANISM-tier fixtures and expects a
   swept price. Update it to the new rule, and add a regression test: two buyer populations with
   no shared payer must not read the same price.
