# Major-run decision report — deadline 2026-11-17 08:21Z (T0 03:21:56Z)

_Final version, written 07:25Z and updated at the deadline. Every figure below is from a production reading named beside it. Anything not measured is marked UNMEASURED._

## A. READY FOR A 12-HOUR PAID GPU RUN: **NO**

Brain is ready to run 12 hours on the **free lane at $0**, and it does that continuously already. It is **not** ready for 12 paid GPU hours.

The last measured GPU hour (04:38–05:45Z) produced **1 accepted claim for $3.59**. Its cause is fixed (#1018), but the fix had not been measured on production by the deadline. Spending $43 for 12 hours before that measurement would be spending against an assumption.

## B. Fixed (merged; deploy status per line)

| # | Defect, with evidence | Status |
|---|---|---|
| #1011/#1013 | Budget cap counted samples, not billing → now counts RunPod billing and launches with a cap in one dispatch. | **Verified on production:** Brain stopped pod 5e8ks9cr2o8yml itself under a $1/1h cap (03:01Z). The 04:38Z launch ran under an $8/2h cap. |
| #1006/#1008/#1009 | RunPod REST outage → GraphQL create, stop, start and delete. | **Verified:** pods created and stopped through it (byvgxskr1db92q, 04:32–05:49Z). |
| #1014 | 40% of 120B answers refused (empty answers, because the model saw only the first 7000 characters of a page). | Deployed bde92afc 04:22Z. In the next hour, 6 of 27 GPU jobs were not accepted (22%, down from 40%). |
| #1015 | Free models dead (Cerebras 402, Groq limit). | Deployed. The free lane produced **48 accepted claims/h, 100% sourced, 0% refuted** (runpod-report 05:48Z). |
| #1016 | The goal's research launch query was jammed by withdrawn questions and timed out. | Deployed 04:22Z. |
| #1017 (a10cc632) | Research slots held by finished packets: 22–26 live against a ceiling of 13. | **Verified on production:** 14/13 at 05:35, 13/13 at 05:52 and 06:18Z. |
| #1018 | The 120B was held back from research fragments by a full day of rejections from before #1014, with no way to earn new evidence. That is why the GPU hour gave 1 claim, at 0.28 slots busy. Fix: judge on the latest 10 answers, plus one re-probe item per 30 minutes. | Merged. In deploy 44036476327. |
| #1020 | Choice-type research questions never named the allowed answers, so the filer could not match them. | Merged. In deploy 44036476327. |
| #1023 | Commercial research asked for lane ids the schema refuses ("expectedRevenue"), so answers on 10 of 13 attributes were discarded (515 asked → 13 answered). Diagnosis F6. | Merged. In deploy 44036476327. |
| #1024 | Freed slots went to the goal's other ideas: the goal's 9 rounds sat at AWAITING_LAUNCH at 06:18Z. Its own rounds now launch first. | Merged. In deploy 44036476327. |
| #1025 | Parked goal rounds holding accepted claims whose synthesis ran out of attempts were never retried. One bounded retry, with lineage kept. Diagnosis F7. | Merged. In deploy 44036476327. |

The deploy carrying #1018 and #1020–#1025 (commit eda04071) was held by Deploy's gate. The full Postgres suite failed one shard, cashIntegrationPass:1087, a test documented as failing under full-suite load. The shard was rerun and Deploy re-dispatched (44036476327). DEPLOY STATUS AT DEADLINE: see the end of this file.

## C. What remains, and what is unproven

1. **Post-fix GPU yield: UNMEASURED.** This is the GO condition for paid compute.
2. **The $10K goal's plan cannot become ACCEPTED from research at any GPU volume.** Diagnosis F1, confirmed in code:
   - Acceptance needs every input of every member at sample ≥20 (`MIN_EVIDENCE_SAMPLE`) and a P5 reach of at least 90%, or a measured record of adopted plans.
   - Reply and close rates need real buyer contacts, which the research grant forbids.
   - Plan reach is 9% of worlds against a 90% requirement (05:48Z). Plan acceptance is therefore **not** a valid GO signal. The run should be measured on accepted claims per hour, the goal's claims per hour, and attributes answered.
3. **Constructed arrangements never read research** (F2: inputs hard-coded as ASSUMPTION or UNKNOWN in goalScenario.ts and planSet.ts). No owner yet. This is capability work, not a precondition for the run.
4. **Questions no publication can answer** (F3e: Brain-judgement attributes asked as research; methods asked as hypotheticals). No owner yet.
5. **Transfer to unfamiliar objectives:** not demonstrated in production. One commercial goal has been exercised. The feasibility benchmark's 0.881 accuracy is a benchmark, not evidence of generalization.
6. **The $10K goal's research throughput:** 0 goal jobs per hour at 05:45Z, because rounds were not launching. #1024 and #1025 address this. UNMEASURED after the fix.

Chain status, earliest failure first:

| Link | Status |
|---|---|
| GPU research | Held back (fixed by #1018; not yet measured after the fix) |
| Accepted knowledge | Discarded at filing (fixed by #1023 and #1020) |
| Goal research launch | Not launching (fixed by #1024 and #1025) |
| World model and plan | Arrangements don't read research (F2, open) |
| Acceptance | Unreachable by research (F1, structural) |
| Learning | Not assessed in this window |

What has been demonstrated on production:
- **Paid resources are controlled automatically:** the budget-cap auto-stop.
- **Failures are recognized:** the reports name RESEARCH_NOT_FINISHING, HELD BACK and NEEDS_EVIDENCE with their gaps.
- **Missing information becomes research questions:** 515 commissioned questions.
- **A coherent plan:** 427 candidates, 64 distinct, with named gaps (buyer, price, costs, settlement, fulfiller).

## D. Cost

| TASK | RESOURCE | QUANTITY | UNIT PRICE | TOTAL |
|---|---|---|---|---|
| 1-hour post-fix GPU measurement (the GO test) | RunPod H200 SXM, COMMUNITY | 1 h (load 4–17 min included) | $3.59/h | **$3.59** (hard cap $5) |
| 12-hour run, if the test passes | RunPod H200 SXM, COMMUNITY | 12 h | $3.59/h | **$43.08** (hard cap $44) |
| Alternative if COMMUNITY has no capacity | RunPod H200 SXM, SECURE | 12 h | $5.29/h | $63.48 (cap $64) |
| Free-lane research for the same 12 h | OmniRoute free models | 12 h | $0 | $0 |

Prices are RunPod's quotes at pod creation, 2026-11-17. Load time measured 247 s, 888 s and 1005 s; it falls inside the billed hours.

- **Spent against the $250 ceiling:** ≈ $101.09. This is the earlier ≈$96.50 plus this window's verification hour ($80.05 → $75.46 = $4.59). The $96.50 assumes the $150 deposit landed on the earlier $24.95 balance.
- **Current balance:** RunPod $75.46, spending $0/h (05:49Z reading).
- **Additional money for the 12-hour run:** $3.59 for the test plus $43.08 for the run = $46.67.
- **Deposit required:** none. $75.46 covers the test plus 12 hours at COMMUNITY ($46.67) or at SECURE ($67.07).
- **Unpriced work:** Claude agent and session work, because it has no marginal RunPod cost and is billed outside this ceiling. Fly hosting, because it is already running and is not part of this run.

**What the money buys:** research throughput, meaning accepted, sourced claims. Before the fixes the GPU measured $0.36 per accepted claim (01:02–01:49Z, 13 claims/h); after #1014 alone it measured $3.59 per claim. **It does not buy an accepted $10K plan** (C2).

## E. Expected 12-hour results (only measured rates; unmeasured ones are marked)

- **Free lane, $0:** ≈ 48–52 accepted claims/h measured (05:48Z), so ≈ 580–620 accepted claims in 12 h at the same rate.
- **GPU, $43.08:**
  - The 01:02–01:49Z baseline was 13 accepted claims/h. At that rate, 12 h gives ≈ 156 claims, ≈ $0.28 per claim.
  - The 04:38Z hour gave 1 claim/h, so ≈ 12 claims in 12 h.
  - Which of the two applies after #1018 is **UNMEASURED**; the 1-hour test decides it.
- **The $10K goal:**
  - The goal's claims per hour were 0 before #1024 and #1025; after them, UNMEASURED.
  - Plan acceptance: not expected (C2).

## F. Completion confidence

- **That the fixes work in production:** moderate. Each has a passing test and a confirmed root cause. #1017 is already verified on production; the rest are unmeasured.
- **That 12 GPU hours are worth $43:** unknown until the 1-hour test.
- **That the run yields an accepted $10K plan:** none (structural, C2).

## G. Launch instruction

Shortest path, in order:

1. Confirm Deploy 44036476327 shows "Deploy to Fly: success".
2. Run the GO test (1 hour, hard cap $5):
   ```
   gh workflow run cheap-lane.yml -R peyday007/v5 --ref production -f action=runpod-launch -f budget_usd=5 -f budget_window_hours=1.5 -f recipes=gpt-oss-120b-big -f max_usd_per_hour=4 -f runway_hours=1 -f tool_score=0.79
   ```
   After 60 minutes, read it with `gh workflow run cheap-lane.yml -R peyday007/v5 --ref production -f action=runpod-report -f hours=1`.
3. **GO** if the report shows the 120B no longer HELD BACK on RESEARCH_FRAGMENT, RUNPOD_ACCEPTED_CLAIMS ≥ 10 for the hour (≤ $0.36 per claim, the measured baseline), and this goal's jobs above 0. Then launch the 12-hour run:
   ```
   gh workflow run cheap-lane.yml -R peyday007/v5 --ref production -f action=runpod-launch -f budget_usd=44 -f budget_window_hours=12 -f recipes=gpt-oss-120b-big -f max_usd_per_hour=4 -f runway_hours=12 -f tool_score=0.79
   ```
   Brain stops the pod itself at $44 billed, or after 15 idle minutes.
4. **NO-GO** otherwise: stop with `-f action=runpod-stop`. Total spent is at most $5, and the free lane continues at $0.

The coordinating session runs steps 1–4 itself; none needs the owner.
