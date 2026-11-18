# Overnight completion — 2026-11-18 (deadline 15:00Z)

Coordinator: session_01QF5Tk7etm6MGmaFuHMd6eZ (this record). Release and test-window owner: the same session. Execution coordinator session_01QF5Tk6gJZ5UNMYcbPxbsu1 holds its own merges until the launch.

## Persisted state (resume from here after any restart)
- **Launch release:** Deploy **44252210701** on **1b805f3e**. Contents:
  - #1085: R1, fact supersession (Oppizi 0.47 → 4675).
  - #1082: R2, per-buyer volume.
  - #1086: R3, win rate / buyer count.
  - #1083 and #1088: test-timing fixes.
  - #1081: admin.
- **Previous release:** Deploy 44247254003 on a37583f0 failed shard 2 (the F2 test timed out, 30 s under load; about 12 s alone, not a regression). #1088 fixes it. That release was cancelled.
- **Live on production:** 573eb22a (#1078), since 04:15Z.
- **Gate:** free runpod-report hours=3 and hours=12, plus brain_operator_goal_plan(wst_7b4fcbb5f2384f31b6c3), about 25 min after Fly.
  - It passes when a genuinely accepted answer reaches the correct plan and is used economically correctly.
  - A stored claim alone is not a pass.
  - The postcard case must be economically right; no forced score.
- **Persistent wake:** send_later trig_01NERGa42jwnUSzBJiJ846tR at 07:55Z.
- **Launch (authorized, not yet run):**
  - `cheap-lane runpod-launch budget_usd=66 budget_window_hours=12.5 recipes=gpt-oss-120b-big max_usd_per_hour=5.5 runway_hours=12 tool_score=0.79`
  - Before launching, check `gh run list -w cheap-lane.yml` to see whether a launch already exists.
- **Money (as of 01:47Z stop):**
  - RunPod $114.17, spend $0/h.
  - About $160.44 of the $250 ceiling used, about $89.56 left.
  - The $66 launch cap is committed only when the launch runs.

## Assignments
| Task | Required result | Owner / job | Depends on | Est. | Verification | State |
|---|---|---|---|---|---|---|
| Launch release | live on Fly | this session / Deploy 44252210701 | — | ~07:25Z | Fly success | RUNNING |
| A. Postcard economic meaning | price vs supply cost correct; fix filer if wrong | agent GA / claude/ga-fact-meaning | — | ~07:20Z | test with the exact claim + plan read | RUNNING |
| B. Rounds not finishing | root cause of RESEARCH_NOT_FINISHING, fix | agent GB / claude/gb-rounds-finish | — | ~07:35Z | test + production round states | RUNNING |
| C. Spend cap and restart safety | cap, ceiling, idle, deploy-restart behaviour verified | agent GC / read-only | — | ~07:15Z | code + launch logs | RUNNING |
| Gate | research → plan, economically correct | this session | launch release, A | ~07:50Z | free reports + goal plan | QUEUED |
| Launch | 12h H200 run started and supervised | this session | gate, C | ~08:00Z | pod serving, billing, cap | QUEUED |

## Schedule, worked back from 15:00Z
Measured durations:
- Deploy gate: 45–55 min.
- Model load: 7–9 min.
- Free report: about 4 min.
- Backfill tick: up to 15 min.

| Milestone | Latest time |
|---|---|
| Release-candidate cutoff | **12:45Z**: merge by then; live about 13:40Z |
| Required verification start | **13:40Z** |
| Final evidence | **14:30Z** |
| Report delivery | **14:50Z** |

## Owner decision 06:4xZ: the $250 additional-infrastructure ceiling is removed
Owner's words: "Get rid of the $250 shit, just make sure you are spending properly."

Spending rules that still apply:
- Every paid run has its own cap and automatic shutdown (§38).
- Spend is bounded by the funded RunPod balance ($114.17).
- Nothing runs idle.

Launch configuration, updated:
- **Primary:** H200, `budget_usd=66 max_usd_per_hour=5.5`, which is 12.25 h × $5.29 = $64.80.
- **Fallback, used only if no H200 is offered:** B200, `budget_usd=99 max_usd_per_hour=8.5`, which is 12.25 h × $7.99 = $97.88.
  - The B200 was refused before only because of the $250 ceiling.
  - It fits the $114.17 balance and leaves $16 for one verification window.

## C. Spend-safety finding (07:0xZ): a launch blocker, fixed in PR #1089 (not yet merged)
- **The defect:** the supervisor in the Brain server (runpodPod.ts) caps a ROLLING 12.5 h window. After $66 is spent it frees budget minute by minute and restarts the pod. In simulation, 20 h with research waiting billed $105.54 against a $66 cap. `runway_hours` does not stop anything at 12 h. This breaks §38.
- **The fix, #1089:** `runpod-launch` sets BRAIN_RUNPOD_BUDGET_FROM, which fixes the window from the launch time. When the window ends the pod stops and nothing restarts it.
- **Second defect, same branch:** B200 is tried before H200. An over-ceiling B200 is created and then deleted, and the H200 is never tried.
- **Sequencing:**
  1. The gate evidence comes from release 44252210701.
  2. #1089, together with A and B if they are ready, ships in the NEXT release.
  3. The launch happens only once #1089 is live.

## 07:0xZ updates
- **C, done:** #1089 now also tries the cheapest GPU within the price ceiling first and never creates a pod above it.
- **B, done:** #1092. The free lane was held at 2 slots per model.
  - **Cause:** stageCapacity.chooseConstraint names commercial execution as the constraint. Its rate is 0 with no grant, so its time to clear reads as infinite, and that blocks all research growth.
  - **Effect:** goal fragments wait for hours, so missions don't end and rounds stay OPEN.
  - **Fix:** skip a stage that is not run by the free lane and processed nothing.
  - **Not yet fixed:** two never-claimed items (orc_83fa…, orc_f96e…) and the low evidence-gate pass rate.
- **Next release:** #1089 and #1092 merge automatically at 44252210701's Fly step, then one Deploy.
- **D (new, agent GD / claude/gd-fragment-faults):** WORK_FAULTED, 1,143 over 7 days. Diagnose after #1077 and fix the dominant mechanical cause.
- **A (postcard economic meaning):** still running.

## A, done (07:1xZ): the postcard figure is a supply cost, not a buyer price. Fix: PR #1091
- **The arrangement** mpx_a8f5f34d435f48af9a57 is a BROKER presale, pooled. Slot buyers pay the operator, and the operator buys the run from a printer.
- **The round asked two things:** (1) what slot buyers pay; (2) the fixed cost of one shared run.
- **The answer** "Oppizi $4,675 for 10,000 homes, all-in" answers (2).
- **Consequence:** the 4675 that #1085 files as price_per_unit, now live on 1b805f3e, would overstate revenue. **Any positive score for 2821cce3c372 on 1b805f3e is NOT gate evidence.**
- **#1091 fixes it:**
  - supplier quotes are filed as contractor_rate_per_unit (cost);
  - wrong facts are superseded;
  - the $0.259 → $259 parse bug is fixed.
- **The plan after #1091:** value unknown, run cost $4,675, no positive score. That is correct. The next research needed is a published slot price.
- **Next release:** #1089 (spend safety), #1092 (capacity gate) and #1091 (supply cost), merged at 44252210701's Fly step.
- **Gate evidence must come from a claim whose economic meaning is correct**, for example clm_1468e302 ("days to usable cash"), which entered plan inputs at about 00:54Z.

## 07:08Z
- Release **1b805f3e** went live at 07:07:56Z (Deploy 44252210701). Gate reports run at about 07:33Z.
- **Safety release:** **Deploy 44256547569 on d4732f8d**, dispatched 07:08Z. Contents:
  - #1089: fixed-window spend cap, cheapest GPU within the ceiling.
  - #1092: capacity gate.
  - #1091: supplier quote filed as cost.
  - #1093: verify replies read.
- **Launch waits for d4732f8d to be live**, expected about 08:00Z. The spend-safety fix is mandatory.
