# Map A — response to Gate A

I checked every non-CONFIRMED finding (GA-01 to GA-30) against the code myself. Server and scripts are unchanged between 2d79f7d and the current HEAD (`git diff --stat 2d79f7d HEAD -- server scripts` is empty), so the line numbers below hold for the reference commit.

Result: **30 ACCEPTED, 0 DISPUTED.** GA-15 is accepted with one refinement: its writes happen on each knowledge-cache refresh (`KNOWLEDGE_TTL_MS` = 5 min), not on literally every read. GA-27 is accepted as line drift: the earlier line numbers inside `readGoalPlanUnscoped`/`composeGoalModel` were estimated from range reads, and I have now replaced them with grep-exact anchors. The 22 CONFIRMED findings (GA-31 to GA-52) need no change.

File abbreviations: M = mechanisms.json, H = handoffs.json, GS = generators_selectors.md, F = flow.md, U = unreachable_and_alternates.md, X = exclusions.md.

| GA | Verdict | My evidence (file:line) | Files changed (ids) |
|---|---|---|---|
| GA-01 | ACCEPTED | `problem.challenge !== false` → `bindChallenge` at quant/portfolio.ts:1215-1221. `bindChallenge` 1254: challenged → `adoptionFrom` → `result.adoption` → `applyChallengeToAssurance`. `modelChallengeFor`/`operatorAsker` → `modelsFor` at quant/modelChallenge.ts:174-182, 267-290. No `challenge:false` anywhere in goals/ or cash/ (grep). | M (A-M031 corrected; new A-M144, A-M145), H (A-H51), GS (S4b), F 4.3e, U |
| GA-02 | ACCEPTED | `openBucketRound` creates its candidate without a judgment (discovery.ts:655-661). Judgment pass is `judge-unjudged` (loop.ts:1965-1986). `nextLaunchable` reads `judgment.missionSpec` (loop.ts:3143-3250). The pass then runs `judgeCandidate` → `askArchive` → answeredByArchive, then `compileMission` → refusal (russell/planning.ts:404-470). Caps 5/40 per tick (loop.ts:3941-3943). | M (A-M098; new A-M146), H (A-H41 amended, A-H52), GS (S22), F 7.1, X |
| GA-03 | ACCEPTED | routes/goals.ts:200-211; decide.ts:378-466 (readObjective only, line 399; setTarget; `GOAL_OBJECTIVE_CHANGED`; PURSUES links kept). The string `GOAL_OBJECTIVE_CHANGED` does not appear in routeProposal.ts (grep). goalsCli.ts:307. | M (new A-M147), H (A-H53), F 1.6a and state table, U |
| GA-04 | ACCEPTED | routes/register.ts:225-258 (title/intent/purpose/projectId; `WORKSTREAM_AMENDED`; target not touched). goalSprint.ts:69 requires `target.projectId === projectId`. | M (new A-M148; A-M130), H (A-H54), F 1.6b, U |
| GA-05 | ACCEPTED | executionWindow.ts:59-64 (full window until started). executionStart.ts:19-37. tick.ts:348. routes/cash.ts:697. decide.ts:187-189. | M (new A-M149, A-M150), H (A-H55), F 1.5e and state table |
| GA-06 | ACCEPTED | tick.ts:313-343 (`resumeGoal` from repos/goals, bypassing decide.ts), 346, 348, 416, 432, 517, 1227. | M (A-M133 rewritten; new A-M151, A-M152), F state table |
| GA-07 | ACCEPTED | plan.ts:5805-5821. Callers: reconsider.ts:287-294, director.ts:442, improvement/loop.ts:1718, fallbackWatch.ts:374, quant/knowledge.ts:823. Floor trigger: tick.ts:222-226. | M (A-M015, A-M135, A-M141; new A-M153, A-M154), H (A-H56), F 3.3d |
| GA-08 | ACCEPTED | decisionRecord.ts:40 (`GOAL_DECISION_RECORDED`), 335 (`staleAgainstPolicy`), 473-490. reconsider.ts:239 (`governingPolicy`), 382, 408, 430. ownerPolicy.ts:125, 163. tick.ts:140-142. | M (A-M135; new A-M157, A-M158), H (A-H57), F state table |
| GA-09 | ACCEPTED | plan.ts:128 import; 2355 `buildPlanSet`; 2368 `rebuildAfter`; `readingsSummary` 2383-2440 carries planSet. planSet.ts:643-650 (`richness` = established×1e9 + p50). | M (new A-M159), H (A-H58), GS (S19), F 4.5m, U |
| GA-10 | ACCEPTED | operatorTools.ts:179 (lookup in `summaries` only, else notFound). snapshot.ts:37 (`SNAPSHOT_TTL_MS` = 25 min), 60. No invalidation found in snapshot.ts or decide.ts (grep for a cache reset: none). | M (A-M119; new A-M160), H (A-H26 amended), GS, F 8.1, U, X |
| GA-11 | ACCEPTED | quant/deadline.ts:56 `decideResearch`, used at plan.ts:4804, 5244. domain/goalPolicy.ts:31-33 (SQUEEZE). plan.ts:59 `planAuthority`, 2058, 5098 (`missingForSale`), 2651 `readCapabilities`. | M (new A-M161, A-M162, A-M163), GS (S20, S21), F 4.5b, 4.5e, 4.5m |
| GA-12 | ACCEPTED | `runIndustryKernel` is called at loop.ts:2226 (the reviewer's 2184-2186 is the catch block nearby). `createNode` at industry/expand.ts:727, 2196-2269. `seedGoalIndustry` at construction/service.ts:300 ← routes/goals.ts:300-306. | M (A-M019; new A-M164, A-M165), H (A-H59), F state table, X |
| GA-13 | ACCEPTED | routes/goals.ts:312-341 (`workstreamId: goal.id`). repos/construction.ts:224-227 (`workstream_id IS NULL`), read via construct.ts:1076. Fingerprint counts only `source_claim_id IS NOT NULL` facts (plan.ts:5731-5732). | M (A-M019; new A-M166), H (A-H60), F state table, U |
| GA-14 | ACCEPTED | operate.ts:947-948, 1393 (`markReady`) ← loop.ts:2509. retireListings.ts:129-140 ← loop.ts:2559. | M (new A-M167, A-M168), H (A-H61), F state table, X |
| GA-15 | ACCEPTED (refined) | quant/knowledge.ts:198-241: `keepCashLedger`, `assessProjectIndependence`, `watchFallbacks`, `assessProjectFallbackPlan`, `readSwitchDecision`. These run on a cache miss only; `KNOWLEDGE_TTL_MS` = 5 min (knowledge.ts:121, 199-200). | M (A-M137; new A-M169), H (A-H62), F 4.3b and state table |
| GA-16 | ACCEPTED | knowledge.ts:236-239 (`readSwitchDecision`), 1078 (`switchedPathObservations`), 1222. fallbackApply.ts:280. fallbackWatch.ts:372-374. | M (new A-M156), H (A-H62), X (moved into scope) |
| GA-17 | ACCEPTED | improvement/loop.ts:1712-1718 (`selfmodel/objectives.assessLiveObjectives` → `requestGoalPlanPass`). tick.ts:228-231 (`improvementTick`). | M (new A-M154, A-M155), H (A-H56), F 3.3d, X (moved into scope) |
| GA-18 | ACCEPTED | goalScenario.ts:3086 passes `ownerLabour`; goalScenario.ts:1883, construct.ts:1346 and 1746 call `breaksOperatingModel` without it. | M (A-M139 corrected; A-M019, A-M025, A-M028), GS, F 4.3c-d, U |
| GA-19 | ACCEPTED | goalSprint.ts:104-107 (skips a project if any `cash_modes` row exists). lifecycle.ts:417-421, 531-539. | M (A-M130), H (A-H05), F 2.2a, U |
| GA-20 | ACCEPTED | domain/planReady.ts:169-178 (`CHALLENGED_BY_HERMES`). goals/planReady.ts:179-190. operator/run.ts:217-221. | M (A-M124; new A-M175), H (A-H28), GS (S18), F 8.3, U |
| GA-21 | ACCEPTED | operator/run.ts:202-216: `directorTick` runs "whether or not the operator app is connected"; `operatorConfig` is checked only at 219-220. director.ts:1850 (`STANDING_AFTER_RUNS` = 2). | M (A-M141 corrected), F 3.3d, U |
| GA-22 | ACCEPTED | domain/types.ts:7141-7150 includes COLLECTED. goalScenario.ts:121-124: COLLECTED is in neither LIVE nor STOPPED. | M (A-M025), H (A-H61), F 4.3b and state table |
| GA-23 | ACCEPTED | domain/types.ts:7102 (ACTIVE / WINDING_DOWN / ARCHIVED). | M (A-M131), F 2.2a and state table |
| GA-24 | ACCEPTED | routeProposal.ts:2104-2108: only `routes.length === 0 && rejected.length === 0` moves to the next model. | M (A-M073, A-M074), H (A-H33), GS (S15), U |
| GA-25 | ACCEPTED | loop.ts:4114-4117 (DEFERRED returns early); 4118 (THROTTLED → `maxReads` 1). | M (A-M014), F 3.2 |
| GA-26 | ACCEPTED | knowledge/pipeline.ts:265 (`PASS_EVERY_MS` = 15 min), 309-316 (60 s tick, skips when shedding). | M (A-M142) |
| GA-27 | ACCEPTED | Exact anchors from grep: plan.ts:2505, 2627, 2651, 2684, 2920, 2929, 2971, 2987, 2995, 3041, 3069, 3086, 3114, 3196, 3208; goalScenario.ts:3006, 3009, 3043, 3062, 3086, 3090, 3102, 3143, 3149, 3240, 3268, 3274, 3298, 3398, 3428, 3438. | M (A-M017, A-M025, A-M033, A-M037, A-M038), GS (S5), F 4.3, 4.5 |
| GA-28 | ACCEPTED | routes/goals.ts:173-195 (ownerUserId must be a project member). plan.ts:2626-2627. sprintCandidate still requires `createdByUserId` (goalSprint.ts:68). | M (A-M001, A-M033; new A-M174), H (A-H04), F 1.6c, U |
| GA-29 | ACCEPTED | plan.ts:5722-5737 (11 fields: openings, value layers, money, workstream, claim-sourced facts, card facts). plan.ts:6570 (NOT_SUPPORTED refresh skip). | M (A-M015; new A-M170), F 3.3d, U |
| GA-30 | ACCEPTED | scripts/step12b-acceptance.ts:1550. scripts/runpod-report.ts:221. goals/status.ts:29, 44 ← scripts/factory.ts:1888. | M (new A-M171, A-M172, A-M173), F 1.4b |

## Counts after Gate A

- **mechanisms.json:** 175 (143 + 32 new, A-M144 to A-M175). Each changed or new entry carries a `gate_a` list of finding ids.
- **handoffs.json:** 62 (50 + 12 new, A-H51 to A-H62). A-H04, A-H05, A-H26, A-H28, A-H33 and A-H41 were amended.
- **generators_selectors.md:** selectors S4b and S19 to S22 added. S5, S15 and S18 corrected.
