# Surge readiness — shared work list (deadline 15:00Z, 10 a.m. Detroit)

Set up 07:36Z, with 7 h 24 min remaining. Recalculated at least every 30 minutes; the latest status is at the bottom.

**Integration owner:** the intelligence-recovery session (session_01QF5Tk7etm6MGmaFuHMd6eZ). It runs the only Deploy dispatches.
- Workstreams open PRs with typecheck and test:impacted green, then hand the PR to the integration owner.
- The integration owner merges in batches and deploys once per batch, so a stray push does not cancel the Postgres gate on a release candidate.

**Diagnosis:** the troubleshooting session (session_01QF5Tk8yqoNKM3DaqDLzRiy) diagnoses and verifies independently. Evidence is shared through docs/diagnosis/BRAIN-FAILURE-DIAGNOSIS-2026-11-17.md and this file.

| # | Task | Acceptance condition | Owner | Est. | Depends on | Resources |
|---|---|---|---|---|---|---|
| W1 | Release eda04071, which carries #1018, #1020, #1023, #1024 and #1025, and verify it on production | Fly deploy succeeds. Production shows the 120B no longer held back on RESEARCH_FRAGMENT, goal rounds receiving missions, parked syntheses recovered, and monetization attributes answered above 13 | Integration owner | 08:00Z | Deploy 44036476327 | Fly; cheap-lane and cash-report readings |
| W2 | Plans read research (F2): constructed arrangements take their inputs from accepted evidence through `inferOr`, not as hard-coded ASSUMPTION/UNKNOWN | Test, plus production `brain_operator_goal_plan` for wst_7b4fcbb5f2384f31b6c3 showing arrangement members with justified inputs > 0 | Engineering agent (F2) | PR by 11:00Z | — | 1 Opus agent, worktree |
| W3 | Questions published sources cannot answer (F3e): BRAIN_PROPOSES attributes are not commissioned as research, only methods a source states are asked about, and answers already on a card are reused | Test, plus a production reading showing fewer UNRESOLVED questions opened per pass and the ANSWERED share rising | Engineering agent (F3e) | PR by 11:00Z | — | 1 Opus agent, worktree |
| W4 | Surge and information-use instrumentation: one reading that reports arrivals against completions, queue depth and age, accepted throughput, rejections, retries, CPU, memory, DB and worker pressure, and research-to-plan latency, plus a trace of objective → question → answer → claim → retrieval → plan decision for the goal | The reading runs on production and prints every metric | Engineering agent (instrumentation) | PR by 10:30Z | — | 1 Opus agent, worktree |
| W5 | Postgres suite stability: cashIntegrationPass:1087 and arrangementLibrary:284 fail under full-suite load | Root cause fixed without weakening the assertion, and the shards pass | Engineering agent (tests) | PR by 10:30Z | — | 1 Opus agent, worktree |
| W6 | Surge load test: the intended configuration (gpt-oss-120b-big on H200 plus the free lane) under representative goal work, stepped up while stable | Measured sustained useful throughput, with queue drain shown and no resource persistently overloaded | Integration owner | 08:15–12:30Z | W1 (W4 for full metrics) | RunPod H200 at $3.59/h, Brain-enforced cap |
| W7 | Second release (W2–W5) and re-measurement | Deployed and verified; W6 re-read with W2 present | Integration owner | 11:30–13:30Z | W2–W5 | Fly |
| W8 | Final report and budget | Report in the owner's format on branch claude/brain-intelligence-recovery-s0dl4l | Integration owner | 14:30Z | all | — |

Spending safeguard for W6: every GPU start goes through `runpod-launch` with a Brain-enforced billing cap. Between steps the pod is stopped, so nothing bills while engineering waits.

## Status log
- 07:36Z: W1 deploy 44036476327 is at "Deploy to Fly". W2–W5 agents launching.
