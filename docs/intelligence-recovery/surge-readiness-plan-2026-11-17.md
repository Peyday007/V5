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
- 08:28Z: release candidate LOCKED at bd5e0419, deploy 44046891820. It carries #1028, #1029, #1031–#1038, adding #1034 (W9, verify JSON), #1036 (W10b), #1037 (W3b) and #1038 (W2b). Review findings 1–3 are closed in code. Fly expected around 09:15Z. After that, only a defect found in verification merges.
- 08:50Z W6 stage 1 reading, eda04071 + #1028 pending. Pod c316n2e7hp4up4, SECURE H200 at $5.29/h, 07:50–08:50Z:
  - **GPU:** 221 jobs (24 not accepted, 11%), about 38 s each, 4.22 slots busy on average. It produced 2 accepted claims. $4.41 for 50 min, which is $2.20 per claim.
  - **Lane-wide:** 20.4 accepted claims/h; this goal 6.8/h, up from 0/h at 05:45Z. The goal's jobs peaked at 7 at once (72 jobs).
  - **Plan runs:** median 0.5 s. Event loop stalls of 2–3 s inside evaluatorPool.ts.
  - **Pressure:** DB NORMAL, p90 21 ms, 33 pool-checkout timeouts felt. RSS 1.7 GB, peak 2.8 GB. CPU 28% of one core.
  - **Binding constraints:**
    - Research-mission ceiling: about 16 missions, 568 ideas waiting (troubleshooting reading 08:28Z). Owner: W12.
    - 120B fragment answers dropped by Brain's checks: 20 in the hour, so it is HELD BACK from fragments. Owner: W13.
  - **New owners:** W2c (planner CPU index) and W3c (hypothesis-check cap, PR #1040 ready).
- 08:55Z: GPU stopped, $0/h. RunPod balance $169.26: a deposit of about $100 landed after 07:43Z, when the balance was $75.43.
- 09:00Z: RC bd5e0419 FAILED the deploy's SQLite tests with FOREIGN KEY constraint failed in carryFigures → recordPathFact (#1029). Bisect: eda04071 clean, 74b0a3c3 fails. Production is still on eda04071. Fixed by #1041.
- 09:13Z: release 4 = f4eb5352, deploy 44051739781. It is bd5e0419 plus:
  - #1041, the FK fix;
  - #1039, W12, the mission ceiling grows with the GPU's served sequences and with waiting ideas;
  - #1040, W3c, the hypothesis cap.
  W12 found each mission is one fragment run in strict stage order, so model jobs scale about 1:1 with live missions. Still open: W2c (planner CPU) and W13 (120B fragment drops).
- 09:21Z: release 4 (72008cd2, adding #1042 W2c planner CPU: 19.6 s → 0.9 s on a 400-arrangement fixture) passed every test and the Postgres gate. Fly skipped it, superseded by #1043.
- 09:22Z: release 5 = 4cec7709, deploy 44054816761. It is release 4 plus:
  - #1043, W13: an empty claim list states why.
  - #1045, W13b: a gap fragment keeps its requirement's source rules, and a stated empty list is neutral for fitness.
  W13 root cause: the 120B's fragment failures were empty lists under official-only source rules, which search could not satisfy. Brain's checks were not dropping valid claims.
- 09:47Z: release 5 (4cec7709) FAILED the Postgres gate. Factory's campaign merges #1026/#1027 (RES-15-5, META-18; about 7.9k lines) landed on production at about 09:30Z, inside the release. Two failures:
  - res-15-5-1-cost-once, PG 22P02, from Factory's code. Owner: a new engineer.
  - discoveryLaneSurge, PG 5 ≥ 32, from W12's test. Owner: W12.
  Both reproduce locally. Fix PRs due 10:20Z, then release 6. Production is still on eda04071, and the stage-2 GPU is not launched.
- 09:56Z: release 6 = 8885038e, deploy 44060012669. It adds:
  - #1046, from another session: fixes for the two tests that fail only on Postgres;
  - #1048, W12: pool-precondition cases for its test.
  #1047 closed as superseded. Both tests pass on both backends locally.
- DECIDED: no Factory merge hold. No merge-only hold exists; the only lever, pausing workers, would break the standing order "do not disconnect Factory". Mitigation: re-dispatch Deploy on any superseding commit, and fix any breakage it brings.
- 10:45Z: release 6 = 8885038e LIVE (deploy 44060012669; all four SQLite shards and the Postgres gate passed). It carries #1028, #1029, #1031–#1036, #1037, #1038, #1039–#1043, #1045, #1046 and #1048.
- 11:02Z: W6 stage 2. Pod 2ua3kt3ftnd7n9, SECURE H200 at $5.29/h, loaded in 926 s (billed). Cap $16 per 3 h. Readings at 12:03Z.
- 13:00Z T-2h. W6 stage 2 (release 6, GPU 11:02–12:03Z):
  - **GPU:** 108 jobs, 111 not accepted, 0 accepted GPU claims, $4.85/55 min. Fragment answers are honest empty lists; the stated reasons say the fetched pages are off-topic (company contact pages, physics papers, GitHub about pages).
  - **Concurrency grew:** GPU 7.86 slots busy, free-lane jobs average 8.39 / peak 14. The controller grew the 120B 6 → 12 ("useful research waiting 88–119").
  - **Queue:** 189 arrived / 222 finished per hour, net draining. VERIFY backlog 20 (55 min); AUDIT 89 claimable (66 min). 59 ineffective retries, 54 of them fragments.
  - **Pressure:** SHEDDING. Event loop stalled 10–20 s per 120 s. CPU in planSet canonical, payerNamedIn and evaluatorPool. RSS 2.4 GB, peak 3.2 GB.
  - **Information use (proven):** plan reach 9% → 51% at 10:56Z (54% at 12:03Z), p50 settled $26,550. Plan model scm_b93979c3: 68 inputs, 32 research-fed, 12 distinct claims cited. Goal rounds: 6+ ANSWERED. Verdict NOT_VIABLE, PRICE binds.
- 13:05Z new owners:
  - W14: source relevance for fragments; findings 13:55Z, PR 14:20Z.
  - W15: planner CPU stalls; findings 13:50Z, PR 14:15Z.
  GPU being measured for its second hour, then stopped.

## Troubleshooting closeout — findings vs production (17:30Z, serving 56bc7f12)
The 15:00Z deadline was missed, and that is preserved in the record. The coordinator's registered recovery deadline is 19:00Z. The execution coordinator is session_01QF5Tk6gJZ5UNMYcbPxbsu1.

| Finding | Still active? | Repair (owner / PR) | Deployed in | Verification result | Next action |
|---|---|---|---|---|---|
| F6: commercial answers discarded at filing (lane-id mismatch) | No | #1023 (intelligence-recovery) | eda04071, 07:39Z; 56bc7f12 | Lane accepted claims for the goal went from 0/h at 05:45Z to 6.8/h at 08:50Z, and 13.4/h at 11–12Z | Closed |
| F7: goal research not running (unlaunched rounds, parked syntheses) | No | #1024, #1025, #1032, #1036 | 8885038e, 10:45Z | Goal-tier missions 10/10 newest at 08:02Z; goal rounds 6+ ANSWERED at 12:03Z | Closed |
| F2: constructed arrangements ignore research | No | #1031, #1038, #1042 | 8885038e | Plan model scm_b93979c3 has 68 inputs, 32 research-fed, with 12 distinct claims cited. Reach went 9% → 51% at 10:56Z, then 54% | Closed |
| F1: GO signal could not move | No (evaluation) | Corrected by review; plan reach used as the readable metric | — | Reach moved 9% → 54% from research alone | Closed |
| F3c: CHOICE answers need an exact token | No | #1020 | eda04071 | Goal rounds ANSWERED (above). A per-attribute ANSWERED share has not been re-read | Closed on the round evidence |
| F3e: questions no publication answers loop forever | No | #1029, #1037, #1043, #1045 | 8885038e | Fragment answers now state none_because, and a declined question becomes an assumption or next action. Seen in the 16:17Z NOT ACCEPTED reasons | Closed |
| F4: GPU research yield (accepted claims from the paid GPU) | **YES** | #1018, #1043/#1045, #1052, **#1057 (W16 source discovery)** | 56bc7f12, 17:24Z | 16:17Z (pre-#1057): **2** accepted/h, goal 0, with off-topic pages (arXiv, BLS, EDGAR search) | **Verifying now:** GO test run 44136684089 (cap $11, $8.50/h max), report around 18:10–18:15Z |
| Capacity: event-loop stalls, pressure SHEDDING | **YES** | **#1058 (W15 planner CPU)** | 56bc7f12, 17:24Z | 16:17Z: SHEDDING (DB healthy, p90 19 ms; stalls in planSet/payerNamedIn/evaluatorPool) | **Verifying now:** the same GO-test report's pressure line |
| Cost accounting and spend safeguards | No | #1001, #1005, #1011; Brain-enforced pod cap | live | The pod stopped at the cap and the balance was reconciled ($147.06 → $137.90 = $9.16 for the 16:17Z test) | Closed |
| F5: retained commercial learning loop | Non-blocking | — | — | The capability the run is meant to build | Not a prerequisite |

**The clearance depends on one thing:** the GO-test report on 56bc7f12. It needs GPU accepted claims ≥ 10/h, goal claims > 0, and pressure not SHEDDING. The intelligence-recovery session owns the run, and the pod stops automatically after the report.
