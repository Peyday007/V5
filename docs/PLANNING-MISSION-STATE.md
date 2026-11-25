# Planning reliability mission — the one record

Owner's finish line: ≥ 27/30 fresh, feasible, independently graded goals on one frozen
production revision, zero critical errors, the owner supplying only the goal and normal
constraints. This file is the single current record; history is in
`docs/PLANNING-9-10-INVESTIGATION-2026-11-24.md` and
`docs/PLANNING-ROUTE-GENERATION-2026-11-25.md`. Update it at every milestone.

Updated 2026-11-25 05:45Z.

## Production

| | |
|---|---|
| serving revision | 48a097e (#1303) — confirmed by the evaluation run's `SERVING_REVISION` |
| releasing | 4330e85 (#1305), Postgres suite running, then Deploy; a release counts only when the Deploy run's "Deploy to Fly" job succeeds (a merge during a Deploy run marks it superseded and skips that job — happened twice on 11-25) |
| post-restart health | hosted verification 261/261 before restart on 06c31b4; the after-restart pass did not complete (restart/health — Surge A) |

## Measured results (fresh goals, objective only, production, independent judge)

| round | revision | requests | usable | critical |
|---|---|---|---|---|
| dev1 baseline | 8ba72b1 | 12 | **0/12** | 4 |
| investigation (11-24) | 406c60d | 46 | 0/46 | — |
| decisive-10 local (other session) | branch | 10 | 1/10 (Brain's own standard) | — |
| dev3 | 06c31b4 → 48a097e | 12 | not graded yet | — |

## How a fresh goal is run

`.github/workflows/planning-eval.yml` (`scripts/planningEval.ts`): `create` makes one
project + goal per request from the owner's words; `read` prints the plan, openings with
card facts, goal events and cash events; `update` applies a mid-course change. Requests
and sealed reference routes are held by the evaluator outside the repository and are
never shown to development workers; an independent judge (no code access) grades.

## What is built (all live by 48a097e unless noted)

- intake: plain-spoken deadlines, monthly income, limits; model fallback for gaps (#1299)
- route proposer: operator model proposes whole routes from the owner's words; each filed
  as one hypothesis opening; dive asks the whole route (#1298)
- route evidence join, dive lanes for volume/demand/fulfiller, goal-framed questions (#1303)
- planner residuals: register/flow market sizes, full transaction steps, regulated
  fulfillers, implausible figures withheld (#1300, #1303)
- research ordering: live goals' research first; spent synthesis rerouted (#1301);
  owner-directed goals from rows, so routines take evaluation research (#1303)
- route dives at filing, goal projects walked first, research before sale (#1305, releasing)

## Open capability gaps (from measurements)

1. route research latency: dives did not start for ~90 min on fresh projects (fixed in #1305, unverified)
2. research throughput: GPU held below its slot target by database-connection contention
   (~31–39 accepted/h; 136–161 items waiting) — Worker B
3. route proposal reliability: 3/12 goals got no routes (timeout / unparseable / silent
   refusal) — fixed in #1305, unverified
4. intake: "I don't have money to put in" not read as a zero capital limit (d02)
5. mid-course changes: not yet exercised on dev3 (d08, d12)

## Workers

| worker | task | state |
|---|---|---|
| A (integration owner, this session) | releases, merges in deploy windows | releasing #1305 |
| B | research throughput (database-connection cap on the free lane) | running |
| C (this session + independent judge agents) | fresh-goal runs and grading | dev3 waiting on research |
| other session (5NBN) | its sealed decisive-10 production run `dec1125` | asked to coordinate merges |

## Time

Measured: mission started 2026-11-25 ~00:15Z; 5.5 h to first deployed route proposer and
fixes. Estimate to verified completion: not yet defensible — needs the first graded round
with research completed (expected within ~4–8 h of #1305 release).
