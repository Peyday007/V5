# planningReliability — baseline on production code

Measured 2026-11-21 on `a9f89fd5e` (the planner is production's `a743dc79d`
unchanged; this commit adds only the suite), public cases only:

**19/35 = 54.3% (Wilson 95% 38.2%–69.5%)** · critical failures 5 · errors 0 ·
familiar 12/18 = 66.7% · held-out 7/17 = 41.2%.

The first run, before the grader read the planner's "cannot reach the N still
needed" constraint as TARGET, scored 18/35 (ho-15 failed on the grader, not the
planner); the run above is the recorded one. Neither the planner nor any rubric was
changed to pass. Each failure is a finding:

| case | class | what the planner did | where |
|---|---|---|---|
| fam-01, ho-01, ho-06, ho-11 | UNJUSTIFIED_REFUSAL | every link evidenced, but the cautious figure falls short: a repeatable play offers `ceil(gap/price) × OUTREACH_MULTIPLE` (4) buyers whatever the measured close, so a 10% close never reaches the target though 400+ buyers are evidenced | `server/services/cash/goalScenario.ts:2916` (`dealsForGoal`), read by `conservative`, `server/services/goals/plan.ts:998–1008` |
| fam-12, ho-09, ho-16 | UNJUSTIFIED_REFUSAL | agreements cover the target (no new deal needed), but `conservative` returns null because a one-off's volume (1, ASSUMPTION) is not established | `server/services/goals/plan.ts:1005–1007` |
| fam-16 | UNJUSTIFIED_REFUSAL | two signed $8,000 lots, sequential, inside a $10,000 limit: exposure is summed as if both were tied up at once (16,000 > 10,000) | `server/services/goals/plan.ts:1010` (and the engine's "every tested case" capital count) |
| ho-07 | FALSE_EXECUTABLE (+UNCERTAINTY_AS_FAVOURABLE) | 10 owner-performed agreed deals at 6 h need 60 owner hours against 13; labour counts only new deals won, never agreed ones | `server/services/goals/plan.ts:1011` |
| fam-08, fam-14, ho-02 (and ho-07) | UNCERTAINTY_AS_FAVOURABLE | the chain-complete plan's candidate is the quant portfolio's best combination, which carries a constructed arrangement (`arr_…`) whose price nobody established | `server/services/goals/plan.ts:1127–1130` (candidate from `portfolio.best` members) |
| fam-07, ho-13 | UNJUSTIFIED_REFUSAL (contradiction unseen) | the card's price is read with the price fact's provenance; the fact's own figure (10× lower) is never compared, so the contested price reads as evidence and the conclusion names no price gap | `server/services/cash/goalScenario.ts:2134–2136` |
| ho-10 | UNJUSTIFIED_REFUSAL (unsound economics unseen) | a $2,300 cost against a $2,000 price passes ECONOMICS: when cost and capital are stated, the link checks only that the cost is evidenced, never that it is under the price | `server/services/goals/plan.ts:874` (`economicsState`) |
| ho-14 | OBJECTIVE_CHANGE_IGNORED (+UNJUSTIFIED_REFUSAL) | `changeObjective` rewrites the words; scope is re-read from them, but the stored target stays $3,000 one-time instead of the new $1,500 a month | `server/services/goals/decide.ts:343` |

Reproduce: `npm run bench -- --suite planningReliability --out result.json`
(~20 minutes when this baseline was recorded; each case reads `readGoalPlan` on its
own database). Cases now run on a pool of case processes — 433 s serial, 196 s on 3
workers on a shared 4-core machine — and `npm run loop` diffs a change against this
suite's result on production (docs/COMPLETION-SPEC.md §7).

## Mechanism validity (audit 2026-11-23) — measured on production `1ce9b9874`

The audit of the production $10K plan (`docs/audits/2026-11-23-10k-plan-audit.md`)
found failure classes the grader could not see. `mechanismCases.ts` reproduces them
(mv-01…05); nine unfamiliar-mechanism pairs (commission, affiliate, contract award,
grant, prize, rebate, one-RFP, settlement) are hidden cases, not in the repository.
Each was run on unmodified production planner code through the grader as it stood
(`a`) and as extended (`b`); public cases only below.

| case | class it reproduces | grader before (a) | grader after (b) |
|---|---|---|---|
| mv-01 GitHub bug-bounty reward as price | non-purchase price, single payer, no channel/fulfiller | FAIL `UNJUSTIFIED_REFUSAL` (names REACHABLE_BUYER…, not the price) — the counted $10,000 unseen | FAIL `UNJUSTIFIED_REFUSAL`, `NON_PURCHASE_PRICE` (pathway leading combination counts GitHub at $10,000) |
| mv-02 bounty payout as price, all else evidenced | non-purchase price | FAIL `UNJUSTIFIED_REFUSAL` (names MARKET_VOLUME) | FAIL + `NON_PURCHASE_PRICE` (candidate at $500, reach 0.98 coverage) |
| mv-03 one health system's one PO | single payer as population | **pass** (names MARKET_VOLUME) | FAIL `PAYER_POPULATION_INFLATED` (deals p90 14, reach 0.62) |
| mv-04 marketplace, many repeat buyers (control) | — | FAIL `UNJUSTIFIED_REFUSAL` (planner) | same |
| mv-05 price spliced from an HVAC-software claim | unevidenced mechanism | FAIL `FALSE_EXECUTABLE` | FAIL `FALSE_EXECUTABLE`, `NON_PURCHASE_PRICE`, `ACCEPTANCE_UNFEASIBLE` |

The existing 35 public cases all passed (a). Under (b) two fail, non-critically,
on `UNSUPPORTED_REACH`: fam-15 (reach 1.000 from the farm opening nobody can
fulfil) and ho-03 (reach 0.711 from maritime, with no way to the buyer). The
pathway p10 and the simulated adverse quantile contradict each other in 17 of the
35 (fam-02: adverse $4,862 against a pathway p10 of $10 on a $2,000 gap; the
pathway estimator does not count signed agreements), so `ESTIMATES_CONTRADICT` is
graded on the end-to-end level, not the verdict.
