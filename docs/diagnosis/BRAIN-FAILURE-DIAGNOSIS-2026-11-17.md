# Brain failure diagnosis — 2026-11-17 (two-hour mission)

- Start: 2026-11-17T05:56:35Z. Deadline: 2026-11-17T07:56:35Z (trigger trig_01XynxgeaR3Cqux3E2cXqdPx; warning/90-min trig_016hxUVCfPFjDjRjWYCsbPvK; 30/60-min checkpoints trig_01X4grJFbeiFQAWDY7C5gvFH, trig_01VW48zhUGaqV9hWPxVDZaEe). Delivery: this session's final message (owner reads it in the Claude app), plus this file on branch `claude/brain-failure-diagnosis-4yjquv`.
- Main project: session "the end?" (session_01QF5Tk7etm6MGmaFuHMd6eZ) — owner's "FINAL PREPARATION DIRECTIVE — FIVE-HOUR HARD DEADLINE" (03:21:49Z): prepare Brain for a 12-hour paid intelligence run (part of the $250 acceleration), resolve blockers (refused research, CPU, concurrency/queue limits, research not reaching planning/learning, cost accounting), A–G report starting "READY: YES/NO". Deadline **08:21Z** (trig_01AN2Lp5Gch4ZJrsb3EGwiJy; checks trig_01Epq4rX4XYoYATMndH3SicM 07:21Z, trig_01WuAFXNR9Z4W26vGVCcZBRE 07:51Z; backstop trig_01BbiRcqUbbP5u6VRmfMMiTh 08:26Z reads docs/intelligence-recovery/major-run-decision-2026-11-17.md on claude/brain-intelligence-recovery-s0dl4l). Not changed by this mission. It is the repair owner.
- Its latest measured state (capped H200 hour, pod byvgxskr1db92q, $3.59/h, 04:38–05:49:58Z; runpod-report 44026244200; stopped by 44026723215): gpt-oss-120b took 27 jobs, **1 accepted claim**; GPU 0.28 slots busy; lane-wide 51–52 accepted claims/h mostly from free `auto/best-coding`; **$10K goal 0 accepted/h**; "RESEARCH_NOT_FINISHING: 3 of the goal's last 3 settled rounds ended without a report"; 120B held "unfit" for fragments (fix #1018 merged 05:54Z, Deploy 44027365881 running); free providers brain-a/brain-b 100% failing (Cerebras 402 credits exhausted, Groq daily limit, a 404 model). Verdict NO-GO. Already fixed by it: GPU routing (#984), scheduling deadlock (#992/#995), refusal accounting (#989/#990), cost accounting (#1001/#1005), budget cap verified (#1002+#1011, pod 5e8ks9cr2o8yml auto-stopped 03:01Z), one-dispatch launch (#1013), #1014–#1017.
- Status: IN PROGRESS. Updated as findings land.

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

### F4 CONFIRMED — surge throughput is limited by answer acceptance, not GPU uptime or the ceiling of 13
- EVIDENCE: runpod-report 44026244200 (05:45Z, a10cc63): gpt-oss-120b 27 jobs, **1 accepted claim** in 60 min ($3.59), **held back on RESEARCH_FRAGMENT** after earlier dropped fragment answers, GPU 0.28 slots busy. Free `auto/best-coding`: 12 of 17 jobs not accepted (5 provider timeouts, 4 no JSON, 2 checks, 1 DNS); `auto` 0%; brain-a/brain-b dead (Cerebras 402, Groq limit, missing model; #1015). Free lane averaged 1.68 of 4 jobs busy, so raising 13 adds queue, not claims. GPU is disconnected now (runpod-disconnect 44026630515, stopped 44026723215 05:49Z).
- CHANGE: owned by the main session — #1018 (re-probe held pair, judge on latest answers) deploying in 44027365881; then a capped GPU hour.
- VERIFY: 1-hour runpod-report with GPU connected: no HELD BACK on RESEARCH_FRAGMENT, RUNPOD_ACCEPTED_CLAIMS ≫ 1, GPU >1 slot busy, and claims on the $10K goal >0/h.

### F5 CONFIRMED — no retained commercial learning loop exists yet
- `goal_outcomes` → calibration only from accepted plans (`recordGoalOutcome` plan.ts:3180-3198; `goalPredictionRows` calibration.ts:261-272 skips readings with no probability) → with F1, the calibration record stays empty forever.
- Evolution engine: 0 completed cycles; evolution-eval runs 43999026354 (baselines only), 44000206068 ("Nothing is awaiting evaluation"); not run since 02:03Z despite `13,43 * * * *`. Suites are narrow (feasibility = one false-acceptance judgement on 67 cases; planSpeed; mootRequests). `evolution_approach_stats` (repos/evolution.ts:391) is read only by experiments.ts:139-145 — nothing in planning reads it. Operator lessons go to the director as prose (actions.ts:105, judge.ts:45).
- This is the capability the run is meant to build; it is not a precondition, but the run needs a metric that records what it learned (see F1).

### Ruled out / fixed (not blockers now)
- Budget cap: FIXED and not invalidated (last budget change #1011; later #1013/#1014/#1018 do not touch it; boot check worker.ts:2595-2604).
- Research ceiling 13: NOT BINDING (lane under-filled, see F4). Secondary once acceptance improves.
- CPU: fixed (#998), not re-measured; no evidence it limits work.
- Cost accounting: fixed (#1001/#1005/#1011).
- "Too busy to derive": cold-cache artifact (F0).

- F0 RULED OUT — "Brain was too busy to derive the goal": a cold-cache light reading (`server/services/operator/snapshot.ts:52-56`, full derivation bounded at 150 s, 25-min TTL). A second call at 05:58Z returned the full derivation. Not a cause.
