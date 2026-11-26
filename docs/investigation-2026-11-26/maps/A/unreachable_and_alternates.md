# Map A — parallel, alternate and unreachable implementations (frozen 2d79f7d)

## Alternate implementations of the same function

| Function | Implementations | Which the cash-goal path uses | Evidence |
|---|---|---|---|
| Objective reader | (1) `readObjective` regex (intent.ts:930); (2) `assistObjective` model second read (objectiveAssist.ts:201); (3) `interpretObjective` (objectivePlan.ts:95); (4) `interpretIntent` (intent.ts:~950); (5) route proposer's own model-written "owner profile" (`ownerProfileOf`, routeProposal.ts:1106; prompt STEP 1, 430-431) | (1) always, (2) only when `assistReason` fires, (5) inside each route ask; (3)/(4) non-cash goals and industry construction | decide.ts:113-120; objectivePlan.ts:40, 95; routeProposal.ts:2089 |
| Plan builder | (1) `readGoalPlan` cash planner (plan.ts:2469); (2) `planObjective` (objectivePlan.ts:629); (3) `goalConstruction` industry construction (industry/construction/service.ts:266); (4) `buildPlan` Master Planner for research layers (services/planner.ts) | (1) only, for any goal with `target_metric` | plan.ts:6482-6488 (`target_metric IS NOT NULL`); objectivePlan.ts:774-778 (`target_metric IS NULL`) |
| Strategy generator | composeGoalModel specs; reconstruction operators; invented directions; route proposer; objective STRATEGIST; pathways leading combination | all but objective STRATEGIST | see generators_selectors.md |
| Candidate/"best" selector | `optimizePortfolio.best`, `pricedBest`, `chosen` strategy, pathways leading, reconstruction best, `leadingArrangement` | `judgeAcceptance` picks among the first three/four in that order (plan.ts:1729-1752); `adoptReconstruction` may replace (2994-2999); steps follow `leadingArrangement` (3045) — so the steps' leg and the candidate can differ (handled by `stepsLegOf` text, 3065) | plan.ts |
| Model chooser | `modelsFor` (operator, free switchboard ≤2 + GPU); `laneConfig` (cheap lane ≤2 + RunPod first); `strongRouteModels` (Anthropic if both env vars) | route ask: strong + operator; invent/objective: lane; committee/assist: operator | operator/run.ts:78; cheap/lane.ts:57; routeProposal.ts:1419 |
| "createGoal" | `services/goals/decide.ts:93` (commercial goal) vs `repos/russellAuthority.ts:124` (research authority grant, routes/russell.ts:1713) | name collision only | — |
| Opening sources into the model | discovery `harvest` openings; route openings (`fileRoute`); scout directions (`fileDirection`); pathway/constructed rounds; feeds (`openFeedShortlist`, loop.ts:2134) | all land in `cash_opportunities` of the project and are read by `composeGoalModel` without a goal filter | goalScenario.ts:3017 |
| Learning stores | `operator_learnings` (route rethink, calibration, director, run reports); reasoning library (`recordExploration`); arrangement library (`rememberArrangements`, `recordReadingEvaluations`); `cashOutcomeLessons`; `goal_outcomes` | plan reads: reasoning library, arrangement library, cash lessons, goal_outcomes (via `measuredPlanChance`, null until 10 outcomes). `operator_learnings` is NOT read by plan.ts or composeGoalModel; the route proposer reads its own prior `GOAL_ROUTES_PROPOSED` `detail.rethink`, not the table | routeProposal.ts:2021-2022; repos/operator.ts:191 callers: operator/actions.ts:108, judge.ts:45 |

## Parallel pathways (run concurrently, not coordinated by one owner)

- Plan read (synchronous in the goal-plans pass) vs route proposal (background promise, `startAsk`, routeProposal.ts:2197) vs specialist committee review (background, committeeSpecialists.ts:327). Results of the background asks bind only on a later read.
- Goal discovery rounds (lenses) vs constructed rounds vs pathway rounds vs route deep dives vs need ideas vs bulk `runDiscovery` (one round per project per tick, loop.ts:2149) vs feeds shortlist — all compete for the same research slots / live caps (`MAX_LIVE_GOAL_ROUNDS=3`, `constructedShare`).
- Cash planner and objective planner run in the same pass but never on the same goal (target_metric split).

## Implemented but no effective caller from the active cash-goal process

| Item | Why unreachable / ineffective | Evidence |
|---|---|---|
| `ROUTE_STRONG_MODEL = 'claude-sonnet-5-5'` | constant is never used as a default; strong model needs `BRAIN_ROUTE_MODEL` set explicitly | routeProposal.ts:1405, 1419-1425 |
| `goalConstruction` industry construction (strategy.ts, businesses.ts, roles.ts, economics.ts, designs.ts, openWorld.ts under industry/construction) for cash goals | not imported by plan.ts / goalScenario.ts / construct.ts; used only by objectivePlan and `/goals/:id/construction` routes | grep `goalConstruction(`: objectivePlan.ts:568, routes/goals.ts:284/298/340, goalsCli.ts:961 |
| Objective planner (STRATEGIST/CRITIC/REVISER) for a cash objective | `advanceObjectivePlans` selects `target_metric IS NULL` | objectivePlan.ts:774-778 |
| Calibration lessons in planning | `reconcileCalibrationIfDue` writes `operator_learnings` only; the planner never reads that table | calibration.ts:467-520 |
| `measuredPlanChance` | returns null until `minPlanOutcomes=10` outcomes of RECOMMENDABLE/QUANTITATIVELY_CONSTRUCTED readings exist | plan.ts:158, 1557-1570 |
| Committee blocking | `refuseForCommittee` acts only on ACCEPTED readings | plan.ts:5451-5452, 5482-5483 |
| `notifyPlanReady` owner notice | returns NOT_READY for any non-ACCEPTED reading | planReady.ts:179-181 |
| Persisted scenario run (scenario_models / scenario_runs) | requires `goal.ownerUserId ?? goal.createdByUserId`; operator-created goals have neither → `runIsolated`, so `scenario_model_id` stays null | plan.ts:2604-2613; operatorTools.ts:1025 |
| Sprint/Cash Mode activation for operator-created goals | `sprintCandidate` requires `createdByUserId` | goalSprint.ts:62 |
| `inventDirections` / `inventedDesigner` / objective planner when no lane | `inventEnabled` / `laneConfig` null without `BRAIN_CHEAP_LLM_URL` or RunPod config | invent.ts:98-108; lane.ts:57-60 |
| Hermes operator runs | inert without `BRAIN_OPERATOR_URL`/`_KEY` and a model | operator/run.ts:18-19 header, 218 |
| keyed search / Firecrawl | inert without keys | keyedSearch.ts header, 82-83, 116 |
| `heldReading` / `lastReadings` after restart | process memory; top-ups and `armRouteProposal` non-retry depend on it until the next read | plan.ts:6536-6545, 6573-6596 |
