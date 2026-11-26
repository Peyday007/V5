# Map A — strategy generators and selectors (cash-goal path, frozen at 2d79f7d)

Derived from code only. IDs refer to `mechanisms.json`.

## Generators (produce candidate strategies / routes / openings / arrangements / scenarios)

| # | Generator | File:line | Model? | Reaches owner-facing reading? | How |
|---|---|---|---|---|---|
| G1 | `constructArrangements` (A-M019): composes designs from buyer populations x needs x supply x payment | server/services/cash/construct.ts:755 | no (quant, worker threads) | **Yes, indirectly**: ≤12 become portfolio estimates (`selectEstimatedArrangements`, goalScenario.ts:1818, cap 290) and the lead arrangement drives `planSteps` (plan.ts:3045-3046) | caps 50,000 candidates → 400 composed (construct.ts:1727, 402) → buyer-population filter (plan.ts:6180) → scope filter (goalScenario.ts:3156) → 12 (+6 reserve) |
| G2 | `composeGoalModel` strategy specs: `combine_reach`, `combine_fast`, `combine_evidence`, `basket_all`, `only_oN` (A-M029) | server/services/cash/goalScenario.ts:3388-3441 | no | **Yes**: they become `strategies[]`, the stored `strategies` column, and `chosen` | over ≤8 included openings (goalScenario.ts:99), ≤8 strategies (3385) |
| G3 | Route proposal `proposeGoalRoutes` (A-M069) with `routePrompt`/`directionPrompt` | server/services/goals/routeProposal.ts:1940 | **yes** (operator models; Anthropic only if `ANTHROPIC_API_KEY`+`BRAIN_ROUTE_MODEL`, 1419-1425) | **Indirectly**: filed as `cash_opportunities` (fileRoute 1626) → read next pass by `composeGoalModel` as openings (if not SIGNAL tier and not refused by `modelOpportunity`) | ≤6 routes/day/goal (98-100), scout 5 directions; background, ROUTE_MAX_IN_FLIGHT=2 |
| G4 | `reconstructPlan` (A-M040): operator variants (buy capacity, inbound, marketplace, deposit, bundle...) + exploration directions | server/services/goals/reconstruction.ts:333; reasoning/directions.ts | partly (G5) | **Yes when adopted**: `adoptReconstruction` → candidate source RECONSTRUCTED, steps, summary "The plan is the reconstruction" (plan.ts:3075-3077) | MAX_DIRECTIONS=120, MAX_GENERATIONS=4, MAX_EVALUATIONS=400, 3 min (directions.ts:54-76); reused 6 h on unchanged inputs (plan.ts:3253) |
| G5 | `inventDirections` (A-M041): model-invented reasoning methods/designs | server/services/goals/reasoning/invent.ts:102 | **yes** (cheap lane / RunPod) | only through G4 | ≤ once / 15 min / goal (plan.ts:3257); ≤4 calls, 90 s each |
| G6 | `inventedDesigner` (A-M043): composes model-invented designs | server/services/cash/goalScenario.ts:1369 | via G5 | only through G4 | same gate as G5 |
| G7 | `readPathways` (A-M048): required structures + per-opening transaction models + leading combination | server/services/goals/pathways.ts:1572 | no | **Yes**: fallback candidate source PATHWAYS in `judgeAcceptance` (plan.ts:1734-1752); `structures.searchBrief` into discovery question | main branch only (refusal branch passes `pathways:null`, plan.ts:2531) |
| G8 | Goal discovery `openGoalDiscovery` lenses (fixed, industry, field, role, open-world) (A-M085) | server/services/cash/discovery.ts:1113 | the round is researched by workers (free lane / routines) | **Indirectly**: claims → `harvest` → openings → G2 | 1 lens per attempt, attempts = 1+spare; live cap 3+spare |
| G9 | `askConstructedArrangements` / `askPathwayConstructions` (A-M084, A-M083) | server/services/goals/plan.ts:6372, 5945 | research workers | indirectly (answers become facts read by G1) | constructedShare = max(1, floor(cap/2)) |
| G10 | Deep dives `startValidations` (A-M081) | server/services/cash/validation.ts:1238 | research workers | indirectly (EVIDENCE card facts on openings) | MAX_VALIDATION_ROUNDS=2 |
| G11 | `sendPortfolioNeeds` / `sendPlanQuestions` / `sendCommitteeNeeds` (A-M089..091) | server/services/goals/portfolioNeeds.ts:76, 494, 438 | research workers | indirectly | keyed, idempotent |
| G12 | `harvest` (A-M097): opening per signalled claim | server/services/cash/discovery.ts:2149 | no | indirectly (openings → G2) | 10 per project per tick (discovery.ts:2899) |
| G13 | Objective planner STRATEGIST (A-M115) | server/services/goals/objectivePlan.ts:447, 629 | **yes** | only for goals with `target_metric IS NULL` → `goal_objective_readings` → `readGoalPlanSummary` fallback (actions.ts:139-141) | **not** for cash objectives |
| G14 | `goalConstruction` (industry construction: strategy/businesses/roles/economics) | server/services/industry/construction/service.ts:266 | no | **No for cash goals**; only objectivePlan (objectivePlan.ts:568) and GET/POST `/goals/:id/construction` (routes/goals.ts:284,298,340) | — |
| G15 | `salesFor` / market tests (A-M054) | server/services/goals/plan.ts:4937, 2918-2925 | no | Yes (`sales`, `marketTests`, nextTest) | MAX_MARKET_TESTS=5 (4894) |

## Selectors (pick a "best" / "chosen" / verdict)

| # | Selector | File:line | Output field | Feeds owner reading? |
|---|---|---|---|---|
| S1 | `selectCandidates` (construction cut) | construct.ts:1882 | which designs are composed | indirectly (cut said in `degraded`, plan.ts:2491) |
| S2 | `selectEstimatedArrangements` | goalScenario.ts:1818 | ≤12 estimates + reserve | indirectly (portfolio) |
| S3 | `composeGoalModel` slot sort + `MAX_MODEL_OPPORTUNITIES=8` | goalScenario.ts:3251-3268 | `included` | yes (strategies only cover included) |
| S4 | `optimizePortfolio` greedy/exhaustive (≤12) | quant/portfolio.ts:1133 | `portfolio.best`, `bestEligible`, ranked | yes (candidate QUANT_PORTFOLIO) |
| S5 | strategy sort → `chosen = ordered[0]` | plan.ts:2903-2911 | `chosen_strategy` column | **yes** (stored; `brain_operator_goal_plan.chosenStrategy`) |
| S6 | `judgeAcceptance` (candidate source QUANT_PORTFOLIO → STRATEGY → PATHWAYS; status) | plan.ts:1648 | `acceptance` in forecast | **yes** |
| S7 | `adoptReconstruction` | plan.ts:3630 | `adoption`, candidate RECONSTRUCTED | **yes** |
| S8 | `judgeFeasibility` / `judgeHeldMarkets` → NOT_SUPPORTED | plan.ts:3743, 3889 | `infeasible`, verdict NOT_VIABLE | **yes** |
| S9 | `verdictOf` (CONFIDENCE_VERIFIED / QUANTITATIVELY_CONSTRUCTED / IMPROVEMENT_REQUIRED / NOT_SUPPORTED) | plan.ts:1921 | `acceptance.verdict` | **yes** |
| S10 | `openingsVerdict` / `superseded` → reading `verdict` | plan.ts:3056-3064 | `verdict` column (RECOMMENDABLE / NEEDS_EVIDENCE / NOT_VIABLE) | **yes** |
| S11 | `leadingArrangement` | plan.ts:6222 | `lead`, the steps' leg | **yes** (steps) |
| S12 | `goalNextStep` / `stepAsNextTest` | plan.ts:5008, 4743 | `next_test` column | **yes** |
| S13 | `gateIntegrity` (planIntegrity + committee) | plan.ts:5473 | can only downgrade ACCEPTED | yes (only when ACCEPTED) |
| S14 | Route critique ranking `applyCritique` | routeProposal.ts:1248 | ROUTE_RANK_FIELD card fact | yes as tiebreak in S5 (plan.ts:2882-2900) between route-only strategies |
| S15 | First model with parseable answer wins (no comparison across models) | routeProposal.ts:2079-2088 | which model's routes are filed | indirectly |
| S16 | `modelsFor` / `rankOperatorModels` / `challengerModels` | operator/run.ts:78; domain/operator.ts:284; operator/decisions.ts:88 | model order | indirectly |
| S17 | `decideObjective` | objectivePlan.ts:374 | objective verdict | only non-cash goals |
| S18 | `planReady` | planReady.ts:164 / domain/planReady.ts | owner notice | yes, only on ACCEPTED |

## Which reach the owner-facing output

The owner-facing plan (`brain_operator_goal_plan` → `readGoalPlanSummary`, actions.ts:134; Command Center `GET /command/read/brain_operator_goal_plan`, command.ts:65) shows exactly the latest `goal_plan_readings` row: `verdict` (S10), `chosen_strategy` (S5), `strategies` (G2 + one candidate strategy appended by `candidateStrategyReading`, plan.ts:3061-3062), `next_test` (S12) and `forecast` (acceptance S6/S9, adoption S7, steps from `planSteps` with lead S11, infeasible S8, committee S13, degraded). Model generators G3/G5/G6 reach it only after a re-read converts their output into openings or adopted reconstructions; G13/G14 never reach a cash goal's reading.
