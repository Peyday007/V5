# Map A — subsystems judged not goal-planning-relevant (frozen 2d79f7d)

Evidence is import/caller absence from the cash-goal path (`server/services/goals/plan.ts` imports, listed via grep of its `from '…'` clauses, plus `cash/goalScenario.ts`, `cash/construct.ts`, `goals/routeProposal.ts`, `cash/discovery.ts`).

| Subsystem | Why excluded | Evidence |
|---|---|---|
| `server/services/planner.ts` (Master Planner NOW/NEXT/LATER) | plans research layers of a project, not commercial goals | used by agent/tools.ts:74, runtimeState.ts:36; not imported by goals/* |
| `server/services/factory/**` (Factory, release probes) | engineering delivery; only probes call `readGoalPlan(persist:false)` for measurement | factory/program/release01/causalProbe.ts:39, pathwaysProbe.ts:74 |
| `server/services/engineering/**`, `.claude` hooks, `npm run engineering` | engineering policy, not planning | no import from goals/plan.ts |
| `server/services/memory/**` (historical memory) | conversation history indexing | loop.ts:1658 pass independent of goals |
| `server/services/puzzle/**` | only `puzzle/formats/index.ts` is imported by plan.ts (format helpers), no planning logic | plan.ts import list |
| `server/services/selfmodel/**` | reads goal_plan_readings for self-measurement only | selfmodel/capabilities.ts:301 |
| `server/services/quant/fallbackWatch.ts`, `fallbackSwitch.ts` | monitor stored readings; do not produce them | quant/fallbackWatch.ts:315 |
| `server/services/inboxes/**`, `cash/outreach.ts` execution, Instantly sending | post-plan execution (sending); the plan only reads Instantly capacity/rates | goalScenario.ts:3002 reads `instantlyCapacity`/`instantlyMeasuredRates` only |
| `server/services/cash/invoicing.ts`, `closing.ts`, `deal.ts`, `execution.ts` | post-sale lifecycle | not imported by plan path |
| `server/services/manufacturing/**`, `labor/**`, `magic/**`, `dealflow/**` | separate product sections | no import from goals/plan.ts, goalScenario.ts, construct.ts |
| `server/services/identity/**`, auth routes, passkeys, oauth | access control only (authorize/decideProjectAccess at entries) | operatorTools.ts:15 |
| `server/services/storage/**`, documents, importer, audits of research layers | document store for research projects | not on goal path |
| `server/services/conversation/**`, `chat.ts` route | chat surface | not on goal path |
| `server/services/scenario/demo.ts`, `scenario/analyze.ts` | demo / analysis; plan uses scenario/engine.ts, isolate.ts, model.ts, service.ts | plan.ts import list |
| `server/services/bins/**` beyond brain-only mode | worker bin mechanics; only `brainOnlyMode` is read (researchRoom.ts:385) | — |
| `server/services/dispatch/**` | fires Claude routines for queued work; generic capacity, not goal reasoning (mapped only as the research execution lane) | dispatch/loop.ts; not imported by goals/plan.ts |
| `server/services/evolution/**`, `improvement/**` | Brain self-improvement loop | loop.ts:1694 pass independent |
| `server/services/russell/**` except loop.ts passes, goalSprint.ts, launch.ts | Russell's mission/probe/judgment machinery is generic research intake; only launch/candidates are on the path | — |
| `server/services/knowledge/**` beyond `apply.ts`/`pipeline.ts` | public-dataset ingestion; only reaches plans via construction facts and `notePlanEffects` | plan.ts:1 import of knowledge/apply.ts |
| `server/services/industry/construction/*` except `intent.ts` | not imported by the cash path (see unreachable_and_alternates.md) | grep `goalConstruction(` callers |
| Research-layer audit engine (`auditEngine.ts`, `synthesis.ts`, `redoEngine.ts`) | research-document workflow | not imported by goals/* |
