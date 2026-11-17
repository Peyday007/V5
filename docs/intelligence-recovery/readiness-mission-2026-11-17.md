# Readiness mission — execution record (2026-11-17)

**Coordinator:** session_01QF5Tk6gJZ5UNMYcbPxbsu1 (execution takeover, owner's message 17:20Z).

**Deadlines:**
- **Original deadline: 2026-11-17 15:00Z (10 a.m. Detroit). MISSED.** The troubleshooting session delivered at 15:00:47Z, and its verdict was NOT READY.
- **Recovery deadline: 2026-11-17 19:00Z (2 p.m. Detroit).** It was set by the owner and is enforced by scheduled tasks. The session may neither move nor remove them:
  - deadline: `trig_0128wMWrLaMyhjhUUUnyGGPR` (19:00Z)
  - warning: `trig_016hip7BecGi9cu4vvANZTCo` (18:35Z)

Scope, per the owner: the repairs Brain needs to absorb the large research workload and use it in planning and learning, plus verified readiness, the operating configuration and the next 12-hour budget. This mission covers neither all 175 Release 01 requirements nor the $10K outcome.

## Sessions

| Role | Session | Owns |
|---|---|---|
| Execution coordinator | session_01QF5Tk6gJZ5UNMYcbPxbsu1 | T0, T2, T3, T5, T6 |
| Intelligence-recovery (integration owner) | session_01QF5Tk7etm6MGmaFuHMd6eZ | T1 and the W-series repairs |
| Troubleshooting (independent verification) | session_01QF5Tk8yqoNKM3DaqDLzRiy | T4 |

## Tasks

| TASK | ACCEPTANCE CHECK | OWNER | ACTUAL JOB ID | DEPENDENCIES | EST. REMAINING | STATE |
|---|---|---|---|---|---|---|
| T0 Deploy W16 (#1057) + W15 (#1058) | production serves 56bc7f12 | intelligence-recovery | Deploy run 44127191670 | Postgres gate | 0 | VERIFIED: Fly live 17:24Z |
| T1 Capped GPU GO test on 56bc7f12 | runpod-report hours=1: GPU accepted claims ≥ 10, goal claims > 0, pressure not SHEDDING; pod stopped after | intelligence-recovery | cheap-lane launch run 44136684089 (17:24Z); report and stop ids to follow | T0 | report ~18:13Z | RUNNING |
| T2a Reconcile stale delivery flag, repair-res-15-5-2 | campaign recorded delivered by #1054 | coordinator | factory.yml run 44136362776 ("recorded 1 campaign(s) as delivered by #1054") | none | 0 | VERIFIED 17:22Z |
| T2b Knowledge-velocity repair (scope granted: server/repos/feeds.ts) | PR #1059 tests pass; merged and deployed after the T1 window | coordinator | PR #1059; typecheck + test:impacted 31 files, 313 tests passed (local task bgfk2tsqp) | T1 window closes (stable release candidate) | ~40 min after T1 | QUEUED (held for release stability) |
| T3 Next-12h budget and launch instruction | itemized from measured $/h, load time, cap, balance | coordinator | inputs: T1 report, RunPod survey | T1 | 10 min after T1 | QUEUED |
| T4 Independent verification on 56bc7f12 | (a) on-topic sources, (b) pressure and stalls, (c) accepted claim → plan decision, (d) cost ledger and cap | troubleshooting | read-only reports; run ids to follow | T0 | by 18:45Z | RUNNING |
| T5 Research-to-planning chain | latest plan derivation cites accepted claims; reach moved by research | coordinator (evidence via T4c) | earlier evidence: scenario run scr_2fdb656c (11:45Z), reach 0.09 → 0.51 → 0.54 | T4 | — | VERIFIED before W15/W16; re-reading on 56bc7f12 in T4c |
| T6 Questions published sources cannot answer | a declined or unanswerable question becomes a bounded check or Brain-judgement, not a dead end | coordinator | #1037 (bounded check), #1040 (Brain-judgement not commissioned), deployed in release 6 | — | — | VERIFIED (deployed in release 6); production count re-read in T4 |
| T7 Release 01 program (175 requirements) | — | Factory coordinator (program fpg_ea512f54974d4ff39a84) | campaigns building: ventures-d0-p3-prep, portfolio-d1-p1, product-ui-d0-p1, knowledge-velocity-d0-p1 | — | out of scope | OUT OF MISSION SCOPE |

## Critical path

T0 (done 17:24Z) → T1 (pod load ~6 min, 42 min serving, report) → T3 → the 19:00Z report.

More agents or a bigger GPU cannot shorten T1: it is a fixed measurement window on one production. T4 runs in parallel with it. T2b waits for T1 so that the release under test does not change.

## Orchestration limitation (stated, not removed)

Hermes and Factory have no deadline-aware staffing or resource adjustment for cross-session work.
- **What exists:**
  - Factory's program coordinator, which dispatches campaigns by dependency;
  - the engineering watchdog, which continues idle work;
  - the finish-ledger deadline scheduler (the scheduled tasks above).
- **How this mission runs:** session owners plus those mechanisms.
- **Not built:** a new orchestration mechanism. The owner forbade one, and it would not shorten T1.

## Verdict at 19:00Z: NOT READY for the paid 12-hour GPU run

All readings below are on production 56bc7f12 (W15 #1058 + W16 #1057, live 17:24Z). Sources: runpod-report 44148299685 (17:31–18:31Z, includes the T1 GPU window), connection-report 44139339578, cash-report 44139346478, and the T4 readout from the troubleshooting session.

| Readiness requirement | Result | Evidence |
|---|---|---|
| Relevant repairs deployed and verified | PARTIAL | **W15:** planner stalls gone at idle (NORMAL; 1 stall ≥2 s against 41 before). **W16:** the GPU now yields 16 accepted claims (16 surviving, 100% sourced, 0% refuted; 0 before), but ~64% of GPU fragments still fail on unreadable or off-topic sources (26 submitted, 103 not accepted). |
| Representative workload at measured sustainable capacity | PARTIAL | 101 work items arrived and 106 finished; the queue drains. **SHEDDING under GPU load:** Brain CPU 85% on 2 vCPU, so the controller shrank the GPU 12 → 6 slots (6.03 busy on average). The sustainable GPU concurrency is CPU-bound at about 6. |
| Accepted research retained and influencing a planning decision | FAIL for new research | Older evidence still drives the plan (32 of 68 inputs research-fed, 12 claims cited; reach 0.09 → 0.52, p50 $26,150 → $40,700). But in the test window `TRACE claims 9 stored 0 in_plan 0 retained 9` and `newer_claims 0`: this run's accepted goal claims were kept and did not reach an opening or a plan input. Separately, no new open question has been commissioned since 11-12. |
| Cost accounting and spending protection | PASS | GPU COST $2.20 measured (25 min at $5.29/h, $0.138 per accepted claim). The $11 / 1.5 h cap and auto-stop are set. The RunPod survey reads the balance. |
| Itemized next-run budget | DONE | Below. |

### Blockers to READY, with owners

| Blocker | Owner | Acceptance |
|---|---|---|
| B1: new accepted goal claims do not become openings or plan inputs (stored 0, in_plan 0), and commissioning has opened no questions since 11-12 | intelligence-recovery (W-series) | in one runpod-report window, TRACE stored > 0 and in_plan > 0, and PLAN_DERIVED newer_claims > 0 |
| B2: Brain CPU (2 vCPU) caps the GPU at ~6 slots and reads SHEDDING | intelligence-recovery | pressure not SHEDDING at ≥ 6 GPU slots, by a larger Brain machine or a CPU fix |
| B3: ~64% of GPU fragments fail on unreadable or off-topic sources | intelligence-recovery (W16 follow-up) | GPU not-accepted share < 50% |

### 18:45Z: blockers are running, each with an engineer

All three run in parallel, owned by the intelligence-recovery session, with a merge only once green. Paid compute stays at $0 until B1's acceptance holds.

| Blocker | Branch | Started | Notes |
|---|---|---|---|
| B1 | `claude/w17-claims-reach-plan` (W17) | 18:38Z | PR due ~19:15Z. First settles whether this is a defect or a timing effect, where claims convert only at round synthesis. |
| B2 | `claude/b2-capacity` | 18:44Z | The integration owner reads B2 as **non-blocking**. The machine is 72% idle, loop p99 61 ms, and SHEDDING comes from the DB workload pool at 7/8 busy with 0 waiting. It first checks whether the label and the controller's 85% reading are mismeasured. Corrective action, if one is needed: Fly performance-cpu-4x. |
| B3 | `claude/b3-fragment-sources` | 18:44Z | — |

**Troubleshooting clearance at 18:40Z: NO.** The only blocker is B1.
- F4 (GPU yield) is closed: 16 claims in 25 min, against 2 per hour before.
- The event-loop stalls are closed: p99 61 ms, against 10–20 s per 120 s before.

### 18:46Z: the integration owner's final T1 reading (stop run 44151107368)

- **GPU yield:** RUNPOD_ACCEPTED_CLAIMS 24 in 30 min of serving, all 24 surviving, about 48/h. GPU cost $2.65, or **$0.11 per accepted claim**.
- **Pressure:** **NORMAL** at this reading. DB workload 3/8 busy, p90 18 ms, 0 overload failures. The earlier SHEDDING was a transient from DB-pool occupancy, so B2 is a label or threshold question, not missing CPU.
- **Pod:** dq58fdmn3ww40g is EXITED. Spend is $0/h and the **balance is $131.34**.
- **READY:** still controlled by B1 alone, with W17 finishing its tests.

### 18:58Z: B2 corrected (the integration owner)

- **SHEDDING is real.** It is the event-loop stall rule at `pressure.ts:106`. Connection report 44150274579 shows 12 s stalled per 120 s from 18:28Z, in 2–3 s stalls, coming from `russell:project-kernels` and `cash:runMonetizationLedger`, plus 4–11 s of GC per 60 s on a 1.6 GB heap.
- **The 85% "Brain CPU" is the event loop, not the machine,** which is 72–83% idle. A larger VM buys nothing, so there is no fly.toml change.
- **Jobs:**
  - PR #1063: diagnostics only; reports now print the shedding reason and the loop/machine split.
  - B2b, branch `claude/b2b-loop-stalls`: fixes the kernels and ledger stalls. That fix lifts the 6-slot GPU cap.
- **Operating consequence:** until B2b lands, the controller holds the GPU at about 6 slots. The budget above already assumes that.

### 18:47Z: B3 root cause and fix (PR #1064, green)

**Root cause.** `discover.ts:53` has `MAX_WAITERS=12`. The web search returns an empty result, without searching, once 12 searches are waiting. That limit was sized for 2 lane slots. The GPU runs up to 14 slots, each firing 2 searches, so most searches were dropped. The fragments then fell back to URLs the model remembered: DEP, NAICS, and 403/404 deep links.

**Fix.** The limit now follows the expected wait (12–64, about 30 at 4 s spacing), with the same DuckDuckGo request rate.

**Release batch (one candidate, so tests are not cancelled).** Deploy 44149147729 for #1059 first. Then #1063, #1064 and W17 (B1) together, if W17 is ready.

### After the deadline, 19:07Z: B1–B3 fixed and released as 04b754ce (deploy 44154940663)

| Fix | PR | Cause |
|---|---|---|
| B1 | #1062 | **A defect.** `research.ts` signalledClaims read the 40 oldest candidate claims and then dropped the unfileable ones, leaving them unmarked. They blocked the head of the line for good, so harvest never saw a new claim. Fix: page past dropped rows. No schema change. |
| B2b | #1065 | The 2–3 s stalls came from Brain's own stall profiler, restarting every 60 s across a 1.6 GB heap. It now restarts only after a real stall or every 30 min. The ledger writes are also cheaper. |
| B2 diagnostics | #1063 | — |
| B3 | #1064 | The search waiter cap. |

**Verification is armed by the intelligence-recovery session.** Once Fly succeeds, it runs a capped GPU window ($11, $8.50/h, 0.75 h), then runpod-report hours=1 at about 42 min, then disconnect and stop.

- **B1 acceptance:** stored > 0, in_plan > 0, newer_claims > 0.
- **Also checked:** shedding and GPU slots.
- **Coordination:** no merges until the stop.

### 21:03Z: verification of 04b754ce. Still NOT READY.

- **Runs:**
  - launch 44165676119: pod tfhhepjhx6appc, H200 at $5.29/h, served from 20:14Z;
  - report 44174859590: hours=1, `SERVING_REVISION 04b754ce`;
  - disconnect 44175194196;
  - stop 44175385253: tfhhepjhx6appc EXITED.

| Check | Reading | Verdict |
|---|---|---|
| B1: newer_claims > 0 | `PLAN_DERIVED newer_claims 5` | fixed upstream (#1062 works) |
| B1: stored > 0, in_plan > 0 | `TRACE claims 5 stored 0 in_plan 0`. Accepted 20:42:11Z from open round mx-2821cce3c372 r1; last derivation 20:27Z; "no plan evaluation since"; plan evaluations 1/h | **open (B1b)** |
| B2: not SHEDDING | SHEDDING since 20:42:11.972Z: loop stalled 12 s of 120 s, 0.9 s after those 5 claims were accepted. Controller shrank the GPU 12→6→3 at Brain CPU 85–98% | **open (B2c)** |
| B3: not-accepted share < 50% | 60 of 149 GPU refusals are "no readable source" | improved, not closed |
| Throughput | 37 GPU jobs, 14 accepted claims, all lanes 23.6 accepted/h, peak 14 jobs at once (4 before) | below the target |
| Cost | $3.53 measured for 40 min; $0.095/job; $0.25/accepted claim | accounting works |

**Next owner.** The coordinator (this session) is root-causing B1b, where claim acceptance does not reach a plan derivation, and B2c, the 12 s stall on the acceptance path. Intelligence-recovery has been told and verifies the result.

## Next 12-hour run: budget (to be launched only after B1 is closed)

| Item | Resource | Quantity | Unit price | Subtotal | Basis |
|---|---|---|---|---|---|
| 12 h research run | RunPod H200 SECURE, gpt-oss-120b-big | 12.25 h (load + 12 h) | $5.29/h | **$64.80** | T1's measured price |
| Fallback if no H200 | RunPod B200 SECURE | 12.25 h | $7.99/h | $97.88 | 15:05Z quote |
| Free lane | OmniRoute free models | 12 h | $0 | $0 | measured |
| Hosting | Fly + Supabase | existing | — | not priced | not run-specific |

- **Expected yield.** T1 measured 16 accepted GPU claims in 25 min at a mean of 6 busy slots, about 38/h. Over 12 h that projects to roughly 450 GPU claims at about $0.14 each, plus the free lane at about 10/h. This is projected, not tested beyond 25 min.
- **Usable balance.** RunPod $131.88 at 18:33Z, still spending $5.325/h. Stop dispatched 18:36Z.
- **Remaining under the $250 ceiling.** About $105: $138.59 spent before T1, plus T1 at about $6.
- **Additional cash required.** None. Both $64.80 and $97.88 fit inside the balance and the ceiling.
- **Launch instruction, after B1 is closed.** One dispatch. The pod supervisor stops the pod at the cap:
  `cheap-lane.yml action=runpod-launch budget_usd=66 budget_window_hours=12.5 recipes=gpt-oss-120b-big max_usd_per_hour=5.5 runway_hours=12 tool_score=0.79`
  If H200 is unavailable: `budget_usd=99 max_usd_per_hour=8.5`.

## Spending

| Item | Amount | Basis |
|---|---|---|
| RunPod balance before T1 | $137.90 | intelligence-recovery, after the 16:17Z test |
| Previous GO test (16:17Z) | $9.16 incl. load ($7.32 GPU for 55 min) | runpod-report |
| T1 cap | $11, at $8.50/h max | launch run 44136684089 |
| Measured price | SECURE B200/H200 $7.99/h | RunPod quote |

## 23:20Z: verification of 08cba93f (serving fa60ad5e). Still NOT READY.

Runs: launch 44187098347 (H200 $5.29/h, 50 min) · report 44195685485 · disconnect 44197423405 · stop 44197575890 (pod yej3jvbix0vo6k EXITED, $0/h, balance $120.77).

| criterion | measured | verdict |
|---|---|---|
| B2 pressure | pressure NORMAL, no SHEDDING; the controller still halved the GPU 12→6 twice at 90–95% event-loop CPU; 6.64 slots busy on average; peak 14 jobs at once (4 the hour before) | PASS at 6 slots; 12 not sustained |
| B3 web search | 3 of 9 refusals "no readable source" (was 60 of 149) | PASS |
| throughput / cost | 46 GPU jobs, 12 accepted claims, 47 claims 100% sourced, 0% refuted; $4.41 → $0.096/job, $0.37/accepted claim | measured |
| B1 research → plan | plan re-derived 6 times in 2 h (21:13 … 22:50), so the plan does re-read; but the cash goal got 0 accepted claims in the window (5 jobs, 3 refused), 0 rounds opened or harvested, 6 open; its 15 research bins have sat READY at priority 8 since 2026-11-14 waiting on "the next free Routine" | UNPROVEN: no new research reached the goal to trace |

Remaining blocker: the cash goal's own research does not run. Its bins wait on Claude Routines (reserved for Brain improvement by §84) instead of being served by the free lane / GPU, so a 12 h run would spend most GPU time on other projects' audits and verifies and would not feed this goal's plan. Next fix: serve the goal's READY bins on the free lane, then re-run the capped window and require TRACE stored > 0 and in_plan > 0.
