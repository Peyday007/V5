# Planning reliability mission — the one record

Owner's finish line: ≥ 27/30 fresh, feasible, independently graded goals on one frozen
production revision, zero critical errors, the owner supplying only the goal and normal
constraints. This file is the single current record; history is in
`docs/PLANNING-9-10-INVESTIGATION-2026-11-24.md` and
`docs/PLANNING-ROUTE-GENERATION-2026-11-25.md`. Update it at every milestone.

Updated 2026-11-25 15:45Z.

## Production

| | |
|---|---|
| serving revision | 74691c7 (#1318), confirmed: "Deploy to Fly" succeeded and the evaluation run printed `SERVING_REVISION 74691c7` |
| release check | a release counts only when the Deploy run's "Deploy to Fly" job succeeds; merges are held while a Deploy runs |

## Measured results (fresh goals, objective only, production, independent judge)

| round | revision | requests | usable | critical |
|---|---|---|---|---|
| dev1 baseline | 8ba72b1 | 12 | **0/12** | 4 |
| investigation (11-24) | 406c60d | 46 | 0/46 | — |
| decisive-10 local (other session) | branch | 10 | 1/10 (Brain's own standard) | — |
| dev3 | 06c31b4 → a46ae60 | 12 | routes only: 3/12 goals had a credible route, and the plan preferred a weaker one in all 3 | — |
| dec1125 (other session) | a46ae60 | 10 | routes only: about 3/10 credible | — |
| dev4 | 74691c7 | 12 | created 15:37Z, read pending | — |
| dec1125b (other session) | 74691c7 | 10 | created, read pending | — |

## How a fresh goal is run

`.github/workflows/planning-eval.yml` (`scripts/planningEval.ts`): `create` makes one
project + goal per request from the owner's words; `read` prints the plan, openings with
card facts, goal events and cash events; `update` applies a mid-course change. Requests
and sealed reference routes are held by the evaluator outside the repository and are
never shown to development workers; an independent judge (no code access) grades.

## What is built (all live on 74691c7)

- intake: plain-spoken deadlines, monthly income, limits; a model fills gaps (#1299); "I don't have money to put in" reads as nothing up front (verified)
- route proposer files whole routes as hypothesis openings (#1298), with dives at filing (#1305), dive lanes and the evidence join (#1303), hours in the right units and recorded rejection rules (#1311), a goal dive tier with round-robin judging (#1314)
- route quality: the owner's profile is read first, a critique-and-revise pass runs, routes are ranked with price anchors, and the plan prefers the best-ranked unresearched route (#1317)
- owner labour: a goal whose own words offer the requester's time or assets may use routes the requester performs, within the stated hours; silence or a refusal keeps the rule (#1318)
- planner residuals (#1300, #1303); live goals researched first (#1301, #1314); synthesis read-back moved outside the transaction (#1306); fragments started only where search can feed them (#1309)

## Open capability gaps (from measurements)

1. route choice: generic menus, owner facts dropped, no fulfiller, unanchored prices (#1317 and #1318 target these; dev4 and dec1125b measure them)
2. research supply: keyed web search is limited to 100 a day and Firecrawl to 15 credits. Raising either is the owner's spending decision.
3. mid-course changes not yet exercised (d08, d12)
4. a stated licence or trade is not yet forced into at least one route (added only if dev4 shows the miss)

## Workers

| worker | task | state |
|---|---|---|
| integration owner (this session) | releases, eval rounds, merges between deploys | dev4 read at about 16:25Z |
| independent judge agents | grade routes and plans without code access | next: dev4 |
| other session (5NBN) | its own decisive-10 run on 74691c7 (dec1125b) | reads routes at about 16:30Z |

## Time

Measured: the mission started 2026-11-25 at about 00:15Z, so 15.5 h have been used. Estimate to verified completion: not yet defensible; it needs the first graded round with research complete.
