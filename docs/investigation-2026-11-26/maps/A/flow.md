# Map A — end-to-end call chains (frozen 2d79f7d)

Every step cites file:line. Chains are numbered; branches are lettered.

## 1. Goal entry

1.1 MCP: `brain_operator_create_goal` → `createGoal({…, userId: null})` — server/mcp/operatorTools.ts:1000-1025.
1.2 HTTP: `POST /goals` → `createGoal({…, userId: principal.id})` — server/routes/goals.ts:105-121.
1.3 Eval: `scripts/planningEval.ts createOne` → `createProject` (one fresh project per case) → `createGoal({userId: admin.id})` — planningEval.ts:97-110.
1.4 CLI: `scripts/goalsCli.ts` create → `createGoal` — goalsCli.ts:378, 384.
1.5 `createGoal` (server/services/goals/decide.ts:93):
  a. `readObjective(objective)` regex reader — decide.ts:113; intent.ts:930.
  b. if `assistReason` (unplaced money / OTHER with money / CASH without deadline) → `assistObjective` with first `modelsFor()` model, 30 s — decide.ts:117-120; objectiveAssist.ts:40-45, 219-225.
  c. cash refusals: no currency/deadline (decide.ts:127-133), unplaced money (136-139), shared ledger (152-153).
  d. `createWorkstream` (intent = verbatim objective) → `WORKSTREAM_OPENED` event → `setTerms` (due or executionWindowDays) → `setTarget` (target columns) — decide.ts:156-211.
  For "Generate $10,000 … within 30 days with $2,000 capital and minimal owner involvement": no regex in intent.ts:627-668 reads "minimal owner involvement", so `hoursCeiling` stays null (the scenario then sweeps hours 20–160, goalScenario.ts:3291-3297).

## 2. Activation preconditions (Cash Mode)

2.1 Russell tick (30 s, loop.ts:183, 4154) → `goal-sprints` pass → `activateGoalSprints` — loop.ts:1630; goalSprint.ts:95.
2.2 `sprintCandidate` requires `goal.createdByUserId` and ADMIN of that person on the project — goalSprint.ts:58-65, 67-82.
  a. Person/eval/CLI-created goal → Cash Mode ACTIVE.
  b. Operator-created goal (1.1, userId null) → no sprint from this goal; `discoveryAllowed` false unless the project already had an ACTIVE Cash Mode — lifecycle.ts:520-540.
2.3 `discoveryAllowed` gates route proposals (routeProposal.ts:1981) and goal discovery rounds (discovery.ts:1150).

## 3. The plan pass scheduler

3.1 boot → `startRussell` — server/index.ts:971.
3.2 each tick → after `GOAL_PLANS_BOOT_GRACE_MS` (10 min) → `startGoalPlans` (background, in-flight guard, pressure throttle → `maxReads:1`) — loop.ts:1676, 4093-4136.
3.3 → `advanceGoalPlans` — plan.ts:6460: goals `WHERE target_metric IS NOT NULL`, least-recently-read first (6482-6488). Per goal:
  a. `recordGoalOutcome` (6524).
  b. paused → skip (6534).
  c. `armRouteProposal(retryOnly)` when held reading not ACCEPTED (6541-6545) → chain 6.
  d. due? `planDue` FIRST / REFRESH (30 min) / EVIDENCE (fingerprint changed ≥2 min) / REPAIRED / FLOOR (6549-6571). Not due → optional top-up `widenGoalSearch` every 5 min if `needsMoreOpenings` and spare surfaces (6573-6596).
  e. due → `readGoalPlan({persist:true})` (6582) → chain 4. `ScenarioBusyError` → `busy=true`, rest of pass reads nothing (6603-6607).
  f. ACCEPTED → `notifyPlanReady` (6612-6615) → owner notice.
  g. `needsMoreOpenings` → `sendPortfolioNeeds` (6621), `sendPlanQuestions` (6629), committee → `sendCommitteeNeeds` (6637); then `widenGoalSearch` (6647-6656) → chain 5.
3.4 non-cash goals only: `advanceObjectivePlans` when not throttled (loop.ts:4099) → `planObjective` (objectivePlan.ts:768-793) → `goal_objective_readings`.

## 4. One cash plan read (`readGoalPlanUnscoped`, plan.ts:2473)

4.1 `getWorkstream` → `readTarget` (target.ts:192); null → return null (2476-2478).
4.2 `goalArrangements` (6163) → `constructionInputFor` (6126: `executionFrame.delivers`, `goalExclusions`, limits) → `constructArrangements` (construct.ts:755: nodes, Brain map if <3 buyer types, openings, card facts, library, event graph → `selectCandidates` 1882 → compose ≤400 → memo 30 min) → filter `namesABuyerPopulation` (plan.ts:6180) → `rememberArrangements` → `notePlanEffects`. Error → `degraded`, [] (2483-2486). Construction cut reported in `degraded` (2489-2496).
4.3 `composeGoalModel` (goalScenario.ts:2981):
  a. refusals: no days / past due / achieved (2993-2995).
  b. `frontierTiers`, `listOpportunities(projectId)` (ALL project openings, no goal filter), stopped openings → excluded STOPPED (3011-3027).
  c. per opening: scope → exclusions → not-a-sale → owner-physical → SIGNAL tier ("evidence only") → expired → `modelOpportunity` refusal → stale signal (>30 d) (3070-3132).
  d. arrangements in scope → `selectEstimatedArrangements` (≤12, +6 reserve) (3156-3191).
  e. `evaluateGoalPortfolio` over found + estimates via `heldEvaluation`/`sharedEvaluator` (3196-3248) → `optimizePortfolio` (quant/portfolio.ts:1133).
  f. sort, keep ≤8 (`MAX_MODEL_OPPORTUNITIES`) (3251-3268); none → refusal "unmodelledVerdict" carrying portfolio (3269-3282).
  g. build scenario variables / lines / metrics / constraints; strategies combine_reach / combine_fast / combine_evidence / basket_all / only_oN ≤8 (3283-3441).
4.4 Branch A — `model.refusal` (plan.ts:2500-2609): reconstruction → `judgeAcceptance(chosen:null)` → `adoptReconstruction` → maybe CANDIDATE_ONLY → feasibility → `planSteps` → readings → continuation → `committeeContextOf` → `gateIntegrity` → persist.
4.5 Branch B — main (2611-3218):
  a. scenario: persisted `saveModel`/`runModel` only when `persist` and an owner user exists (`ownerUserId ?? createdByUserId`) (2605-2613); else `runIsolated`; `ScenarioRunError` → null result (2615-2625).
  b. `linkChecks` per considered opening; `considered` sorted; materiality recorded (2638-2663).
  c. per strategy spec: member pruning (2665-2678) → links → constraints (capital, settle date, inferred settle, cost ≥ price, expired) → best reach at supported prices; route members awaiting a dive count only toward `pendingDives` (2735-2763) → pacing / before-proof / lots / hours / sweep / per-week checks → verdict NOT_VIABLE / NEEDS_EVIDENCE / RECOMMENDABLE → capital question → nextTest (2787-2876).
  d. ordering: verdict rank → mean route-critique rank (only route-only strategies) → conservative settled → awards → missing links → goal-met share; `chosen = ordered[0]` (2903-2911).
  e. market tests ≤5 (2918-2926); `readPathways` (2945).
  f. `judgeAcceptance` (2962); not ACCEPTED → every RECOMMENDABLE strategy demoted (2963-2976).
  g. `reconstructionFor` (2986; plan.ts:3274): library + stance prior + (every 15 min, if lane) `inventDirections` + `inventedDesigner` → `reconstructPlan` → `recordExploration`.
  h. `adoptReconstruction` (2994) → CANDIDATE_ONLY with RECONSTRUCTED candidate (2995-2999).
  i. `judgeFeasibility` / `judgeHeldMarkets` → `notSupported` (3003-3018); `verdictOf` (3020-3024).
  j. SQUEEZE: `salesFor`, `heldForResearch` (3027-3028); `goalNextStep` (3030); `leadingArrangement` (3045); `planSteps` (3046); late-cash steps excluded (3052-3055).
  k. verdict: ACCEPTED→RECOMMENDABLE, infeasible→NOT_VIABLE, RECONSTRUCTED→NEEDS_EVIDENCE, else chosen.verdict; `candidateStrategyReading` appended; `superseded` (3056-3064).
  l. `withholdImplausibleFigures` (3067); summary (3071-3086); nextTest (3090-3107).
  m. `supportedDistribution`, `readOpeningLedger`, `composeGoalReadings`, `continuationOf` (3110-3131).
  n. `committeeContextOf` → `gateIntegrity` (planIntegrity + committeeOf; only an ACCEPTED reading can be refused) (3195-3206).
  o. persist: `armSpecialistReview` (background model call), `recordDegraded`, `persistReading` (goal_plan_readings row unless digest unchanged), `pursueSales` (3207-3214).

## 5. Search widening (`widenGoalSearch`, plan.ts:5854)

5.1 not ACCEPTED → `armRouteProposal` (5876-5878) → chain 6.
5.2 `askPathwayConstructions` (5880) and `askConstructedArrangements` (5881; 6372) → `openConstructedRound` (discovery.ts:1367) → `openBucketRound` (638) → candidate + round.
5.3 for 1+spare attempts: `openGoalDiscovery` (5884-5904; discovery.ts:1113): focus gate (1148), `discoveryAllowed` (1150), lens rotation (fixed, industries, field, roles, open-world) (1185-1260), question text from goal words, limits, held titles (≤8), search brief, research diagnosis, remedy, learned yield (1272-1340) → `openBucketRound`.
5.4 `researchGoalPaths` (5910; pathResearch.ts:160).

## 6. Route proposal (background; routeProposal.ts)

6.1 `armRouteProposal` (2231) → `startAsk` (2197; ≤2 in flight) → `proposeGoalRoutes` (1940).
6.2 due: `routeAskDue` over `GOAL_ROUTES_PROPOSED` events (1364-1402; 1948-1970).
6.3 claims `projectEvidenceClaims(projectId, 600)` (1972-1975; repos/research.ts:1186) → `readTarget` → `discoveryAllowed` (1981) → `routeContext` (1591: findingsOf ≤120, goalRoutes, delivers, exclusions, owner words).
6.4 stage SCOUT (findings <3, nothing priced, no live scouts) or ROUTE (2004-2007); room = 6/day minus filed (2008-2009).
6.5 `operatorChats` = `strongRouteModels(env)` (only with ANTHROPIC_API_KEY + BRAIN_ROUTE_MODEL) + `challengerModels(modelsFor())` (1448-1458); none → `NO_MODEL` event (2017-2021).
6.6 SCOUT: `directionPrompt` → first parseable model → `directionCritiquePrompt` → `applyDirectionCritique` → `fileDirection` ≤5 → record → `startValidations` (2030-2074).
6.7 ROUTE: `routePrompt` (428) → `askModel` (empty reply retried once, 2x tokens; 1436) → `routesJson`/`parseRoutes` (rule codes) → `critiqueAndRevise` (1849: critic → `applyCritique` → replacements if 0 survive) → `fileRoute` (1626: cash_opportunities + RECOMMENDATION card facts + ROUTE_RANK_FIELD + SOURCE link) → `supersedeScouts` → rethink → operator_learnings → `GOAL_ROUTES_PROPOSED` event → `startValidations` (2077-2162).
6.8 Next plan pass: the route opening is a project opening read by `composeGoalModel` (4.3b). Until its dive settles (`validationSettledAt`), `researchBeforeSale` makes strategies made only of such routes NEEDS_EVIDENCE with "Research first" (plan.ts:2735-2763, 2849-2856, 4914-4930).

## 7. Research execution → evidence

7.1 Candidates (discovery rounds, constructed rounds, need ideas) → Russell `launch` pass → `launch` (loop.ts:2801-2848; launch.ts:223) → `startPacket` (startPacket.ts:358) → work items.
7.2 Work claimed by the free lane (`startFreeLaneLoop`, index.ts:894; worker.ts:3889; models from `laneConfig`) or by Claude routines through MCP tools (`claimWork`, workQueue.ts:508). Search: `webSearch` (discover.ts:270) with `keyedSearch` (Google PSE / Firecrawl when keys set) and DuckDuckGo fallback; pages via `fetchForWorker`.
7.3 `brain_submit_claims` → `applyGate` (gate.ts:363) → accepted `research_claims`.
7.4 Readers: `harvest` (discovery.ts:2149, ≤10/tick/project from `runDiscovery`, loop.ts:2149) → openings; `applyValidationAnswers` (validation.ts:2401) → EVIDENCE card facts; construction facts → `constructArrangements`; `findingsOf` → route prompt; `restructureEvidenceOf` → portfolio.

## 8. Owner-facing outputs

8.1 `brain_operator_goal_plan` (operatorTools.ts:164) → `readGoalPlanSummary` (operator/actions.ts:134) → latest `goal_plan_readings` row (`latestReading`, plan.ts:5267); none → latest `goal_objective_readings`; else "no plan reading yet".
8.2 Command Center: `GET /command/read/brain_operator_goal_plan` → `callTool` (routes/command.ts:65-100). Same value as 8.1.
8.3 Owner notice: only on ACCEPTED → `notifyPlanReady` (planReady.ts:164-212).
8.4 `GET /goals/:goalId` events include `GOAL_PLAN_READ` summary (plan.ts:5605-5610; routes/goals.ts:77-95).
8.5 Live, unpersisted: `goalsCli` plan (goalsCli.ts:739), `planningEval read` (planningEval.ts:178).

## 9. Per-goal state and transitions

| Table / store | State / fields | Writer (file:line) | Reader |
|---|---|---|---|
| `workstreams` | intent, title, purpose, due_at, execution_window_days, execution_started_at, paused_at, cancelled_at, archived_at, created_by_user_id, owner_user_id, target_* (metric, amount, currency, capital/hours ceilings, resources, before-proof, per-week) | createWorkstream / setTerms / setTarget (decide.ts:156-206; target.ts:294); pause/resume/cancel (decide.ts:257-330) | readTarget, advanceGoalPlans query (plan.ts:6482) |
| `workstream_events` | WORKSTREAM_OPENED, GOAL_PLAN_READ, GOAL_ROUTES_PROPOSED (outcome PROPOSED / NO_MODEL / NO_ANSWER), GOAL_RESUMED_AFTER_REPAIR, GOAL_CONTINUES_BEYOND_TARGET, GOAL_FLOOR_RESEARCH_OPENED, GOAL_RESEARCH_SPRINT_ACTIVATED, COMMITTEE_SPECIALIST_REVIEW, degraded | decide.ts:163; plan.ts:5605, 5617, 6590, 6450; routeProposal.ts:2013; goalSprint.ts:48 | routeAskDue (routeProposal.ts:1948), committeeContextOf, GET /goals/:id |
| `workstream_links` | OPPORTUNITY SOURCE (route), OPPORTUNITY PURSUES (persistReading), CANDIDATE PURSUES (widen) | routeProposal.ts:1688; plan.ts:5631-5636, 5884, 5895 | goal model, spending limits |
| `goal_plan_readings` | verdict RECOMMENDABLE / NEEDS_EVIDENCE / NOT_VIABLE; forecast.acceptance.status ACCEPTED / CANDIDATE_ONLY / NO_CANDIDATE / NOT_SUPPORTED; acceptance.verdict CONFIDENCE_VERIFIED / QUANTITATIVELY_CONSTRUCTED / IMPROVEMENT_REQUIRED / NOT_SUPPORTED; digest | persistReading plan.ts:5590-5604 (append only, skipped on same digest) | readGoalPlanSummary, planReady, calibration, director, allocation, operations report |
| `goal_outcomes` | ACHIEVED / MISSED | recordGoalOutcome plan.ts:5665 | measuredPlanChance plan.ts:1559 |
| `goal_objective_readings` | objective verdict (non-cash) | objectivePlan.ts:721 persist | readGoalPlanSummary fallback |
| `cash_modes` | ACTIVE / other | activateGoalSprints (goalSprint.ts:95) | discoveryAllowed |
| `cash_opportunities` (+ `cash_card_facts`) | DISCOVERED / EVIDENCE_CARD / READY / EXECUTING / DELIVERING / ARCHIVED / DECLINED (goalScenario.ts:121-124); validation state, validationSettledAt; RECOMMENDATION vs EVIDENCE facts | harvest; fileRoute; fileDirection; validation | composeGoalModel, constructArrangements, findings |
| `cash_discovery_rounds` + russell candidates/missions | OPEN / settled rounds per bucket `goal-<id>-<lens>` / `-mx-` | openBucketRound (discovery.ts:654-674) | harvest, nextGoalRoundFor, recentGoalRounds |
| `research_orchestrations`, `work_items`, `research_claims` | orchestration status; claim accepted / contradiction_state / retrieval_state | startPacket; workers; applyGate | projectEvidenceClaims, harvest, construction |
| `scenario_models`, `scenario_runs` | only for persisted reads with an owner user | plan.ts:2607-2612 | advanceGoalPlans `since` (6551-6554) |
| process memory | lastReadings, lastReadAt, lastInputs, lastTopUp, repairedGoals, floorRequests, lastArrangements, explored, lastInvent, route inFlight/waiting | plan.ts, routeProposal.ts:2187-2189 | same process only |
