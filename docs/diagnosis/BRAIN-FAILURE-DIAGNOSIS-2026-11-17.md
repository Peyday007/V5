# Brain failure diagnosis — 2026-11-17 (two-hour mission)

- Start: 2026-11-17T05:56:35Z. Deadline: 2026-11-17T07:56:35Z (trigger trig_01XynxgeaR3Cqux3E2cXqdPx; warning/90-min trig_016hxUVCfPFjDjRjWYCsbPvK; 30/60-min checkpoints trig_01X4grJFbeiFQAWDY7C5gvFH, trig_01VW48zhUGaqV9hWPxVDZaEe). Delivery: this session's final message (owner reads it in the Claude app), plus this file on branch `claude/brain-failure-diagnosis-4yjquv`.
- Main project: session "the end?" (session_01QF5Tk7etm6MGmaFuHMd6eZ) — owner's "FINAL PREPARATION DIRECTIVE — FIVE-HOUR HARD DEADLINE" (03:21:49Z): prepare Brain for a 12-hour paid intelligence run (part of the $250 acceleration), resolve blockers (refused research, CPU, concurrency/queue limits, research not reaching planning/learning, cost accounting), A–G report starting "READY: YES/NO". Deadline **08:21Z** (trig_01AN2Lp5Gch4ZJrsb3EGwiJy; checks trig_01Epq4rX4XYoYATMndH3SicM 07:21Z, trig_01WuAFXNR9Z4W26vGVCcZBRE 07:51Z; backstop trig_01BbiRcqUbbP5u6VRmfMMiTh 08:26Z reads docs/intelligence-recovery/major-run-decision-2026-11-17.md on claude/brain-intelligence-recovery-s0dl4l). Not changed by this mission. It is the repair owner.
- Its latest measured state (capped H200 hour, pod byvgxskr1db92q, $3.59/h, 04:38–05:49:58Z; runpod-report 44026244200; stopped by 44026723215): gpt-oss-120b took 27 jobs, **1 accepted claim**; GPU 0.28 slots busy; lane-wide 51–52 accepted claims/h mostly from free `auto/best-coding`; **$10K goal 0 accepted/h**; "RESEARCH_NOT_FINISHING: 3 of the goal's last 3 settled rounds ended without a report"; 120B held "unfit" for fragments (fix #1018 merged 05:54Z, Deploy 44027365881 running); free providers brain-a/brain-b 100% failing (Cerebras 402 credits exhausted, Groq daily limit, a 404 model). Verdict NO-GO. Already fixed by it: GPU routing (#984), scheduling deadlock (#992/#995), refusal accounting (#989/#990), cost accounting (#1001/#1005), budget cap verified (#1002+#1011, pod 5e8ks9cr2o8yml auto-stopped 03:01Z), one-dispatch launch (#1013), #1014–#1017.
- Status: first report 06:08Z; open checks being resolved until 07:56Z.

## Production readings taken (05:52–05:58Z, serving a10cc63)

- Cash report run 44027151112: dives started 820 → qualified now 2 (410 dives per qualified); monetization questions asked 515 → ANSWERED 13, UNRESOLVED 490 ("published sources do not settle …"); possibility ledger 11 529 (BLOCKED 7 172), answers 13 sourced vs 112 Brain-proposed; jobs QUALIFIED=0, READY=0; money ledger 0 entries; commercial grant ABSENT (no contact/spend); free lane "82 screens today of 20000 (failed 33)"; GPU "RunPod off".
- Capacity (brain_operator_capacity 05:58Z): FREE_LANE `auto` 0% accepted; RESEARCH_SLOTS 13/13 running, 563 waiting, 562 at the grant's at-once ceiling (13); FACTORY 2/3.
- Goals (05:58Z): all 5 goals NOT_DERIVED — "Brain was too busy to derive the goal this run".
- $10K plan (read 00:02Z, ~6h stale): NEEDS_EVIDENCE / IMPROVEMENT_REQUIRED; ladder B_EVIDENCED 11, C..F 0; best reach 9–11% "coverage, not probability"; "samples are not evidence-backed (invented or unvalidated inputs)"; "too few finished accepted plans (under 10) to calibrate"; 427 candidate plans, 0 accepted, every one with gaps acquisitionRoute/costs/controls/evidence.

- Goals workflow run 44027622659 (05:57–06:00Z, serving 0ee1a30): pool POOL_INSUFFICIENT — "the 11 openings held reach at most 265 of the 10000 USD"; 23 pathways (11 found, 12 constructed), 2 executable, **0 with every permission granted**, 0 with delivery capacity estimated; facts P 65 · E 115 · ? 142. Every constructed pathway shows `why ? | channel ? [UNKNOWN] | offer ? | fulfils ?` with buyer strings like "state technical utility services bureaus: Brain produces it" and net p90 up to 200 000 000; the best FOUND pathway (Mechanicsburg) is "one sale of 10.89 … 0.11% of the gap". construction cap: 400 of 10 446 candidate arrangements composed.

## Findings

### F1 CONFIRMED — the GO signal the project uses cannot move: a $10K plan cannot be ACCEPTED from research at any volume
- CAUSE: `judgeAcceptance` (server/services/goals/plan.ts ~954) accepts only via EVIDENCED_PORTFOLIO or MEASURED_RECORD. MEASURED_RECORD (`measuredPlanChance` ~915-931) needs ≥`minPlanOutcomes` ended adopted plans with a Wilson lower bound ≥0.9 (≈35 straight successes); none exist. EVIDENCED_PORTFOLIO needs every input of every member to be evidence with sample ≥20 (`MIN_EVIDENCE_SAMPLE`, server/services/quant/portfolio.ts:384, :1320). Reply/close rates are only evidenced by real contacts, and the research grant prohibits CONTACT_PERSON with the commercial grant ABSENT (cash report 44027151112). The plan's own next test is "sell to measure conversion" (plan.ts ~1819, ~2749), which cannot run.
- EFFECT: "plan reach 9% vs 90%", "research does not reach the goal", and the NO-GO built on them are fixed by the acceptance rule plus the grants, not by research throughput. A 12-hour GPU run measured against that signal shows no improvement whatever it learns.
- CHANGE: judge readiness and the run on signals research can move (F3/F6 metrics below); keep the 90% rule for spending/commitment decisions. Whether to grant contact (to measure conversion) is the owner's call.
- VERIFY: the run's acceptance metric moves when research is accepted (e.g. evidenced plan inputs, answered-question share), on a 1-hour capped measurement.

### F2 CONFIRMED — constructed arrangements never read research
- CAUSE: `estimatedFromArrangement` (server/services/cash/goalScenario.ts ~215-302) hard-codes price provenance ASSUMPTION and close/respond/daysToCash/directCost/hours/volume as unknown sweeps; `candidateFromArrangement` (server/services/goals/planSet.ts ~389-397) hard-codes acquisitionRoute/costs/controls UNKNOWN. Goals run 44027622659 shows every constructed pathway as `why ? | channel ? | offer ? | fulfils ?`.
- EFFECT: the 12 constructed pathways and most of the 427 candidate plans cannot improve from any accepted claim, so research "arrives but is not used" for them.
- CHANGE: read those inputs through the same `inferOr(knowledge, …)` found openings use (goalScenario.ts ~900-912).
- VERIFY: `brain_operator_goal_plan wst_7b4fcbb5f2384f31b6c3` shows arrangement members with justified inputs >0; the "samples are not evidence-backed" shortfall changes to sample-size wording.

### F3 SUPPORTED (code + report; per-attribute DB split not read) — most commercial research asks questions no publication can answer
- EVIDENCE: 515 monetization questions → 13 ANSWERED, 490 UNRESOLVED; "do not settle" is written only for DONE packets (commissionPass.ts:564, :679), so research ran and returned sourced claims that did not land on the asked attribute.
- CAUSES: (e) questions about hypothetical arrangements from the opening × method cross-product (`enumerate.ts`; 11 529 possibilities from 979 openings) and Brain-judgement attributes (execution difficulty, scalability, required capability; domain/monetization.ts:778, :824) asked as published-source research the research rules forbid inferring (compilerProfiles.ts:1910-1916); (c) choice-type answers dropped: `commissionQuestion` (commissionPass.ts:141-144) never states the allowed values while `matchChoice` (:763-764, :809) needs an exact token; card facts already found (GoTranscript "Net 30") are not reused for the open question.
- CHANGE: put allowed values in the question; never ask judgement attributes as research; only ask about methods a source states; copy card facts before asking.
- VERIFY: one read of `monetization_commissions` grouped by attribute and method (splits c vs e); after the change the ANSWERED share rises and fewer questions are opened.

### F6 CONFIRMED (code; found by the independent review) — commercial research answers are thrown away at filing: lane-id mismatch
- CAUSE: `commissionQuestion` tells the worker to "Record the answer under the evidence lane \"${attribute}\"" (server/services/cash/monetization/commissionPass.ts:143), and the filer only accepts a claim whose `evidenceLane` equals the attribute key (`isMonetizationAttribute`, commissionPass.ts:723-725; server/domain/monetization.ts:862). Ten of the 13 keys are camelCase (`requiredCapability, requiredRelationships, requiredCapital, expectedRevenue, directCosts, timeToCash, probabilityOfSuccess, executionDifficulty, legalRequirements, externalDependencies`; server/domain/types.ts:10139-10153). A lane id must match `^[a-z][a-z0-9_]{1,39}$` (server/domain/evidenceLanes.ts:46). The plan parser refuses a non-conforming declared id (research/schema.ts:738-745), and a derived id is lowercased (`laneIdFrom`). So no claim can file on those ten attributes. The other three (competition, scalability, repeatability) are CHOICE attributes, which also hit the exact-token rule (F3c). The test inserts claims with `lane: 'expectedRevenue'` straight into the DB (tests/monetizationCommissioning.test.ts:234, :1132), which bypasses the schema, so it passes.
- EFFECT: this explains "515 asked → 13 answered" mechanically. Research that finds the answer is discarded at the last step. It also falls under F3's "do not settle" wording, because the packet is DONE and the attribute did not land.
- CHANGE (smallest): map the lane id both ways in one place. Ask for `time_to_cash` (snake_case of the key) in `commissionQuestion`, and in the filer accept `toSnake(attribute) === lane`. No schema change.
- VERIFY: a unit test that sends a claim through the real lane schema (not a direct insert) with lane `time_to_cash` files on `timeToCash`. In production, `research_claims.evidence_lane` for commission orchestrations shows snake_case lanes, and the cash report's ANSWERED count rises above 13 within the next settled rounds.
- F3 is re-ranked accordingly: F6 first, then the CHOICE exact-token rule (F3c), then unanswerable or hypothetical questions (F3e, still supported, not confirmed).

### F7 CONFIRMED — the $10K goal's research is not running, and its "RESEARCH_NOT_FINISHING" label misnames the cause
- EVIDENCE: runpod-report 44026244200: "jobs none on this goal", "this goal 0/h". The goal has 14 rounds open: 9 waiting to launch, 1 researching, 4 parked (cash report 44027151112). 3 of the parked rounds say "The last RESEARCH_SYNTHESIZE work item failed (ATTEMPTS_EXHAUSTED): free lane (runpod/Qwen…". 1 says "A synthesis work item finished without recording anything". Brain's goal read shows 15 Routine bins READY at priority 8, 0/5 attempts, idle since 2026-11-14 07:19Z (Routines are reserved for Brain improvement, §84). Over 7 days, 1 738 of 2 153 fragments were blocked: 1 116 WORK_FAULTED (nothing submitted, `gate.ts:951`; the worker drops 0-claim answers at worker.ts:1334-1337), 296 NOTHING_SURVIVED, 263 REQUIRED_LANE_EMPTY, 0 MOSTLY_REJECTED.
- CAUSE: (i) The goal's rounds pass the gate, then die at synthesis on the small Qwen3-4B model and are parked rather than retried on another model. (ii) Rounds wait to launch, and their Routine bins are not fired. (iii) `researchYield.ts:97-100` counts every ABANDONED round as RESEARCH_NOT_FINISHING with a sourcing instruction (`:65`), so Hermes and the main session are pointed at the wrong fix.
- CHANGE: (a) Retry a parked goal-round RESEARCH_SYNTHESIZE item on another model, as #1018 does for fragments. (b) In `diagnoseGoalResearch`, name the abandoned-round cause from `abandonedRoundCause` / `diagnoseAbandonedRounds` (discovery.ts:2282-2350): synthesis, never launched, or verification. Do not use one label for all three.
- VERIFY: `diagnoseAbandonedRounds(prj_22fb4fec295f403a8a22)` filtered to `goal-wst_7b4fcbb5…` shows ROUND_SETTLEMENT / ROUND_CAP_LOGIC outnumbering MAST_TASK_VERIFICATION. After the change, the 4 parked rounds reach HARVESTED and the goal shows >0 accepted claims/h in the next runpod-report.

- REFINEMENT (06:10Z, admin `packets recent 72` run 44029121501 and `packets parks` run 44029109308): RESEARCH_SYNTHESIZE items now succeed ("synthesis filed", 04:21–05:30Z), so the Qwen3-4B synthesis failures are historical, newest 11-16 06:05Z. The `packets parks` list still holds dozens of cash-mode-1 packets with accepted claims (1–4) parked at NEEDS_HUMAN or RUNNING with `RESUMED:RECORD_GAPS`. These are rounds that passed the gate and were never re-synthesized. The active defect is that **a parked round whose cause has since been fixed is never retried**. The smallest change is to re-queue synthesis for parked packets with accepted claims once the synthesis model is healthy. A per-model retry is still worth doing, but it is secondary.

### F1 correction (independent review)
Research can, in code, evidence all six portfolio inputs, including close and respond rates, through `inferOr`/`inferCashQuantity` (goalScenario.ts:1021, :1028; quant/knowledge.ts:1032) and bid/win history (quant/history.ts:272-281). So "only contact can evidence close/reply" is wrong. The binding constraint is this: every member needs every input evidenced with sample ≥20, and the 5th percentile of reach must clear 90% (portfolio.ts:1398-1405, :1443). Against a pool whose 11 openings reach at most $265 of $10 000 (Goals run 44027622659), no amount of evidence clears that. Conclusion unchanged: plan acceptance is not a signal the run can move in its window. Research can move "justified inputs" and "sample size", and those are the right run metrics.

### F4 CONFIRMED — surge throughput is limited by answer acceptance, not GPU uptime or the ceiling of 13
- EVIDENCE: runpod-report 44026244200 (05:45Z, a10cc63): gpt-oss-120b 27 jobs, **1 accepted claim** in 60 min ($3.59), **held back on RESEARCH_FRAGMENT** after earlier dropped fragment answers, GPU 0.28 slots busy. Free `auto/best-coding`: 12 of 17 jobs not accepted (5 provider timeouts, 4 no JSON, 2 checks, 1 DNS); `auto` 0%; brain-a/brain-b dead (Cerebras 402, Groq limit, missing model; #1015). Free lane averaged 1.68 of 4 jobs busy, so raising 13 adds queue, not claims. GPU is disconnected now (runpod-disconnect 44026630515, stopped 44026723215 05:49Z).
- CHANGE: owned by the main session — #1018 (re-probe held pair, judge on latest answers) deploying in 44027365881; then a capped GPU hour.
- VERIFY: 1-hour runpod-report with GPU connected: no HELD BACK on RESEARCH_FRAGMENT, RUNPOD_ACCEPTED_CLAIMS ≫ 1, GPU >1 slot busy, and claims on the $10K goal >0/h.

### F5 CONFIRMED — no retained commercial learning loop exists yet
- `goal_outcomes` → calibration only from accepted plans (`recordGoalOutcome` plan.ts:3180-3198; `goalPredictionRows` calibration.ts:261-272 skips readings with no probability) → with F1, the calibration record stays empty forever.
- Evolution engine: 0 completed cycles; evolution-eval runs 43999026354 (baselines only), 44000206068 ("Nothing is awaiting evaluation"); not run since 02:03Z despite `13,43 * * * *`. Suites are narrow (feasibility = one false-acceptance judgement on 67 cases; planSpeed; mootRequests). `evolution_approach_stats` (repos/evolution.ts:391) is read only by experiments.ts:139-145 — nothing in planning reads it. Operator lessons go to the director as prose (actions.ts:105, judge.ts:45).
- This is the capability the run is meant to build; it is not a precondition, but the run needs a metric that records what it learned (see F1).


## FINAL REPORT (first delivery 06:08Z; open checks continue until the deadline)

**Brain has not achieved the goal because** its commercial research cannot reach its plans or be measured. Three defects cause this:
- **Answers are dropped when they are filed.** 10 of the 13 question attributes ask for lane ids the schema forbids (F6). Choice answers also need an exact token that is never stated (F3c).
- **The $10K goal's own research is not running.** Its rounds die at synthesis on the small model or never launch (F7). The GPU model was held out of research until #1018 (F4).
- **Plans built by construction never read research** (F2).

On top of these, the readiness test used for GO/NO-GO, "the $10K plan is accepted or reaches 90%", is a test no research volume can pass in the run's window (F1). So the NO-GO is correct, but it cannot tell a fixed Brain from a broken one. Nothing learned is written back where future plans read it (F5). That loop is the capability the run is meant to build, not a precondition for it.

**To correct that, change these, in this order:**
1. **F6 lane fix** (commissionPass.ts:143 and :723-725): ask for and accept the snake_case lane. This is the smallest and highest-yield change.
2. **Verify #1018 (deployed 06:06Z)** in one capped GPU hour: gpt-oss-120b takes RESEARCH_FRAGMENT work.
3. **F7:** retry a parked goal-round synthesis on another model, and name abandoned-round causes correctly. Steps 2 and 3 can run in the same hour.
4. **F3c/F3e question hygiene:** state the allowed values; do not ask judgement attributes as research; ask only about methods a source states; reuse card facts.
5. **F2:** feed constructed arrangements' inputs through `inferOr(knowledge, …)`.
6. **Then run the paid improvement run.** Judge it on research-movable metrics: claims filed per attribute, the ANSWERED share, justified plan inputs, the goal's accepted claims per hour, the feasibility suite and a transfer case. Build the F5 loops (plan outcome → calibration; approach statistics read by planning) as the run's capability work.

### A. Ranked causes
| rank | finding | status | type |
|---|---|---|---|
| 1 | F6 lane-id mismatch discards commercial answers | CONFIRMED (code + reproduction) | active blocker |
| 2 | F7 goal research not running (synthesis parks, unlaunched rounds, misnamed cause) | CONFIRMED | active blocker |
| 3 | F4 GPU model held from fragment research; free providers dead | CONFIRMED; fix #1018 deployed, unverified | active blocker, repair in flight |
| 4 | F1 GO signal (plan acceptance) cannot move in the run's window | CONFIRMED (corrected by review) | evaluation/task interpretation |
| 5 | F2 constructed arrangements ignore research | CONFIRMED | active blocker for B |
| 6 | F3c CHOICE answers need an unstated exact token | CONFIRMED | active blocker |
| 7 | F3e questions about hypothetical arrangements and judgement attributes | SUPPORTED, unconfirmed | likely blocker |
| 8 | F5 no retained commercial learning loop; evolution engine 0 cycles; narrow suites | CONFIRMED | capability the run should build |
| — | budget cap, cost accounting, CPU, research ceiling of 13, "too busy" reading | FIXED / NOT BINDING / RULED OUT | not blockers |

### B. Evidence and repair detail
See F1–F7 above. Each one gives the cause, file:line, run IDs, the smallest change and the verification.

### C. Readiness implications
- **Barriers to a productive run** (fix first): F6, F7, F4 (verify #1018), F3c. Without these, GPU hours on commercial work produce ~1 accepted claim/h, as measured at 05:45Z, and the goal gets 0/h.
- **Evaluation barrier:** F1. The run needs a metric research can move, or its result cannot be read.
- **Capabilities the run is meant to develop** (not preconditions): F2/F3e plan construction quality, F5 retained learning and calibration, the evolution engine's first cycle, transfer to new objectives.

### D. Remaining work and resources
- **No new paid resources are needed for steps 1–5:** code changes plus one capped GPU verification hour. The main session already plans a $5-capped hour. The measured price is an H200 COMMUNITY pod at $3.59/h; RunPod balance is $75.46.
- **Sequence:** step 1 can start immediately, in parallel with steps 2–3. Step 4 is independent. Step 5 is independent of the others. Step 6 follows 1–3 and needs their verification.
- **Not estimated:** time to complete. There is no supported basis for it.
- **Open checks:**
  - F3e: group `monetization_commissions` by attribute and method. This needs a DB read; no read-only report prints it today.
  - F7: run `diagnoseAbandonedRounds` for the goal's bucket to split synthesis, never-launched and verification failures.
  - F4: the post-#1018 GPU hour.

### E. Handoff status
- **~06:02Z:** F1–F3 sent to the repair owner, "the end?" (session_01QF5Tk7etm6MGmaFuHMd6eZ).
- **~06:07Z:** F6, F7 and the F1 correction sent to the same session. Both messages were delivered.
- **Blocker:** that session has been waiting on its own "Send Message" permission prompt since 06:06Z. The owner was push-notified.
- No repair has started from these findings yet. The repair session's own #1018 was deployed at 06:06Z.

### F. Diagnostic spending
- **Paid compute:** $0. No GPU or pod was started, and no workflow that spends money was dispatched.
- **Inference:** 7 read-only Claude subagents, about 1.2M subagent tokens in total, all completed. Nothing is still running.
- **Scheduled tasks left in place:** the deadline triggers (trig_01XynxgeaR3Cqux3E2cXqdPx, trig_016hxUVCfPFjDjRjWYCsbPvK) and the 60-minute checkpoint. They fire into this session only and cost nothing material.

### Ruled out / fixed (not blockers now)
- Budget cap: FIXED and not invalidated (last budget change #1011; later #1013/#1014/#1018 do not touch it; boot check worker.ts:2595-2604).
- Research ceiling 13: NOT BINDING (lane under-filled, see F4). Secondary once acceptance improves.
- CPU: fixed (#998), not re-measured; no evidence it limits work.
- Cost accounting: fixed (#1001/#1005/#1011).
- "Too busy to derive": cold-cache artifact (F0).

- F0 RULED OUT — "Brain was too busy to derive the goal": a cold-cache light reading (`server/services/operator/snapshot.ts:52-56`, full derivation bounded at 150 s, 25-min TTL). A second call at 05:58Z returned the full derivation. Not a cause.

## Handoff log
- ~06:02Z: F1, F2, F3 sent to the repair owner (session_01QF5Tk7etm6MGmaFuHMd6eZ) by send_message (delivered, priority next).
- ~06:05Z: the repair session has been stalled since 06:06Z on a "Send Message" permission prompt (its own reply). The owner was push-notified to approve or deny it. This blocks the repair work, not this diagnosis.
- First-wave review (before the 30-min checkpoint): all three first-wave investigators finished (assignment, research yield, research→planner, surge/learning). The second wave is running: why the goal's research rounds end without a report, plus an independent adversarial review. Approach unchanged; evidence is being obtained.

---

# READINESS VERIFICATION — deadline 15:00Z (10 a.m. Detroit), owner message 07:30:51Z

- Deadline trigger: trig_017oiQnAZANYV7fgBU8o9umk (15:00Z). Warning: trig_01H6qHPnSuWRfqC6FJmx5V7r (13:07Z). Both fire into this session, and the report is delivered here.
- Division of work, agreed 07:36Z:
  - The intelligence-recovery session (session_01QF5Tk7etm6MGmaFuHMd6eZ) is the integration owner. It merges in batches and runs the only Deploy dispatches.
  - Workstreams W1–W8 are listed in docs/intelligence-recovery/surge-readiness-plan-2026-11-17.md on branch claude/brain-intelligence-recovery-s0dl4l.
  - This session owns independent verification and the readiness decision.
  - It does not push to production before the final release. A docs push would cancel the Postgres gate on the release candidate.

## Verification checklist (owner §5), each closed only by a production reading

| V | Owner §5 item | Check | Status |
|---|---|---|---|
| V1 | Eligible work reaches intended workers | runpod-report or capacity: gpt-oss-120b takes RESEARCH_FRAGMENT with no HELD BACK; the goal's rounds get missions (#1024) | pending eda04071 |
| V2 | Research accepted and stored under the correct question/goal | cash report: monetization ANSWERED rises above 13 on snake_case lanes (#1023); the goal's accepted claims are above 0 | pending |
| V3 | Parked work progresses | parked packets with accepted claims get a SYSTEM synthesis-spent-recovery item and reach HARVESTED (#1025) | pending |
| V4 | Research reaches and influences plans | the goal plan shows arrangement members with justified inputs above 0 (W2), plus one traced decision | pending W2 |
| V5 | Missing knowledge produces follow-up, not a dead end | BRAIN_PROPOSES attributes are not commissioned; unresolved questions get a replan or assumption (W3) | pending W3 |
| V6 | Knowledge remains available | an accepted fact is read by a later plan reading (card fact → goalScenario inferOr) | pending |
| V7 | Cost accounting and spending controls | budget-cap shutdown evidence (#1002+#1011, pod 5e8ks9cr2o8yml 03:01Z) stays valid unless budget code changes; the W6 GPU hours show RunPod-billed spend matching the cap | reuse; re-check code diff |
| V8 | Sustained measured workload without a growing bottleneck | W6 stepped load test: accepted claims/h, queue drain, CPU/DB below saturation | pending W6 |
| G | Production gate | Postgres suite green and Deploy success on the released SHA; arrangementLibrary:284 accounted for (W5) | eda04071: suite rerun green (44030756257); Deploy 44036476327 running |

## Verification log

- **07:38:52Z, release:** Deploy 44036476327 of eda04071 succeeded. Its Postgres suite passed on the rerun 44030756257.
- **07:42Z, capacity reading:**
  - Free lane: 2 slots running, 37 items waiting. The `auto` provider failed 100% of 5 calls, and `auto/best-coding` is held at 1 slot. The GPU is off.
  - So without the GPU, research capacity is about 2 slots. The run's productivity depends on the GPU configuration that the W6 stepped load test will measure.
- **07:5xZ, the goal's 15 READY Routine bins: RULED OUT as a blocker.**
  - What they are: PLAY_RESEARCH packet bins. While brain-only mode is on, the §84 filter (`purposeAdmitsSql`, repos/bins.ts:1626-1630) keeps them from Routines.
  - Who does the work: under §85 the free lane claims their work items directly (freeLane/worker.ts:62-65, 237, 365-367). Production shows items leased today, e.g. wki_c1bc6322… RESEARCH_SYNTHESIZE at 07:40Z.
  - Residual wording defect, non-blocking: goals/model.ts:1129-1142 promises "Brain fires the next free Routine at bin …" without checking the bin's lane.
- **Traced example: CONFIRMED except two hops.** The chain runs from the objective through research and accepted evidence to a plan decision, for cop_9fd24b12b74c46c58c38:
  - discovery claim clm_0d48aae6… → buying_signal (discovery.ts:2125);
  - deep dive rcn_1d5f81bdd050415e9d61, 16/16 answered, accepted claims payer clm_00a2d7fb…@orc_91773939…, access clm_3457e54c…, fulfillment clm_e2c8ceec…, revenueRange clm_f869272e…, directCosts clm_d5db9c14…;
  - these become EVIDENCE card facts plus columns (validation.ts:2313-2347, answers.ts:110-130);
  - the pathway reads buyer, why and channel from those columns (pathways.ts:633-641), and price becomes a 14.83–250 range from revenueRange (goalScenario.ts:943-952);
  - plan decision: fit TOO_SMALL_AS_IS → CONSTRUCT "sell the same deliverable to buyers like this one; 17 buyers at 60.89" (Goals run 44027622659), and job cjb_dcb956… held at WAITING_RESEARCH on need cnd_940c629….
  - Not read: the revenueRange claim's full text, and whether the discovery claim was accepted.
  - Non-blocking defect: `textFact` marks any non-empty column PROVEN (pathways.ts:460-462). In this example buyer and channel do trace to accepted claims.
- **V4/V6 gap:** the goal-plan reading still carries readAt 00:02:39Z, because unchanged readings write no row. Fresh-derivation evidence has been requested from W4.
- **07:44Z, V3 (parked work progresses): PARTLY verified.** Source: admin `packets syntheses cash-mode-1`, run 44040994934 on eda04071.
  - Working: #1025 recovery. orc_39d6874b has replacement wki_ab38e84c QUEUED, and orc_a724b479 is ELIGIBLE.
  - Not working: 5 packets are NEEDS_HUMAN with accepted claims, no filed report, and their bin READY at 0/5. The recovery refuses each as SYNTHESIS_RECORDED. They hold 55 accepted claims that reach no report and no plan:

    | Packet | Accepted claims |
    |---|---|
    | orc_2539f7fb | 20 |
    | orc_c24e9e6c | 10 |
    | orc_1fa39ac9 | 9 |
    | orc_140bfeb8 | 8 |
    | orc_0053bbe0 | 8 |

  - Sent to the integration owner for an owner.
- **07:50Z, runpod report (run 44041674247, serving eda04071; 6 h window, mostly before the fixes):**
  - Lane throughput: accepted claims 31.3/h lane-wide, 0/h on the goal, 0 jobs on the goal.
  - Goal rounds: 9 abandoned in 6 h; RESEARCH_NOT_FINISHING 10/10.
  - Free lane: idle with work queued about 120 min. Average concurrency 1.63, peak 4.
  - RESEARCH_VERIFY: auto and auto/best-coding are HELD BACK on it after 152 "no JSON" replies. brain-a and brain-b fail at the provider.
  - GPU: 30 jobs, 1 accepted claim, $7.05 over 80 min at $5.29/h. All of it is pre-#1018.
  - Plan: 3.3 evaluations/h with no new reading row since 00:02Z, because unchanged readings write no row.
- **08:04Z, release candidate 2 = 74b0a3c3** (Deploy 44043605015; Fly expected around 08:45–09:00Z). It carries:
  - #1028: W4 instrumentation.
  - #1029: W3, F3e.
  - #1031: W2, F2 (arrangements read research through inferOr; textFact provenance comes from kindToProvenance).
  - #1032: W10 (synthesis recovery scoped to the current round, so the 5 judge-resumed packets are reissued).
- Still open on the repair side: W5 (Postgres flakes), W9 (RESEARCH_VERIFY "no JSON"), W11 (research items QUEUED since 11-11 and never claimed).
- W6 GPU stage 1 is running: SECURE H200 c316n2e7hp4up4, $5.29/h, cap $12/2.5 h. Readings at 08:50Z.
- An independent code review of #1029, #1031 and #1032 against 74b0a3c3 started at 08:05Z.
- **08:20Z, independent review of RC2 (eda0407..74b0a3c3).** Sent to the integration owner.
  - **#1031 (F2)**:
    - CONFIRMED: price. Evidenced distributions reach arrangement price as EVIDENCE/justified (goalScenario.ts:277-291).
    - CONCERN, medium:
      - close, respond, daysToCash, cost and capital infer through a synthetic `arr:<key>` target (:227-249), so only pooled project context moves them.
      - Not changed although claimed: volume and hours are still fixed (:380, :385-387); `candidateFromArrangement` (planSet.ts:365-405) still has acquisitionRoute, costs, capital and controls UNKNOWN; `inventedDesigner` (:548) passes no knowledge.
  - **#1032 (W10)**:
    - CONFIRMED: bounded and scoped to the round.
    - CONCERN, medium:
      - The once-per-packet exclusion (:917-922) is not round-scoped.
      - A bin exhausted by attempts is never regranted (:973).
  - **#1029 (F3e)**:
    - CONFIRMED: requiredCapability is still asked; only executionDifficulty and scalability are dropped.
    - CONCERN, medium: a declined path gets only a reason (commissionPass.ts:355, :369). There is no assumption, replan or next action, so the owner's §3 "no dead end" is unmet. The unstated-path filter also declines answerable attributes.
- **08:08Z, owners for the review findings** (PRs due 10:45Z, ship in release 3):
  - W2b: the rest of F2.
  - W10b: the #1032 holes.
  - W3b: the #1029 dead end.
- RC2 is now b46b757e (Deploy 44044038066). It adds #1033, the W5 test-only fix for the Postgres flakes (arrangementLibrary:284, cashIntegrationPass:1087).
- **08:13Z, final RC2 is 7cfcde99** (Deploy 44044888041). It adds #1035 (W11): `freeLaneAdmits` now admits bin-less work items in commercial projects. Free-lane show at 08:07Z found 23 such items in Cash Mode 1 waiting with no claimant.
- Release 3 (W2b, W3b, W9, W10b) is due about 11:00Z.
- **08:16Z, RC2 closed at 7ca851b6** (Deploy 44045317792). It adds #1034 (W9): RESEARCH_VERIFY now uses JSON mode and a targeted repair ask. A reply still in prose fails fast against that model instead of looping as a transient error. Release 3 holds W2b, W3b and W10b.
- **08:21Z, RC2 is 00eb4962** (Deploy 44045962334). It adds #1036 (W10b): one automatic recovery per round, and a bounded +4 regrant per round for a bin exhausted by attempts. Release 3 is now W2b and W3b.
  - Coordination risk: RC2 has been re-cut four times (74b0a3c3 → b46b757e → 7cfcde99 → 7ca851b6 → 00eb4962). Each new push restarts the Postgres gate.
- **08:27Z, RC LOCKED at bd5e0419** (Deploy 44046891820, live around 09:15Z). It carries #1028, #1029 and #1031–#1038, including W2b (#1038) and W3b (#1037).
  - Verification against bd5e0419 starts once it is live.
  - An independent review of #1037 and #1038 started at 08:28Z.
- **08:28Z, recalculation:** critical path is bd5e0419 live (09:15Z) → Postgres gate green on bd5e0419 → V1–V8 readings plus the W6 GPU stages on bd5e0419 (09:15–12:30Z) → report (14:30Z). Slack is about 2 h.
- **08:28Z, capacity reading during GPU stage 1:**
  - FREE_LANE: 0 waiting, 3 of 5 running. gpt-oss-120b runs at 2/3, idle for lack of research.
  - RESEARCH_SLOTS: 568 waiting, 13 running, capacity 16 (13 at 05:58Z).
  - With the GPU healthy, the binding constraint is work supply, i.e. the mission ceiling of the discovery grant. GPU sequences are not the constraint.
  - W6 has been asked to report the ceiling reached and whether it grew under load. If it does not grow, raising it becomes a readiness item.
- The 5 NEEDS_HUMAN packets are owned by W10/W10b (#1032, #1036 in bd5e0419). They are verified after bd5e0419 is live.
- **08:31Z, W12 assigned: the mission ceiling.**
  - Findings due 09:30Z: how the ceiling is computed, and why the adaptive ceiling (#1000) stopped at 16.
  - Fix PR due 10:15Z: the ceiling grows while ideas wait and the lane or GPU is idle, and shrinks under DB or CPU pressure.
  - W6 will report the ceiling reached, whether it grew, and sustained accepted claims per hour, first on bd5e0419 and then after W12.
- **08:45Z, review of #1037 and #1038 in bd5e0419.** Both mostly CONFIRMED.
  - Confirmed, file:line in the message to the integration owner:
    - same-buyer evidence counts;
    - hours and volume are inferred;
    - candidateFromArrangement reads evidence;
    - inventedDesigner receives knowledge;
    - a bounded hypothesis check makes paths stated;
    - card copies follow corrections.
  - Checks: typecheck passes with an 8 GB heap; 63/63 directly run tests pass.
  - CONCERN, medium, to be measured in W6: planner CPU. arrangementTarget loops over every opening with regex work for each of 400 arrangements. The check is the W4 plan-run time and loop lag.
  - CONCERN, medium, to be measured in W6: hypothesis-check commissions have no total cap across passes. The check is the share of hypothesis checks versus goal rounds once the mission ceiling rises.
  - Low: an UNRESOLVED check is not read by the goal planner; the old card copies have no backfill.
- **08:43Z, owners for the review concerns.**
  - W2c: planner CPU index.
  - W3c: cap on hypothesis checks; UNRESOLVED wired to a planner or Hermes reader.
  - Both PRs are due 10:00Z and ship in release 4 with W12, around 10:15Z.
  - W6 still measures bd5e0419 for plan-run time, CPU, loop lag and hypothesis-check share.
- **Recalculated critical path:**
  - release 4 merged about 10:15Z;
  - Postgres plus Deploy about 11:00Z;
  - V1–V8 and W6 re-measure on release 4 from 11:00 to 13:00Z;
  - report by 14:30Z.
  - Slack is about 30–60 min. The checks on bd5e0419 between 09:15 and 11:00Z de-risk the path: anything already verified there and untouched by release 4 does not need re-verifying.
- **08:54Z, W6 stage 1 result** (07:50–08:50Z on eda04071, SECURE H200 at $5.29/h):
  - GPU: 221 jobs, 11% not accepted, 4.22 slots busy on average, but only **2 accepted claims**, about $2.20 each.
  - The 120B model is **still HELD BACK on RESEARCH_FRAGMENT**: 20 of its fragment answers were dropped by "did not survive Brain's own checks". That is ACTIVE BLOCKER A1 for the surge. Owner: W13.
  - Lane-wide: 20.4 accepted claims/h. **The goal: 6.8 claims/h, up from 0**, with up to 7 goal jobs at once. So V1 (goal work reaches workers) is verified on eda04071.
  - Plan runs: median 0.5 s, but event-loop stalls of 2–3 s in evaluatorPool.ts (W2c).
  - DB: NORMAL, p90 21 ms, 33 pool-checkout timeouts.
  - The GPU is stopped until bd5e0419 is live.
- **09:01Z, correction.** The RC bd5e0419 Deploy FAILED its SQLite tests, so production is still on eda04071.
  - Cause (#1029): carryFigures wrote card claim ids into path facts, whose `claim_id` must reference research_claims. The FOREIGN KEY failure was bisected to between eda04071 and 74b0a3c3.
  - Fix #1041: the copied fact becomes a RECOMMENDATION with the cited id in its basis.
- **Release 4 = f4eb5352** (Deploy 44051739781) is bd5e0419 plus:
  - #1041, the FK fix;
  - #1039, W12 mission ceiling: GPU room counted through provenSlots; growth when launchable ideas exceed free slots; bound of floor + max(48, proven slots);
  - #1040, W3c hypothesis cap: one per opening, at most a quarter of the grant, none while a goal round waits.
- W12 finding: one fragment per mission, so jobs scale about 1:1 with missions.
- Still open: W2c (planner CPU), W13 (120B fragments dropped).
- Integration lesson: a release candidate re-cut five times left the Deploy test on bd5e0419 as the first full SQLite run of #1029. That cost about 40 min.
- **09:06Z, release 4 is now 72008cd2** (Deploy 44052412701, live about 09:50Z). It adds #1042 (W2c): the planner index cut the fixture with 400 arrangements, 1k openings and 3k facts from 19.6 s to 0.9 s, and 754/754 impacted tests pass. Only W13 (120B fragment drops) remains open.
- **09:21Z, release 5 is 4cec7709** (Deploy 44054816761, live about 10:05Z).
  - Release 4 (72008cd2) passed every test and the Postgres gate, but Fly skipped it because #1043 landed first.
  - Release 5 adds #1043 and #1045 (W13).
  - **W13 root cause, reported by the integration owner:** 20 of the 120B's 21 "drops" were empty claim lists.
    - planCoverageFragments overwrote the planner's source rules for gap fragments with official-only sources. Vendor pages were excluded, so the model correctly listed nothing.
    - Fix: gapSourceRules copies the planner's rules for that requirement.
    - An empty list with a stated reason is now neutral for fitness. A bare empty list still counts against the model.
  - W6 stage 2 runs on release 5.
  - Verification status: SUPPORTED, not CONFIRMED until W6 stage 2 shows the 120B with no HELD BACK on RESEARCH_FRAGMENT and accepted claims per GPU-hour well above stage 1's 2.
