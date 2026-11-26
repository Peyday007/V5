# Map A — subsystems judged not goal-planning-relevant (frozen 2d79f7d)

Evidence is import/caller absence from the cash-goal path (`server/services/goals/plan.ts` imports, listed via grep of its `from '…'` clauses, plus `cash/goalScenario.ts`, `cash/construct.ts`, `goals/routeProposal.ts`, `cash/discovery.ts`).

| Subsystem | Why excluded | Evidence |
|---|---|---|
| `server/services/planner.ts` (Master Planner NOW/NEXT/LATER) | plans research layers of a project, not commercial goals | used by agent/tools.ts:74, runtimeState.ts:36; not imported by goals/* |
| `server/services/factory/**` (Factory, release probes) | engineering delivery; only probes call `readGoalPlan(persist:false)` for measurement | factory/program/release01/causalProbe.ts:39, pathwaysProbe.ts:74 |
| `server/services/engineering/**`, `.claude` hooks, `npm run engineering` | engineering policy, not planning | no import from goals/plan.ts |
| `server/services/memory/**` (historical memory) | conversation history indexing | loop.ts:1658 pass independent of goals |
| `server/services/puzzle/**` | only `puzzle/formats/index.ts` is imported by plan.ts (format helpers), no planning logic | plan.ts import list |
| `server/services/inboxes/**`, `cash/outreach.ts` execution, Instantly sending | post-plan execution (sending); the plan only reads Instantly capacity/rates | goalScenario.ts:3002 reads `instantlyCapacity`/`instantlyMeasuredRates` only |
| `server/services/cash/invoicing.ts`, `closing.ts`, `deal.ts`, `execution.ts` | post-sale lifecycle | not imported by plan path |
| `server/services/manufacturing/**`, `labor/**`, `magic/**`, `dealflow/**` | separate product sections | no import from goals/plan.ts, goalScenario.ts, construct.ts |
| `server/services/identity/**`, auth routes, passkeys, oauth | access control only (authorize/decideProjectAccess at entries) | operatorTools.ts:15 |
| `server/services/storage/**`, documents, importer, audits of research layers | document store for research projects | not on goal path |
| `server/services/conversation/**`, `chat.ts` route | chat surface | not on goal path |
| `server/services/scenario/demo.ts`, `scenario/analyze.ts` | demo / analysis; plan uses scenario/engine.ts, isolate.ts, model.ts, service.ts | plan.ts import list |
| `server/services/bins/**` beyond brain-only mode | worker bin mechanics; only `brainOnlyMode` is read (researchRoom.ts:385) | — |
| `server/services/dispatch/**` | fires Claude routines for queued work; generic capacity, not goal reasoning (mapped only as the research execution lane) | dispatch/loop.ts; not imported by goals/plan.ts |
| `server/services/evolution/**` | Brain self-improvement experiments | not imported by the goal path |
| `server/services/russell/**` except loop.ts passes, goalSprint.ts, launch.ts, planning.ts (judgment/compile, now mapped as A-M146) | Russell's mission/probe/judgment machinery is generic research intake; only launch/candidates are on the path | — |
| `server/services/knowledge/**` beyond `apply.ts`/`pipeline.ts` | public-dataset ingestion; only reaches plans via construction facts and `notePlanEffects` | plan.ts:1 import of knowledge/apply.ts |
| `server/services/industry/construction/*` except `intent.ts` and `service.ts seedGoalIndustry` | not imported by the cash path (see unreachable_and_alternates.md); seedGoalIndustry writes nodes construction reads (A-M165) | grep `goalConstruction(` callers |
| Research-layer audit engine (`auditEngine.ts`, `synthesis.ts`, `redoEngine.ts`) | research-document workflow | not imported by goals/* |

## Moved back into scope after Gate A (verified)

| Subsystem | Why it is in scope | Evidence | Mapped as |
|---|---|---|---|
| `quant/fallbackApply.ts` (`readSwitchDecision`), `quant/fallbackWatch.ts` | `loadCashKnowledge` on the plan path reads the switch decision and injects respond observations; fallbackWatch forces REPAIRED re-reads (GA-16) | quant/knowledge.ts:236-239, 1078-1092, 1222; fallbackWatch.ts:372-374 | A-M156, A-M169 |
| `improvement/loop.ts`, `selfmodel/objectives.ts` | `assessLiveObjectives` → `requestGoalPlanPass`; the goal tick's floor opener runs `improvementTick` (GA-17) | improvement/loop.ts:1712-1718; goals/tick.ts:228-231 | A-M154, A-M155 |
| `industry/kernel.ts`, `industry/expand.ts` | writes the industry nodes `constructArrangements` reads (GA-12) | loop.ts:2226; expand.ts:727, 2196-2269 | A-M164 |
| `cash/operate.ts`, `cash/retireListings.ts` | write opening state the model reads (GA-14) | operate.ts:948, 1393; retireListings.ts:129-140 | A-M167, A-M168 |
| `russell/planning.ts` | judgment gate between a goal round and launch (GA-02) | planning.ts:404-470 | A-M146 |
| `operator/snapshot.ts` | gates brain_operator_goal_plan (GA-10) | operatorTools.ts:179; snapshot.ts:37 | A-M160 |
| `selfmodel/capabilities.ts` (remaining selfmodel) | still read-only measurement of readings | selfmodel/capabilities.ts:301 | excluded |
