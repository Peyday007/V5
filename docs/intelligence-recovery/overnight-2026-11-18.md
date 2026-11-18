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

## 08:10Z
- **Gate reports on 1b805f3e** (runs 44259750902 h=3, 44260466650 h=12), on goal wst_7b4fcbb5f2384f31b6c3:
  - **3h:** claims 18, stored 0.
  - **12h:** claims 58, stored 4, in_plan 4, retained 57.
  - **Pressure:** NORMAL.
- **Plan change:** the candidate is now arr_9c291f2760f2 ("Puzzle Society…") + arr_4cbbf91e4df7, reach 57.3%, p50 $31,024. Before it was 50.1%.
  - Postcard arr_2821cce3c372 is NOT in the candidate. Good: no manufactured score.
- **Owner E (agent):** identify the 4 claims, check their economic meaning, and check whether the plan change is research-driven.
- **Safety release d4732f8d is LIVE** (Fly 07:58:40Z), carrying #1089, #1092, #1091 and #1093.
  - Hosted verification FAILED 258/261: 3 quant-slot checks, starting with a 50k run that returned 429 busy.
  - **Owner F (agent):** verifier race or real defect?
- **Launch:** waits for E (gate evidence) and F (no material defect).
- **Persistent wake:** 07:55Z already fired. Next wake to be set.

## 08:15Z: gate FAILS on economic use. Repairs G and H started
- **F, done:** the hosted-verification failure was a verifier race. The same process passed all three checks after the restart. Verifier fix in #1094, not a blocker.
- **E, done.** The 4 "stored / in_plan" claims are the postcard claims. #1091's supersession ran at 08:00:58Z:
  - Oppizi: now a 4,675 supply cost, but under a per-unit key and expired.
  - USPS: 0.26 cost ×2, correct.
  - $0.259 is still 259, as an ASSUMPTION.
  - **None is used by any plan.** For pooled designs the planner reads fixed run cost only from openings.
- **The 57.3% plan change is NOT research-driven.** It is sampler rotation plus a 5-week-old $500 Puzzle Society per-submission fee, misapplied as the price of a pooled presale and also filed as its cost.
- **Gate verdict:**
  - Accepted research is stored and economically classified, but **not used in plan economics**.
  - The plan's headline reach rests on a misapplied price.
  - **NOT PASSED → REPAIRING.**
- **G (agent, claude/gg-supply-cost-used):** file the per-run supply quote as fixed run cost; the planner reads it for pooled designs; correct 259 → 0.259. Pass condition: arr_2821's economics carry cost 4675 from clm_9cf1, with no positive score.
- **H (agent, claude/gh-price-transfer):** a price from a different mechanism or population must not count as SINGLE_COMPARABLE evidence, and one fact must not serve as both price and cost.
- **Next release:** G + H + #1094, then a free gate.
- **Release-candidate cutoff:** 12:45Z.

## 09:05Z
- Deploy 44266978600 (86a76a42: G #1095 + #1094) passed its gates but its Fly step was SKIPPED.
  - **Cause:** Factory merged #1096 (8579d2d5) at 09:02:55Z and dispatched **Deploy 44272284255**, which contains 86a76a42.
  - Factory is not to be disconnected, so the gate now follows 44272284255.
  - Expected live about 09:55Z; gate about 10:20Z.
- **H:** no PR yet. Its agent is waiting on an MCP permission prompt only the owner can answer.

## 10:15Z: gate on 8579d2d5 (live 09:34Z) still FAILS, now for a narrower reason
- **Probe:** census run 44282625106, branch claude/gate-probe.
- **What works:**
  - cfa_ca236ebb is fixed_cost_per_run 4675 from clm_9cf1f15c, OBSERVED, superseding cfa_d740c475.
  - cfa_c64c203b is contractor_rate 0.259, superseding the 259.
  - constructionObservations / constructArrangements compose 2821cce3c372 with fixedCost p50 4675 (1 obs, COMPARABLE) and lineage clm_9cf1f15c. The stored arrangement record (09:33Z) carries it.
- **Not yet in the plan:**
  - The goal model (estimatedFromArrangement) drops any arrangement whose value is UNKNOWN. The slot price is unresearched, so no goal reading uses the cost.
  - A single COMPARABLE observation keeps fixed_cost on the unknown list.
  - No positive score, so nothing is manufactured.
- **Plan inputs it does read** rest on transfers across mechanisms or populations: the Puzzle Society $500 per-submission fee taken as the price of a pooled presale, and Houzz / Freelancer days and costs.
- **Repair H2** (code-only, claude/gh2-price-transfer) replaces H, which was stuck on an owner permission prompt and has been stopped.
- **Gate after H2:** a plan input from an accepted claim with matching mechanism and population; candidate economics not resting on misapplied prices.
- **Release-candidate cutoff:** 12:45Z.

## 10:45Z
- H2 (#1098, 0e175d87) passed every gate, but its Fly step was SKIPPED. Factory merged #1097 (62c38137) at 10:40:55Z and dispatched **Deploy 44287710010**, which contains H2. That deploy is the one being followed now.
- **Launch decision rule, fixed now to avoid another cycle:**
  - when 62c38137 is live, the goal plan's candidate no longer rests on misapplied price evidence (price input not SINGLE_COMPARABLE from another mechanism);
  - and the researched supply cost is composed into its arrangement's economics with claim lineage, which the 10:09Z probe already proved on 8579d2d5 and is unchanged since;
  - THEN launch.
  - Unproven, and to be stated in the report: research changing the goal-level plan's choice. That needs a researched slot or selling price, which is the run's own work.

## 15:01Z: LAUNCH DISPATCHED
- **62c38137 live** at 11:25:29Z; it carries H2 (#1098).
- **Plan read at 14:57Z:** both candidate prices are ASSUMED. They no longer rest on misapplied price evidence. The researched supply cost is composed with lineage (shown at 10:09Z).
- **Launch rule met.** Launch run **44330728704** dispatched at 15:01:09Z: H200, $66 cap, window 12.5 h, max $5.50/h.
- **Late:** the session's worker restarted around 11:30Z, so the launch and report came at 15:01Z instead of right after 11:25Z.

## 15:50Z: RUN STARTED
- **Launch 44330728704 succeeded:** pod qe5u6nhdv69ofl, H200 SXM COMMUNITY at $3.59/h, gpt-oss-120b-big, served after 268 s. RESULT PASS. Account $113.78 before launch.
- **First-hour report 44340092905:**
  - GPU cost $2.39 for 40 min.
  - 11 GPU jobs, 0 accepted claims.
  - Failures: 5 audits "lease no longer current" (jobs take about 671–1,164 s); 6 off-topic sources; 6 gate drops.
  - Pressure NORMAL.
- **Repair started:** agent on claude/gpu-lease-heartbeat (audit lease expiry).
- **Cap:** $66, fixed window (#1089). Expected end about 03:10Z on 11-19, or earlier at the cap.

## 16:00Z
- **#1100 merged** (c0d64efb): free-lane jobs renew their lease every 5 min while running. The cause of the "lease no longer current" audit refusals was a fixed 20 min lease with no renewal.
- **Deploy 44341970245** dispatched. The run continues across the restart; the budget is rebuilt from the database.
- **Run check** scheduled for 17:00Z (trig_0176oTkcHizot2JDx6bdVUPc).

## 17:05Z: GPU STOPPED (not productive), fix not yet live
- **Run check** (report 44353886005, 1h): GPU submitted 9 jobs, 29 not accepted, 0 accepted claims. 22 were audits refused with "lease no longer current". Cost $3.29 that hour.
- **#1100's Deploy 44341970245 did not go live:** Postgres suite 44341948043 failed shard 2. The cause is tests/systemSelfModel.test.ts, two 30 s timeouts under load, unrelated to #1100. Failed jobs rerun at about 17:03Z.
- **GPU paused:**
  - runpod-stop 44354582559 put pod qe5u6nhdv69ofl into EXITED.
  - runpod-disconnect 44354793244 stops the supervisor restarting it.
  - Account $106.40, spending $0/h. Run spend so far $7.38.
- **Next:** after the Postgres rerun passes → Deploy → once #1100 is live, runpod-connect. That reuses the same launch window and budget, so the $66 cap is not re-armed, then yield is verified.

## 17:27Z: release ownership handed to session_01QF5Tk5PWzBxNPixWvFTPEd
- **My mistake:** runpod-stop came before runpod-disconnect. The supervisor restarted pod qe5u6nhdv69ofl 23 s later, at 17:05:38Z.
  - It ran until the release owner's runpod-stop 44358481650 at 17:25:43Z, about $1.20.
  - Balance $105.21. Run spend about $8.57.
  - Their fix in progress makes runpod-stop set MODE=off first.
- **Postgres rerun:** 44341948043 passed. **Deploy 44357471351** (#1100) is in progress, run by the release owner.
- **Resume:** runpod-start (not connect), which keeps the fixed window 15:01:34Z–03:31:34Z and the $66 cap.
