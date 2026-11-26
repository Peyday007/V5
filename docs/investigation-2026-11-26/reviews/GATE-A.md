# Gate A: independent review of the Map A implementation coverage

Reviewer: Gate A (independent; did not write Map A). Reference: 2d79f7d. `git diff --stat 2d79f7d HEAD -- server scripts` is empty, so HEAD cc3c386 has the same code.
Method: I listed the entry points and schedulers myself (grep of `server/routes`, `server/mcp`, every `setInterval` / `*_EVERY_MS`, every Russell `runPass`). I walked the call graph back from `goal_plan_readings` readers and from `brain_operator_goal_plan`, and forward from `createGoal`. I grepped every model call site, read the `plan.ts` import block line by line, and enumerated all `recordWorkstreamEvent` kinds and the state enums. The structured list is in `gate_a_findings.json` (52 rows). Every row cites a file and line I opened.

## (a) Missed mechanisms and paths

| # | Missed | Evidence | Why it matters for producing a plan |
|---|---|---|---|
| GA-01 | **Model challenge inside `optimizePortfolio`.** `bindChallenge` → `challengePlan` → `modelChallengeFor` asks the operator models (`challengeDecision`). It can **replace `portfolio.best`** (`adoptionFrom`) and **withdraw the 90% claim** (`applyChallengeToAssurance`). The goal path never disables it. | quant/portfolio.ts:1215-1221, 1254-1300, 1327; quant/modelChallenge.ts:174-182, 273; quant/challenge.ts:1190 | This is a model call site, and a selector, on every plan read. The map's model-call list and S4 leave it out. |
| GA-02 | **The Russell judgment stage between a goal round and launch.** The candidate is created without a judgment. `nextLaunchable` needs a `missionSpec`. `judge-unjudged` → `judgeCandidate` → `askArchive` can end the round as `answeredByArchive`; `compileMission` can refuse it. | cash/discovery.ts:655-661; russell/loop.ts:1965-1986, 3069-3071; russell/planning.ts:404-470 | This gate decides whether research the plan asked for ever runs. Flow 7.1 jumps from "candidates" to `launch`. |
| GA-03 | **`changeObjective`** (POST `/goals/:id/objective`, goalsCli). No `assistObjective` second read. Old PURSUES links are kept. `routeAskDue` never reads `GOAL_OBJECTIVE_CHANGED`, so new routes wait up to 6 h while the old routes stay openings. | routes/goals.ts:200-211; goals/decide.ts:378-466; routeProposal.ts:86, 1364-1402 | This is a re-plan entry point, and the brief named it. |
| GA-04 | **PATCH `/register/workstreams/:id`** changes intent and projectId but not the target. | routes/register.ts:225-258; goalSprint.ts:63-64 | The intent feeds the exclusions, the owner-labour offer and the route prompt. A moved project breaks sprint activation. |
| GA-05 | **The §119 execution window.** `daysLeftOf` returns the full window until execution starts. `startExecutionWindows` (goal tick and the cash grant route) writes `execution_started_at` and `due_at`. | domain/executionWindow.ts:59-64; goals/executionStart.ts:19-37; tick.ts:348; routes/cash.ts:697 | Every `days_left`, SQUEEZE-policy and deadline check reads this. |
| GA-07 | **Sources of REPAIRED re-reads** (`requestGoalPlanPass`): reconsider, director, improvement loop, fallbackWatch, quant knowledge. **Source of FLOOR** (`requestFloorResearch`): the tick's floor opener. | plan.ts:5805-5821; reconsider.ts:293; director.ts:442; improvement/loop.ts:1718; quant/fallbackWatch.ts:374; quant/knowledge.ts:823; tick.ts:223-227 | The map names the due reasons but none of their producers. |
| GA-08 | **Decision history**: `recordDecisionsIfDue`, `ownerPolicy` (`governingPolicy` / `staleAgainstPolicy`), and the writes and plan trigger of `reconcileFactChangesIfDue`. | tick.ts:57, 139-143; decisionRecord.ts:473-479; reconsider.ts:239, 382, 408; ownerPolicy.ts:33-49 | This is the mechanism that retires plans made under an older owner policy. |
| GA-09 | **`buildPlanSet` / `rebuildAfter`**, a second "best plan" ranking by richness. Its lead is persisted in `forecast` through `readingsSummary`. | plan.ts:2216-2379, 5575; goals/planSet.ts:643-700 | The owner-facing forecast can name a lead that differs from `chosen_strategy` and from the acceptance candidate. |
| GA-10 | **`brain_operator_goal_plan` finds the goal only in `operatorSnapshot`** (25-min TTL, no invalidation). A goal missing from the cache gets notFound; `director.goalProject` has a fallback for this case, `planTool` does not. | mcp/operatorTools.ts:177-182; operator/snapshot.ts:37, 44-47; director.ts:449-460 | A freshly created goal can be unreadable on the owner-facing plan tool and in the Command Center. |
| GA-11 | **`decideResearch`** (research now vs learn in execution → `researchPriority` → `sendPlanQuestions`); **`goalExecutionPolicy`** (SQUEEZE whenever days are known); **`missingForSale` / `planAuthority` / `readCapabilities`** (sale blockers, `permissionsMissing`). | plan.ts:47-75, 2058-2060, 4804-4808, 5094-5124, 5244-5248; domain/goalPolicy.ts:31-33 | These decide which questions are researched and what the steps say blocks the sale. |
| GA-12 | **Writers of industry nodes**: the industry kernel in the per-project walk, and `seedGoalIndustry` on POST `/goals/:id/construction` with seed=true. | russell/loop.ts:2184-2186; routes/goals.ts:291-306; cash/construct.ts:44, 1224 | `constructArrangements` builds from these nodes; the map names them as an input with no producer. |
| GA-13 | **Owner-recorded construction facts never reach the cash plan.** They carry `workstream_id`; `construct.ts` reads only `workstream_id IS NULL` facts; the fingerprint ignores them too. | routes/goals.ts:312-341; repos/construction.ts:224-227; construct.ts:1076; plan.ts:5731-5732 | The owner's evidence route is cut off from the cash plan. |
| GA-29 | **What `planInputsFingerprint` covers.** It leaves out knowledge and world-model facts, claims that became neither facts nor openings, library verdicts and person facts. | plan.ts:5722-5737, 6551 | A goal held NOT_SUPPORTED stays stuck through those changes. |
| GA-24 | **No fallback to the next model on a reply whose routes all failed the rules.** `routes=0, rejected>0` is accepted as the answer. | routeProposal.ts:2095-2110 | One weak model's rule-rejected reply ends the fallback chain. |
| GA-30 | Unlisted scripts: `step12b-acceptance.ts` (`createGoal`), `runpod-report.ts` (`readGoalPlan`), `goals/status.ts` reader. | scripts/step12b-acceptance.ts:1550; scripts/runpod-report.ts:221; goals/status.ts:29-46 | Minor. |

## (b) Wrong or imprecise claims (sample of 32 map claims checked: 22 confirmed, 10 wrong or imprecise)

- **WRONG GA-18.** A-M139 says the owner-labour lift lifts the owner-physical refusal. That holds only for openings (goalScenario.ts:3086). Arrangements are screened without the labour argument (goalScenario.ts:1883; construct.ts:1346, 1746). An owner who offers their own work still loses every arrangement that needs it.
- **WRONG GA-21.** A-M141 says the director needs `BRAIN_OPERATOR_URL`/`_KEY`. `directorTick` always runs; only the Hermes run is gated (operator/run.ts:202-221).
- **IMPRECISE GA-19.** "Person-created goal → Cash Mode ACTIVE" (flow 2.2a). Any existing `cash_modes` row, including WINDING_DOWN or ARCHIVED, blocks reactivation (goalSprint.ts:104-107), and the launch gate then refuses discovery (lifecycle.ts:417-421).
- **IMPRECISE GA-20.** The owner notice needs more than ACCEPTED. It also needs a Hermes ADOPT_PLAN with a challenger answer (domain/planReady.ts:169-178). Without the operator it is unreachable even when the plan is accepted.
- **IMPRECISE GA-22 / GA-23.** The opening states leave out COLLECTED, which `composeGoalModel` drops silently (goalScenario.ts:121-124). The `cash_modes` enum is ACTIVE / WINDING_DOWN / ARCHIVED (types.ts:7102).
- **IMPRECISE GA-15.** `loadCashKnowledge` is mapped as a reader, but every plan read writes the ledger and fallback records (quant/knowledge.ts:208-241; quant/ledger.ts:441).
- **IMPRECISE GA-25, 26, 27, 28.** Under pressure the pass can be DEFERRED entirely, not just throttled (loop.ts:4114-4119). The knowledge loop runs at most every 15 min, not every 60 s (pipeline.ts:265, 309-316). Line numbers inside `plan.ts` and `goalScenario.ts` are 9-25 lines off; function start lines are correct. `ownerUserId` can be set later through PATCH terms (routes/goals.ts:173-195).
- **CONFIRMED (22): GA-31 to GA-52.** These include the headline unreachable claims:
  - the operator's create-goal tool passes `userId:null`, so it gets no sprint;
  - the discovery veto;
  - the split between the target_metric (cash) and objective planners;
  - `ROUTE_STRONG_MODEL` is never used;
  - `NO_MODEL`;
  - 0.9 required probability and 10 minimum outcomes;
  - the committee and integrity gates only act on ACCEPTED;
  - the persisted scenario needs an owner;
  - invent needs a lane;
  - calibration goes to `operator_learnings`, which the planner does not read;
  - at most 8 openings per model;
  - an hours sweep of 20-160 when no ceiling is read;
  - the project-scoped opening list;
  - the caps and cadences;
  - the focus gate;
  - strategy ordering;
  - the summary truncation;
  - when `assistReason` fires;
  - the `createGoal` name collision;
  - the NOT_SUPPORTED refresh skip.

## (c) Exclusions that are actually in scope

- **GA-16: `quant/fallbackWatch`, `fallbackSwitch` / `fallbackApply`.** `loadCashKnowledge` runs inside `composeGoalModel` (goalScenario.ts:3043). It reads `readSwitchDecision`, which injects respond observations through `switchedPathObservations` (quant/knowledge.ts:233-239, 1078-1092). `fallbackWatch` also forces re-reads (fallbackWatch.ts:372-374).
- **GA-17: `improvement/**`, `selfmodel/**`.** `assessLiveObjectives` → `requestGoalPlanPass` (improvement/loop.ts:1710-1718). The tick's floor opener calls `improvementTick` (tick.ts:228-231).
- **Not excluded but unmapped:** `industry/kernel.ts` (GA-12), `cash/operate.ts` and `retireListings.ts` (GA-14), `russell/planning.ts` (GA-02), `operator/snapshot.ts` (GA-10).

## (d) State writers missed

| State | Writers the map lists | Writers it misses |
|---|---|---|
| `workstreams.paused_at` | `decide.ts` | `resumeMachinePausedTargetedGoals` → `repos/goals.resumeGoal`, which bypasses `decide.ts` (tick.ts:313-343). `setGoalFocus` and `restoreOwnerDirectedGoals` reach it through `decide.ts` (operator/decisions.ts:978-1023). |
| `workstreams.due_at`, `execution_started_at` | `decide.ts` | `startGoalExecution` (repos/goals.ts:62; executionStart.ts:27) |
| `workstreams.intent` / target | create, setTarget | `changeObjective` (decide.ts:378-466); register PATCH (routes/register.ts:238) |
| `workstream_events` | 9 kinds | Unlisted kinds: GOAL_OBJECTIVE_CHANGED, GOAL_EXECUTION_STARTED, GOAL_SALE_PURSUED, GOAL_SALE_WAITS_FOR_RESEARCH, OWNER_NOTIFIED_PLAN_READY, GOAL_PATHWAY_NOT_ASKED, GOAL_WORK_HELD/RELEASED, GOAL_CAPACITY_ALLOCATED, WORKSTREAM_AMENDED, decision records and reconsiderations, RESEARCH_REMEDY_APPLIED. |
| bins (holds, priority) | — | `goals/tick.ts` (432, 517; repos/goals.ts:175, 252) |
| `cash_opportunities.state` | harvest, fileRoute, validation | `operate.markReady` (operate.ts:948, 1393); `retireMarketplaceListings` (retireListings.ts:134) |
| cash forecast ledger / fallback records | — | `loadCashKnowledge` on every plan read (GA-15) |
| `russell_candidates` judgment / state (CAPTURED…DONE, types.ts:6016) | — | `judgeCandidate` / `recordJudgment` (planning.ts:404-470) |
| `owner_notices` | `notifyPlanReady` (named) | the precondition that gates it (GA-20) |

## (e) Verdict

**The map is not sufficient for reconciliation yet.** Its core cash-planning chain (`readGoalPlanUnscoped`, `composeGoalModel`, route proposal, the acceptance gates) is accurate: 22 of 32 sampled claims are confirmed, and the line drift is minor. It is missing a model call site and a selector that bind the plan's acceptance, a gate on whether requested research runs, two re-plan entry points, and the execution-window state that sets days left.

Add these before reconciling:
1. GA-01: the model challenge and adoption in `optimizePortfolio`. Add it to the model-call list and the selectors.
2. GA-02: the judgment, archive and compile stage between a goal round and `launch`.
3. GA-03 and GA-04: `changeObjective` and the register PATCH as entry points, with what they do and do not re-trigger.
4. GA-05 and GA-06: the execution window and the goal-tick writers in the state table.
5. GA-07 and GA-08: the producers of REPAIRED and FLOOR re-reads, plus the decision-record and reconsider writers.
6. GA-09: `buildPlanSet` as an owner-visible selector.
7. GA-10: the snapshot gate on `brain_operator_goal_plan`.
8. GA-18: correct the owner-labour claim for arrangements.
9. GA-16 and GA-17: move them out of exclusions.

The remaining MED and LOW items (GA-11 to GA-15, GA-19 to GA-30) should be folded in during reconciliation.
