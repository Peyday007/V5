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
