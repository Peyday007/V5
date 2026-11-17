# Surge readiness report — deadline 2026-11-17 15:00Z (10 a.m. Detroit)

Written at 13:58Z and updated at 14:35Z by the integration owner, the intelligence-recovery session. Every number below names its production reading. Anything not measured says so.

## READY FOR THE LARGE RUN: **NO**

Brain now absorbs research and uses it in planning; the evidence is under INFORMATION USE. What it cannot yet show is that a paid GPU run produces accepted research. In two measured hours on release 6 (11:02–13:03Z), the H200 worked about 220 research jobs and produced **0 accepted claims**.

The cause has been found, and its fix (#1052) was merged at 13:52Z and is deploying. It has not been measured on production, so I will not certify it.

**Exact blocker.** The GPU's research yield after #1052 is unmeasured.

**Shortest action.** Deploy 44097071502 is live (14:40Z). Now run the one-hour capped test under HANDOFF (cap $6). GO if, for that hour:
- the GPU has ≥ 10 accepted claims (≤ $0.53 per claim at $5.29/h);
- the goal has > 0 accepted claims;
- pressure is not SHEDDING.

## VERIFIED REPAIRS (deployed; release 6 = 8885038e, live 10:45Z, all four SQLite shards and the Postgres gate green; production now 06b3d981, which is release 6 plus Factory merges)

| PR | Repair | Verified on production by |
|---|---|---|
| #1011/#1013 | Billing-based GPU budget cap with auto-stop; one-dispatch capped launch | Auto-stop under a $1 cap (03:01Z). Every pod today ran under a cap, and every one was stopped. Spending $0/h at 13:04Z. |
| #1017 (a10cc632) | A finished packet releases its research slot | Live missions 22–26 → 13/13 (05:35–06:18Z) |
| #1024 | The goal's own rounds launch first | The 10 newest missions all in the goal tier (08:02Z). Goal rounds AWAITING_LAUNCH 9 → 2, then 6+ ANSWERED (12:03Z) |
| #1025, #1032, #1036 | Parked syntheses retried once per round, lineage kept | Replacement synthesis queued for orc_39d6874b (07:44Z) |
| #1018, #1045 | Model fitness judged on recent answers; an honest empty list is not a failure | The 120B no longer HELD BACK on fragments (12:03Z report: only auto RESEARCH_VERIFY held) |
| #1023, #1020, #1029, #1037, #1040, #1041 | Research answers file under valid lane ids; choice values named; Brain-judgement questions not commissioned; declined paths get one bounded check; hypothesis checks capped; card copies safe | Deploy suites green. Per-attribute ANSWERED counts after these: see the troubleshooting session's V-checks |
| #1031, #1038, #1042 | Constructed arrangements read research (price, buyer rates, hours, volume, costs); linear-time inference | **Plan reach 9% → 51%** (10:56Z) and 54% (12:03Z). See INFORMATION USE |
| #1034 | Verify replies without JSON repaired or failed fast | The 6h no-JSON loop (315 not accepted) gone: 9 ineffective retries in 12:03–13:03Z |
| #1035 | Bin-less commercial research is claimable | No idle-with-work minutes (12:03Z: "free lane idle with work queued ~0 min") |
| #1039, #1048 | The research ceiling grows with the GPU's served sequences and waiting ideas | The controller grew the 120B 6 → 12 ("useful research waiting 88–119"). Free-lane jobs at once average 8.39, peak 14, up from 2.48 / 4. GPU 7.86–8.62 slots busy, up from 0.28 |
| #1043 | An empty claim list states its reason | The 120B's reasons recorded at 12:03Z; they led to #1052 |
| #1028 | Queue, pressure, plan-derivation and trace readings | The readings used throughout this report |
| #1033, #1046 | Postgres-suite flakes fixed at the root (in the tests) | Gates green on release 6 |

**Merged, not yet verified:** #1052 (W14). A fetched page must bear on the question; contact, login and search pages are opened last; prompts ask for the subject's pricing and terms page.

**Deploy 44097071502:** every test shard and the Postgres gate passed. The Fly step failed at 14:21Z on a Fly API error (`api.machines.dev … stream error INTERNAL_ERROR`), so no new image was released. **Production serves 53f54667**: release 6 plus Factory merges #1049–#1051/#1053; healthz 200. The Fly step was re-run at 14:32Z and **succeeded at 14:40Z: production now serves 40fe2ad5, which includes #1052**; healthz 200. The GPU's yield on it is still unmeasured.

## SURGE CAPACITY (measured; configuration: free lane + gpt-oss-120b on one H200 SXM, recipe gpt-oss-120b-big)

| | Stage 1 (eda04071, 07:50–08:50Z) | Stage 2a (release 6, 11:03–12:03Z) | Stage 2b (release 6, 12:03–13:03Z) |
|---|---|---|---|
| GPU slots busy (average) | 4.22 | 7.86 | 8.62 |
| Lane jobs at once (average / peak) | 4.96 / 14 | 8.39 / 14 | — |
| GPU jobs submitted / not accepted | 221 / 24 | 108 / 111 | — |
| Accepted claims per hour, lane | 20.4 | 13.4 | **2** while the GPU ran (the same report's second window reads 14) |
| Accepted GPU claims | 2 | **0** | **0** |
| Queue arrived / finished per hour | — | 189 / 222 (draining) | 131 / 174 (draining) |
| Ineffective retries | — | 59 (54 fragments) | 9 |
| GPU cost | $4.41 per 50 min | $4.85 per 55 min | $4.85 per 55 min |

**Queue at 13:03Z:**
- 72 queued, all claimable.
- AUDIT and VERIFY drain: AUDIT 83 arrived / 106 finished per hour.
- The VERIFY backlog was 20 at 12:03Z.
- 4 fragments from 11-04 to 11-12 still wait at 0 attempts.

**Pressure, and the remaining limit.**
- The database was NORMAL to SHEDDING, p90 21–37 ms, with no pool waits.
- The Brain process's event loop stalled 10–20 s in every 120 s (connection-report, 11:13–12:04Z), and pressure read **SHEDDING**, so Brain deferred optional work by itself (§63).
- CPU profiles name planSet.ts `canonical` (2.8–4.9 s/min), `payerNamedIn` (2.1 s/min) and evaluatorPool.
- RSS was 2.4 GB, peak 3.2 GB; heap 1.7 of 2.6 GB.
- **Its owner (W15) was lost in a worker restart at about 13:10Z, and it is not fixed.**

What this means for 12 hours: the queue drained at the tested load, and the DB held. The CPU stalls are the next limit a heavier surge will hit.

**Projected, not tested:** load beyond 8–9 GPU slots, and anything over 12 hours.

## INFORMATION USE (the chain, on production)

The path runs objective → research question → accepted claim → plan input → plan decision, for goal wst_7b4fcbb5f2384f31b6c3, runpod-report 12:03Z (#1028 sections):
- **Plan derivation:** scenario run scr_2fdb656c… at 11:45:46Z. The model has **68 inputs: 32 research-fed and 12 EVIDENCE; 12 distinct accepted claims cited.** The trace names, for example, "already agreed by … EVIDENCE via CASH_OPPORTUNITY cop_9565c634…".
- **The plan changed because research reached it:**
  - **History:** reach 0.09 (00:02Z, 10:13Z), then **0.51 at 10:56Z, 11 minutes after #1038 went live, then 0.54**.
  - **p50 settled:** $0, then $26,550.
  - **Verdict:** NEEDS_EVIDENCE, then NOT_VIABLE, with "PRICE binds".
  - **Why it moved:** arrangements now take their price and buyer rates from accepted evidence. Before, these were hard-coded ASSUMPTION or UNKNOWN.
- **Missing information triggers the next action:**
  - The plan names VOLUME_UNRESEARCHED, NO_BUYER, NO_SUPPORTED_PRICE and NO_FULFILLER.
  - The goal's rounds are launched first (#1024) and answered: 6+ ANSWERED.
  - A declined question becomes a bounded check (#1037), not a dead end.
- **Retained:** accepted claims and card facts persist as rows, and the next plan pass re-reads them. The derivation at 11:45Z cites claims accepted before it.
- **Not yet shown:** a claim accepted during the run moving the plan within the run. "Newer claims: 0" at 12:03Z, because no new goal claim was accepted in that hour.
- **The $10K goal itself is not reached.** Reach is 54% against the 90% required, and the plan says PRICE binds. Acceptance cannot come from research alone (diagnosis F1). This is reported, not hidden.

## NEXT 12 HOURS (only if the one-hour test passes)

**Work:**
- The goal's research rounds and the commercial questions on its 11 openings (buyer, price, volume, fulfiller).
- Audits, verifications and syntheses of the packets they produce.
- Plan re-derivation on every new accepted claim.

**Resources:**
- One H200 SXM running gpt-oss-120b-big (served-sequence ceiling 128, held to the DB pool share of 12).
- The free lane (auto/best-coding) at $0.
- Brain on Fly and Supabase as they are.

**Expected deliverables:**
- **Measured basis:** from the free lane at 13–37 accepted claims per hour, about 160–440 accepted claims in 12 hours. It has run at $0 all along.
- **GPU contribution:** the measured stage-1 rate on fragments was 2/h. After #1052 it is **unmeasured**, and the one-hour test sets it.
- **Plan movement:** plan reach and settled p50 change as price, volume and buyer evidence arrive. No reach figure is promised.

## MONEY

| TASK | RESOURCE | QUANTITY | UNIT PRICE | SUBTOTAL | BASIS |
|---|---|---|---|---|---|
| GO test (1 h) | RunPod H200 SXM, SECURE | 1.25 h (15 min load + 1 h) | $5.29/h | $6.61 | RunPod quote at creation; load measured at 247–1005 s |
| 12-hour run | RunPod H200 SXM, SECURE | 12.25 h (load + 12 h) | $5.29/h | $64.80 | Same. COMMUNITY ($3.59/h) had no H200 capacity at 07:43Z |
| 12-hour run, if COMMUNITY is available | RunPod H200 SXM, COMMUNITY | 12.25 h | $3.59/h | $43.98 | Quote of 04:32Z |
| Free-lane research | OmniRoute free models | 12 h | $0 | $0 | Measured |
| Brain hosting and database | Fly + Supabase | already running | — | not priced | Existing plan; not run-specific |

**Preparation spending today:**
- **Since 03:07Z, at least $32.93.** The RunPod balance went $80.05 → about $180 with the owner's ~$100 deposit (inferred from the balance; RunPod's billing history is authoritative) → $147.12 at 13:04Z.
- **Against the $250 ceiling:** about $96.50 before today plus about $32.93, which is **about $129.43 spent and about $120.57 remaining**.
- Two pods were stopped at 13:04Z: 2ua3kt3ftnd7n9, mine, and lb3ae1xgbgqid1, started by another session.

**Usable balance:** RunPod **$147.06**, spending $0/h (survey, 14:3xZ).

**Expected expenditure for the next run:** $6.61 for the test, plus $64.80 for the run, is **$71.41** on SECURE.

**Additional cash deposit required:** **none**. $147.12 covers it.

**Recommended spending ceiling:** a **$66 Brain cap over 12 h**, plus the $6 test cap, so **$72**, inside the remaining ~$120.57.

**Not covered by this estimate:**
- the planner's CPU stalls (W15), which is engineering time, not RunPod;
- source discovery beyond #1052;
- the stale queued fragments from 11-04 to 11-12.

**Operating versus result.** The table says what operating the run costs. Whether that buys useful research depends on the GPU's post-#1052 yield, which the one-hour test measures. Without it, the same $64.80 would buy about 200 audit and verify jobs per hour and no new claims.

## GO TEST STATUS (15:05Z)

**First attempt, 15:01Z: no pod, $0 billed.** SECURE H200 was priced **$7.99/h**, above the $5.50 ceiling, and COMMUNITY H200 and B200 had no capacity.

**Second attempt, 15:05Z:** relaunched with a $8.50/h ceiling and an $11 cap. A 12-hour run at that price would be 12.25 h × $7.99 = **$97.88**, which is still inside the ~$120.57 left under the $250 ceiling and inside the $147.06 balance. The measurement and stop follow automatically one hour after serving.

## GO TEST RESULT (16:17Z): **NO-GO**

The pod was bejuv0zx9vwirg, gpt-oss-120b-big on a SECURE B200 at $7.99/h, ready in 345 s. It served for 55 minutes on release 7 plus #1052, then Brain stopped it at 16:17Z. Spend is now $0/h.

| GO criterion | Required | Measured | Result |
|---|---|---|---|
| GPU accepted claims in the hour | ≥ 10 | **2** | fail |
| Goal accepted claims | > 0 | **0** (this goal 0/h) | fail |
| Pressure | not SHEDDING | **SHEDDING** (statement p90 19 ms, 0 overload failures; event-loop stalls) | fail |

**Cost:** the GPU is $7.32 measured, or $3.66 per accepted claim. The RunPod balance went from $147.06 to $137.90, which is $9.16 including the load time.

**Why it failed:** #1052 ranked candidate pages but did not change what the search returns. Every non-accepted fragment is one of two kinds:
- an honest empty list saying the pages are off-topic (arXiv astrophysics, MaxSAT, machine translation, BLS occupational tables, the SEC EDGAR search UI, a mine-supply contact page);
- "no readable source among N candidate pages".

The defect is upstream of the model: the source discovery for a fragment's question returns the wrong pages. A larger GPU only multiplies off-topic reading.

**Decision:** the 12-hour run is **not launched**, and paid compute stays off. The free lane continues at $0.

**Owners:**
- **W16:** fragment source discovery, which query is built and which providers return arXiv for commercial questions.
- **W15:** planner CPU stalls (planSet canonical, payerNamedIn, evaluatorPool), redispatched.

The GO test is repeated only after W16 is live and a free-lane reading shows on-topic sources. Its cap is ≤ $11.

## HANDOFF

The session runs this itself when deploy 44097071502 shows "Deploy to Fly: success". Nothing here needs the owner.

```
# 1. GO test (after W16 is live), hard cap $11 (Brain stops the pod itself at the cap)
gh workflow run cheap-lane.yml -R peyday007/v5 --ref production -f action=runpod-launch -f budget_usd=11 -f budget_window_hours=1.5 -f recipes=gpt-oss-120b-big -f max_usd_per_hour=8.5 -f runway_hours=1 -f tool_score=0.79
# after 60 min of serving:
gh workflow run cheap-lane.yml -R peyday007/v5 --ref production -f action=runpod-report -f hours=1
# 2. GO (GPU accepted claims >= 10 in the hour, goal claims > 0, pressure not SHEDDING), then the 12-hour run, hard cap $99 (12.25 h x $7.99 = $97.88):
gh workflow run cheap-lane.yml -R peyday007/v5 --ref production -f action=runpod-launch -f budget_usd=99 -f budget_window_hours=12.5 -f recipes=gpt-oss-120b-big -f max_usd_per_hour=8.5 -f runway_hours=12 -f tool_score=0.79
# NO-GO, then stop paid compute; the free lane continues at $0:
gh workflow run cheap-lane.yml -R peyday007/v5 --ref production -f action=runpod-stop
```
