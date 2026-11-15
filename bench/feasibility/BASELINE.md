# feasibility — baseline

Run on `origin/production` @ `6fdb3ec` (code under test unchanged on `evo/bench` @ `10ab0a0`),
2026-11-15, `npm run bench -- --suite feasibility`. Deterministic: two runs read identical
verdicts (`tests/benchFeasibility.test.ts`). About 4 s of judging (three reconstructions
take 3.9 s of it).

| metric | value |
|---|---|
| cases | 67 (49 REFUSE, 18 negative controls) |
| accuracy | **0.881** (59/67) |
| falseAccept | **0.163** (8 of 49 hypotheticals treated as available) |
| falseRefuse | **0.000** (0 of 18 valid openings refused) |
| errors | 0 |

Per class: UNFUNDED_DEAL 0.90 · PREPAYMENT_UNEVIDENCED 0.83 · CAPABILITY_NOT_HELD 0.82 ·
UNKNOWN_AS_FAVOURABLE 1.00 · CONSTRAINT_RELAXED 0.92 · AWARD_AS_REPEATABLE 0.67 ·
ESTIMATE_AS_EXECUTABLE 1.00.

## Findings: the cases the current code fails

The cases were written from the invariants and production defects they cite, and were not
edited after this run. Every failure is a false accept.

| case | class | what the code does |
|---|---|---|
| `unfunded-03-proven-price-unfunded-cost` | UNFUNDED_DEAL | `unfundedDeal` exempts any pathway whose price is PROVEN, so a $38,000 supplier cost against a $3,000 ceiling, with no terms showing the buyer pays first and capital tied up unknown, leads the portfolio. A proven price says the buyer pays; it does not say who fronts the cost. |
| `prepay-05-negated-deposit` | PREPAYMENT_UNEVIDENCED | `timingOfText` matches the word "deposit" before it reads "invoiced on delivery": "No deposit is required; the full amount is invoiced on delivery" reads PREPAID, so the financing lever may fund it. |
| `prepay-06-negated-advance` | PREPAYMENT_UNEVIDENCED | Same pattern: "Payment in advance is not accepted; net 15 from delivery" reads PREPAID. A before-delivery phrase beats an after-delivery one and negation is not read. |
| `capability-07-unfulfillable-leads` | CAPABILITY_NOT_HELD | `combine` excludes CLOSED, NO_MARGIN and unfunded pathways, not NO_SUPPLIER: an installation nobody is named to do (and Brain cannot do) is the leading combination. |
| `capability-10-brain-named-for-electrical` | CAPABILITY_NOT_HELD | `pathwayOf` takes the card's `fulfillmentOwner` at face value: a card that writes "Brain" for licensed EV-charger installation is PROVEN-fulfilled and the pathway is executable. `brainProduces` is consulted only when nobody is named. |
| `constraint-10-over-capital-leads` | CONSTRAINT_RELAXED | The pathway carries OVER_CAPITAL ($1,200 against $375 per arrangement), but `combine` checks only the $3,000 total, so it leads anyway. |
| `award-02-estimated-repeat` | AWARD_AS_REPEATABLE | A solicitation with an estimated repeat volume (`repeatable` true, as `goalScenario` sets it from a RECOMMENDATION volume) reads frequency "repeats"; `competitiveAward` does not stop it. |
| `award-03-engine-repeat` | AWARD_AS_REPEATABLE | The engine counts deals p90 = 3 for the same award: each further award is a separate competition, not a repeat sale. |

## What the suite drives

All real exported paths, no re-implementation: `readPathways` (→ `pathwayOf`,
`livingPortfolio`, `informationValue`), `byCollectibility`, `prepaymentEligible`,
`bestCaseReach`, `evaluateGoalPortfolio` (seeded, `knowledge: null`, causal off) and
`reconstructPlan` (inline evaluator, exploration off). The reconstruction's plausibility
flags (RETURN, DEALS, MARKET, HEADROOM, SCALE) are computed inside `reconstructPlanOn`'s
closure and have no pure export, so they are read from the reconstruction's own readings
(`reconstruction.best`), not called alone.
