# App-session goal-to-plan path — the recorded journey (2026-11-26)

These are the raw inputs and outputs of one run of `scripts/planningSession.ts` (the same service the
`brain_planning_*` MCP tools call, `server/services/planning/sessionPlanning.ts`). The run was on an
isolated world: the planning bench's template database (`world.json`). Nothing touched production,
spent money or contacted anyone.

| step | file | what happened |
|---|---|---|
| goal | 01 | `createGoal` on the owner's raw words. Read as COLLECTED_CASH $10,000 / 30 d, ceiling $2,000, before-proof $300. |
| contract | 02 | v1, digest `26b673f3e3109d5f95622c67`: words, source and interpreted terms. |
| routes | 03 | E-2 and SBA routes went through `parseRoutes` and `fileRoute` as hypotheses. The SBA route has `directCostKnown:false`, and no cost fact was written for it. |
| Brain | 04 | `readGoalPlan` (real planner) returned NOT_VIABLE / CANDIDATE_ONLY: hypotheses are not evidence. |
| rev1 | 05 | 4 problems returned to the session: CHAIN_STEP_MISSING (ORDER), PRE_PROOF_SPEND_OVER ($394 > $300), EVIDENCE_TRANSFER (GAO population), REACH_UNCALIBRATED. |
| rev2 → rev4 | 06–13 | rev2 and rev3 passed Brain's checks. The independent reviewer (a separate executor) answered REVISE twice with findings. Finalizing rev2 was refused with its blockers (09). The rev4 text did not match its trace. |
| rev5 | 14–16 | Passed every check. Pre-proof $287 = $227 spend + $60 commitments. The independent reviewer answered PASS on that exact digest. |
| final | 17 | Published as CONDITIONAL; it needs the live demand test. |
| reload | 18 | A new process replays the same current revision, the final and 3 reviews. |

The ten build-brief controls are `tests/sessionPlanningPath.test.ts`, run on real services and a
real database.
