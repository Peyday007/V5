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
- 07:39Z: W1 live on eda04071 (Fly success).
- 07:43Z: W6 first launch failed with $0 billed. COMMUNITY H200 had no capacity, and SECURE at $5.29 was over the $4/h ceiling.
- 07:50Z: W6 stage 1 live. Pod c316n2e7hp4up4, SECURE H200 at $5.29/h, Brain cap $12 per 2.5 h, ready in 265 s. Readings at 08:50Z.
- 07:47Z: W4 PR #1028 (queue flow, pressure, plan derivation, information-use trace) merged; deploy 44041630154 running.
- 07:48Z: new W9, free-lane RESEARCH_VERIFY replies with no JSON. These dominate the 315 jobs not accepted in 6 h, so they are ineffective retries. Agent assigned; PR due 10:45Z.
- 08:02Z cash report: the 10 newest missions all went to the goal tier; goal rounds at 2 AWAITING_LAUNCH (was 9), 1 ANSWERED, 3 PARKED, 1 RESEARCHING. Monetization questions are still 13 ANSWERED / 490 UNRESOLVED (historic; #1023 only went live at 07:39Z).
- 08:14Z: RC2 = 7cfcde99, deploy 44044888041. It carries:
  - #1028 W4 instrumentation.
  - #1029 W3 F3e.
  - #1031 W2 F2: arrangements read evidence (price confirmed).
  - #1032 W10: synthesis recovery scoped to the current round.
  - #1033 W5: the two Postgres flakes, whose root causes were in the tests.
  - #1035 W11: the free lane admits commercial items that have no bin, after it sat idle beside 23 waiting items.
- Release 3, due around 11:00Z, takes the independent review's findings plus W9:
  - W2b: arrangement buyer ids go into inference, volume/hours are inferred, and candidateFromArrangement uses the inferred inputs.
  - W3b: each declined question becomes an explicit assumption or next action.
  - W10b: the recovery exclusion is scoped to the round, and an attempts-exhausted bin gets a regrant.
  - W9: VERIFY replies with no JSON.
- Troubleshooting session: the goal's 15 Routine bins are ruled out as a blocker (§84/§85, the free lane works them). The budget-cap evidence (V7) stays valid. The textFact provenance finding was passed to W2.
