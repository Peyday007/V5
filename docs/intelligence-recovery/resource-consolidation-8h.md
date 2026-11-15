# Resource consolidation: eight-hour results (directive of 2026-11-15T07:45Z)

Read 16:25Z. The report was due 15:46Z and is about 40 minutes late, because this session's worker restarted. All figures come from production: `brain_operator_capacity`, Goals census runs and Deploy logs. Resource classes are never added together. Every sample is in `resource-allocation.md`.

## A. Initial allocation by surge (07:46Z)
- **Surge A (down curve):** closed at 02:45Z with every critical item verified. It had no dedicated agents left. Its reserve was Deploy's own verification, the hourly report routine, Hermes' self-scheduled runs, and incident response by this session.
- **Surge B (up curve):**
  - This session plus 2 worktree engineers (free lane, research launch).
  - Hermes, the director, on `auto/best-coding` (the free model switchboard).
  - Brain's four pools: Routines 3/12 (1 waiting), free lane 6/14 (11 waiting), research slots 14/16 (503 waiting), Factory 2/3 (1 waiting).
  - RunPod: 1× RTX 2000 Ada running Qwen3-4B.

## B. Current allocation (16:22Z)
- **Surge B:**
  - This session plus 1 engineer (the stalled plan read; see L).
  - 5 engineer assignments completed today: free lane, research launch, constructed rounds, back-fill payer matching, more payer phrasings.
  - Hermes is directing. It paused 4 zero-value goals to focus capacity on the $10K goal (decisions opd_673a…, opd_1eb0…, opd_8b65…, opd_8f4f…).
- **Pools:**
  - Routines 3/12 (1 waiting).
  - Free lane 8/14 (17 waiting).
  - Research slots 18 running against a computed capacity of 13 (509 waiting).
  - Factory 0/0 (1 waiting).
- **Surge A:** unchanged reserve. Factory released twice (Deploys 1093 and 1094).

## C. Measured utilisation, per class
Instantaneous running ÷ capacity, one row per sample:

| class | 07:46 | 07:49 | 08:10 | 09:12 | 16:22 |
|---|---|---|---|---|---|
| Routines | 25% | 17% | 17% | 33% | 25% |
| Free lane | 43% | 57% | 75% (cap 4 after the restart) | 11% (cap 19, database backpressure) | 57% |
| Research slots | 88% | 69% | 81% | 94% | above 100% (18/13; cap recomputed from grants) |
| Factory | 67% | 67% | 0% | 67% | — (capacity 0) |

These are point samples, not time-weighted averages. There is no continuous utilisation series for the 10:58–16:22 window.

## D. Usable capacity freed from the down curve
- **Agents:** 0. Surge A had already closed before 07:45Z, so there were no agents to free. Its reserve is process-level (Deploy verification, monitoring), not agent slots.

## E. Capacity transferred to the up curve
- **Free lane:** capacity rose from 4–14 to 19 at the first post-fix sample (09:12). This was not a transfer between surges: part 8 fixed the code path that left slots idle while work waited.
- **Research slots:** the launch pass now takes ideas that fit a free grant slot. Running went from 13 to 15 out of 16 at 09:12, and to 18 at 16:22. The queue fell from 503 to 468 at 09:12; it is back at 509 because new ideas keep arriving.

## F. Down-curve capacity retained, and why
- **What is kept:** Deploy verification (both passes), Hermes' runs, and incident response by this session.
- **Why:** Surge A's backlog is non-critical. The one live operational finding, R-SLOW-RESTART, is Surge A's to fix (see H).

## G. Idle or wasted capacity, and what prevents its use
- **Research:** 508 of the 509 waiting ideas are in projects already at their grant's at-once ceiling. This is a §16 budget gate working, not idle routing.
- **Free lane, brain-a:** 6 of 12 used, held for two reasons: 45 provider-availability failures, and its database-pool share (12 of 24). This is backpressure working.
- **Free lane, RunPod:** 2 of 2 used. It is held because the constrained stage is commercial execution, which more model slots do not serve.
- **Routines:** "1 executable item, unexplainedly idle" in every sample since 07:46. This is an open finding with no owner yet.
- **Factory:** 0 free surfaces, 1 executable item.
- **This session (wasted time):** about 5.4 hours (10:58–16:22) because its worker process restarted. The overdue report and the late discovery of the plan stall (L) both come from that gap.

## H. Production headroom and stability
- **Deploys since 07:45:** 1087 ✓, 1088 released (pre-restart pass failed: R-VERIFY), 1089 blocked by a flaky test (fixed, #929), 1090 released (R-VERIFY), 1091 blocked by a flaky test, 1092 released, 1093 ✓ (fully verified), 1094 released.
- **R-VERIFY:** fixed by #932 and verified on production. The pre-restart pass was 261/261 on 1092 and 1094.
- **R-SLOW-RESTART:** the post-restart pass was stopped as too slow on 1092 and 1094 (1 of the last 3 passed). Handed to Surge A.
- **Load samples:**
  - Event loop lag of 3.9 s right after the 09:12 restart.
  - Database pool contended in the 09:12 and 16:22 samples.
  - `/healthz` at most 26 ms while a scenario run executed (1092, pre-restart).

## I. Engineering throughput, before and after
- **19:42–07:45 (before the directive):** parts 1–7 released, 11 root causes repaired (see the inventory).
- **07:45–16:25:**
  - 4 Surge B releases (parts 8, 9, #929 and #932).
  - 7 root causes fixed: free-lane stale exclusion, the free-lane failing-route test, the research launch window, the starved constructed-round gate, parked research counting as live, back-fill prose payers (two passes), and R-VERIFY.
  - 1 flaky test fixed.
- **Verified on production:**
  - Free-lane cap went from 4 to 19.
  - Research running went from 13 to 18.
  - Construction facts went from 19 to 43.
  - Buyer populations went from 21 to 39.
  - Constructed rounds in the last 24 hours went from 0 to 9.
  - Researched arrangements went from 0 to 8.
- **Lost time:** about 5.4 h of the window to the restart.

## J. Would more agents or compute shorten the critical path?
- **Not now.** The critical path is (1) plan reads stalled since 03:47Z, which is one code defect being fixed, and (2) buyer evidence (reply and close rates) that only outreach measurement can supply (A-10K, §94).
- **More compute would not help:**
  - The free lane is held by database backpressure.
  - Research is held by grant ceilings.
  - RunPod is held because inference is not the bottleneck.
- **Raising research grant ceilings** would launch more of the 508 waiting ideas. That is a §16 approval and does not touch the stalled plan.

## K. Additional money spent
- **$0** by Surge B. The RunPod pod ($0.19/h) is existing infrastructure and is not counted again.
- **Remaining ceiling:** $100 combined.
- The owner granted standing permission at about 09:35Z. Nothing has needed spending since.

## L. Time to a 90%-qualified $10K plan
**No reliable estimate is possible.** Two pieces of evidence prevent one.

1. **The plan is stale.** The last plan reading was at 03:47Z. Plan readings have stayed at 104 since 10:11 while evidence grew (facts 19→43, rounds 0→9). A reading on current evidence does not exist yet. An engineer was assigned to this at 16:25Z, and this is the critical path.

2. **The last reading.** At 03:47Z the verdict was IMPROVEMENT_REQUIRED:
   - Best reconstruction: 23.1% coverage (prepaid fulfilment), p50 $0.
   - Every strategy is NOT_VIABLE at the prices buyers are shown to pay (at most $265 reachable against $10,000).
   - Buyer ladder: 11 at B (evidenced), 0 market-test-ready, 0 buyer-validated, 0 collected.
   - Reply and close rates are unmeasured.
   - The gap: no opening is priced near the scale $10K needs, and conversion has never been measured.

Planned order once the plan reads again:
- See what 1,033 stored arrangements, 9 constructed rounds and 43 facts do to reach.
- Then measure conversion through Instantly outreach, which yields the reply and close rates that calibration needs.

A 90% certification needs calibration data that does not exist yet. Brain does not have the 10 finished accepted plans calibration requires. Nothing here will certify 90% on assumption.
