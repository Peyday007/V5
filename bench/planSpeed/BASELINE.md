# planSpeed — baseline

Run on `origin/production` @ `6fdb3ec` (code under test unchanged on `evo/bench` @ `10ab0a0`),
2026-11-15, `npm run bench -- --suite planSpeed` (3 runs, 2,000 worlds, seed 11).

Machine: 4 vCPU Intel Xeon @ 2.10 GHz (1 thread per core), 15 GB RAM, Linux 6.18, Node 22.23.4.
The engine runs on the inline evaluator (one thread), so the figure does not depend on the
runner's core count; production's pool spreads the same evaluations over its threads.

| metric | value |
|---|---|
| p50ms | **18,377** |
| minms | 17,740 |
| maxms | 20,820 (run 1, includes JIT warm-up) |
| bestReach | 0.8852 (coverage of stated ranges and assumptions, not a probability) |
| reachDelta | 0 (reference 0.8852, tolerance ±0.03) |
| evaluations | 386 (reconstruction + exploration) |
| deterministic | 1 (all three runs read the same strongest plan) |

Strongest plan: `CAPACITY:cold-email-prewarmed@375 ($368 bought) + CASH_TIMING:deposit + TRANSACTION…`.

## Input

`fixture.ts`: 11 found openings and 12 constructed arrangements (one the $2.77M bureaus
deal), $10,000 to raise, 24 days, $3,000 ceiling, $375 per arrangement, $750 a week, 945
sends a day over 13 accounts, the workspace's 4,096-send campaign record. Timed: the
baseline engine reading (~0.5–0.9 s) plus `reconstructPlan` with exploration on and an
empty method library, its clocks lifted so the sweep and the exploration stop on their
budgets rather than on time.

## Where the time goes (`node --cpu-prof`, one run, 22.3 s sampled)

1. **The engine's evaluations — 59% inclusive** (`evaluateGoalPortfolio`, 386 calls):
   `optimizePortfolio`'s greedy search 35%, `evaluateWorlds` 20% (16% self).
2. **Demand world draws — 17%** (`demandWorlds` / `drawDemandWorlds`, plus `binomial`,
   `poisson`, `spread`).
3. **The variable sweep — 17%** (`sweepVariables`, `fastReading`; §102).

Garbage collection is 13% of samples across all three.
