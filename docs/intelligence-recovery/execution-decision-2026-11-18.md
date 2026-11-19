# Final Crusade: execution decision report (due 23:00Z, 2026-11-18)

Status: DRAFT, maintained continuously, and delivered by 22:55Z whatever its state. Deadline wake: trig_01EAf9ajtcog2vnUcw9CP85E at 22:30Z.

## Inputs in progress
| Input | Status |
|---|---|
| R-A: engineering throughput and release waste | running, due 21:30Z |
| R-B: workforce and capacity audit | running, due 21:30Z |
| R-C: capability status vs finish line, remaining work, strong-model comparison | running, due 21:45Z |
| P1 executable steps · P2 research targets the blocking input · P3 REHEARSAL across 5 objectives · P4 stable construction | development lanes, PRs pending |
| Infrastructure | release owner session_01QF5Tk5PWzBxNPixWvFTPEd. Release #1102 (4730acd7) live since 19:02Z. GPU unavailable within the ceiling. |

## Known facts (already measured)
- **Money:** RunPod balance about $105.21; run spend about $8.57; GPU at $0/h now. Engineering runs on subscriptions; no per-hour cash cost is recorded.
- **Live goal:** NOT_VIABLE. Steps: 1. Reach 55–59% (coverage).

## Capacity reading, live, 19:26Z (brain_operator_capacity)
| Pool | Waiting | Running | Capacity | Brain's own verdict |
|---|---|---|---|---|
| ROUTINES (Claude subscription Routines) | 1 | **0** | 12 | "capacity is unexplainedly idle" |
| FREE_LANE | 5 | 4 | 4 | Growth past 2 per model held: "measured gain at model-interpretation is 0 accepted facts/h" |
| RESEARCH_SLOTS | 724 | 14 | 13 | 723 ideas are capped by the project grant's at-once ceiling |
| FACTORY | 1 | **0** | 1 | "executable work and a free surface, nothing running: that is a fault" |

- **Allocation (24 h):** the $10K goal has share 1, stance EXPAND, reach 56% (coverage); every other goal is on HOLD.
- **Permission stalls:** two report agents (R-B, R-C) blocked on MCP permission prompts at about 19:30Z. Earlier today agent H was blocked for about 2 h the same way.

## R-A: engineering throughput, measured (2026-11-15 19Z to 11-18 19:24Z, about 67 h)
- **PRs merged into production:** 149, i.e. 2.2/h; 61 on 11-17.
  - 117 from Claude sessions, median size 69 lines.
  - 18 from Factory, median 757 lines.
- **Deploy runs:** 113.
  - **44 went live (39%).** 39 superseded, 16 failed, 14 cancelled.
  - **Wasted: 61% of runs**, and 63% in the last 48 h.
- **Times:**
  - median dispatch to live: **36 min**;
  - median merge to live: **66 min** (p75 104, max 207);
  - Postgres suite median: 22 min.
- **Release-lane hours lost in 48 h:** collisions about 7.1 h, flakes 1.9–3.7 h. That is **about 9–11 h out of 48 h**.
  - Superseded by sessions 29, by Factory 6, by others 4.
  - Factory and sessions supersede each other in both directions.
- **Flaky tests seen:**
  - systemSelfModel, productionPrecedentAndFacts F2, packet invariant;
  - arrangementLibrary, cashIntegrationPass, capacity-d0-p0-scaling, acquisition-d07;
  - quantOffLoop (wall-time).
- **Postgres compute on failed attempts:** 26.5 shard-hours in 48 h.

## R-B: workforce audit (19:24–19:33Z)
| Class | Identities | Slots | Executing | Output | Cash |
|---|---|---|---|---|---|
| Claude Routines | 3 real accounts (A Max, Caleb, Airyn), 12 research Routines | the account targets add up to **9** (124k ACCOUNT_TARGETS_REACHED refusals) | **0** | about 0 today; 1,253 READY bins are policy-parked under §84 | $0 (sunk) |
| Factory | 3 surfaces; 2 quarantined | **1** | 0 (1 waiting) | 6 PRs in 24 h; a campaign repeated 4× (RULE_EFFECTIVE_SOON @2–@5) | $0 |
| Hermes | 1 hourly one-shot run (northline-operator) | 1 | history not readable from this credential | unmeasured | $0 |
| Free lane | 2 OmniRoute routes | 4 (held) | 4 | **1.9 accepted claims/h** last hour, against 28.7/h overnight with the GPU | $0 |
| GPU | 1 pod, H200 COMMUNITY | 12 seq configured, about 6 effective (Fly event loop) | 0 (EXITED; host full) | today $8.57 for 0 claims; overnight $0.21/claim | $3.59–7.99/h |
| Claude Code sessions | 2 live (coordinator + release owner) | not measured | the release owner has been **blocked on a Bash permission prompt since 19:30Z** | 33 PRs/24 h (about 1.4/h; about 0.5 PRs per session-hour [inferred]) | $0 (sunk; the API-equivalent figure for the coordinator is $923) |

- **Utilization:** no single defensible %.
  - Routines 0%, Factory 0/1, GPU 0%.
  - Free lane full but low-yield.
  - Release pipeline busy 55% of today.
- **Binding constraints:**
  1. the release pipeline, one at a time at about 45–60 min merge-to-live;
  2. permission prompts;
  3. the Fly event loop (about 6 GPU slots);
  4. research yield.
- **Stalls today:** agent H about 2 h on a permission prompt; the release owner since 19:30Z; 2 supersessions by Factory; a worker restart lost about 3.5 h (11:25→15:01Z); the stop/disconnect ordering cost about $1.20; probe pods leaked.

## R-C: capability status (production 4730acd7, reading 19:20Z, REHEARSALS labelled)
- **None of the 13 capabilities is verified on production as a whole.** Only sub-parts are: library retrieval, gap identification, fact supersession, and rebuild-after-failure.
- **MISSING/DEFECTIVE:**
  - #1 objective reading: the planner budget equals the target in 6/6 objectives;
  - #4 research targeting;
  - #10 executable plan: 1 generic step; F3 is the cause, in plan.ts planSteps;
  - #13 adaptation: same candidate for every objective.
- **PARTIAL:** #2, 3, 5, 6, 7, 8, 9, 11, 12.
- **New defects:**
  - F2: two models contradict each other, and a $38.7M modelledP50 appears;
  - F4: 15 research bins READY and unworked since 11-14;
  - F5: no commercial grant, so calibration and acceptance are impossible without the owner.
- **REHEARSALS:**
  - evaluator 69/70 (61/76 at the 11-14 baseline);
  - P3 objectives: production fails every objective; the P3 branch passes 2/6 cleanly;
  - P2 6/6, P4 4/4.
- **Remaining code work:** about **20–38 agent-hours**, about **10–16 h wall-clock** at 4 lanes with about 2 release cycles per item.
- **Critical path:** objective reading → the candidate obeys constraints → **one economic model** (bottleneck) → executable steps → targeted research plus capacity → research changes the plan on production → production test on 2 or more unfamiliar objectives → (owner's commercial grant) → calibration and learning from outcomes.
- **Strong-model comparison:** the gap is integration and procedure, not model competence.
- **Started at 20:0xZ:** P5 "one economic model" (claude/p5-one-model), the critical-path item.

---
# FINAL REPORT (delivered about 19:50Z, before the 23:00Z deadline)
The executive answers are in the chat message of the same time. This file holds the supporting evidence, sections R-A, R-B and R-C above.

## Finish line
**Mandatory, all verified on production:**
1. **Objective reading:** amount, deadline, capital, hours and industry are read correctly for unfamiliar objectives.
2. **Constraint-obeying selection:** the candidate changes with the objective (capital, industry, recurring vs one-off, deadline).
3. **One coherent economic model:** an arrangement with an unknown price is modelled with the price as its variable, with a break-even and a required price. There are no contradictory models and no impossible aggregates.
4. **Executable steps** from the chosen candidate: buyer route, fulfilment, settlement, costs, kill criteria, and each unknown as an explicit research step.
5. **Targeted research:** research asks for the single blocking input, and the research capacity actually runs.
6. **Research changes a plan on production:** an accepted answer moves a goal-level economic figure or choice, with lineage.
7. **Transfer:** items 1–6 hold on at least 3 objectives on production (the $10K live goal plus 2 unfamiliar ones in separate projects).

**Accelerators, not mandatory:**
- the merge hold during in-flight releases (O1);
- flaky-test hardening;
- pre-approving the read-only Brain tools for agents (permission stalls);
- stable construction sampling (P4);
- GPU research capacity.

**Optional or later:**
- calibrated 90% acceptance and learning from real outcomes. These need the owner's commercial grant and weeks of real market tests. Code cannot finish them.
- larger construction budgets;
- a 2nd Factory surface;
- Hermes run-history visibility.

## 20:27Z: first Final-Crusade planning batch released
**Deploy 44391060795 on 87847cc7** contains:
- **#1107** merge hold;
- **#1106 + #1109** objective reading, and sales obey the goal's limits;
- **#1104** one blocking input per research question;
- **#1105** deterministic, evidence-first construction;
- **#1108** executable steps from the leading arrangement;
- **#1110** one economic model:
  - an unknown price is a variable with break-even (the postcard needs ≥ $389.58 per slot at 12 slots, $1,222.92 per slot for $10K);
  - one coherent verdict;
  - the $38.7M aggregate is fixed.

**Still running:** P6 (the plan obeys the objective: capital, industry, recurring, deadline).

**Next:** once the batch is live, free production reads of the live goal check finish-line items 1, 3, 4 and 5.

## 21:53Z: production verification of the planning batch
Release 9d110770, live 21:44:40Z. Reading of goal wst_7b4fcbb5f2384f31b6c3 at 21:53:43Z.

**Passing:**
- **One coherent verdict:** NEEDS_EVIDENCE. Before, NOT_VIABLE sat beside a 56% candidate.
- **Aggregate:** modelledP50 is $39,260 (= the candidate's, modelledOf named). Before it was $38.7M.
- **Research changes plan economics on production (finish-line item 6, verified):** `priceVariables` for the postcard arrangements (2821cce3c372, acd11bf7f80f) carry the run cost $4,675 sourced to claim **clm_9cf1f15cc99846198399**.
  - Break-even per slot: 6 slots → $779, 12 → $390, 24 → $195, 48 → $97.
  - For $10K: 12 slots at $1,223 each.
  - "Price is the blocking assumption."
- **Executable steps (item 4):** 12 typed steps instead of 1 generic line. Each has its kind (RESEARCH, EXECUTE, VALIDATE), a question, dependencies, permissions needed and kill criteria:
  1. research buyers, price, supply, settlement, cost per deal, repeat;
  2. reach the buyers;
  3. validate as a refundable presale;
  4. collect at the minimum;
  5. deliver;
  6. run the next group.
- **Honesty:** both candidate prices read ASSUMED; nothing is certified.

**Weak:**
- The leading candidate is the generic "anonymous members of the public: Brain produces a spreadsheet/document…". The postcard arrangement, which holds real researched cost, is not the leader, because its price is unknown.
- The steps are generic because the leader is generic.
- P4 (stable selection) is reverted and being reworked.
- P6 (the plan obeys the objective) is next to release.

## 22:35Z: closing addendum to the 19:50Z report
Finish-line status:

| # | Item | Status |
|---|---|---|
| 1 | Objective reading | #1106 LIVE on 9d110770. #1112 (recurring, industry, hours, "little capital" = an assumed $1,000 up-front ceiling) is releasing in Deploy 44410753096 on be9cf998. REHEARSAL: all 6 objectives pass every check. |
| 2 | Plan obeys the objective | #1112 releasing. REHEARSAL 6/6. |
| 3 | One economic model | **VERIFIED ON PRODUCTION**, 21:53Z: one verdict; no $38.7M; price as a variable with break-even. |
| 4 | Executable steps | **VERIFIED ON PRODUCTION**, 21:53Z: 12 typed steps with kill criteria. The leader is still generic. |
| 5 | Targeted research | #1104 and #1111 LIVE. The research run has not yet been observed asking for the slot price. The GPU is unavailable within the price ceiling; the free lane continues. |
| 6 | Research changes plan economics | **VERIFIED ON PRODUCTION**, 21:53Z: priceVariables carry the run cost $4,675 from claim clm_9cf1f15cc99846198399. |
| 7 | Production test on 2 or more unfamiliar objectives | NOT STARTED. It needs goals created in separate projects, after be9cf998 is live. |

- Also releasing: #1114, stable selection (rotation by pass counter).
- **Pace:** 6 lanes delivered items 1–4 and 6 as code in about 3.5 h. That is faster than the 10–16 h estimate, so the critical path is now **release cycles plus the production test (item 7)**.
- **Revised fastest completion:** about **12–24 h** from now, down from 24–72 h. The remaining risk is that the plan's leading candidate stays generic until targeted research returns a real slot price.
- **Cost:** unchanged. $0 required; GPU optional.

## 23:55Z — release 7e927515 live; finish-line item 7 run on production

- Deploy 44417799307 (7e927515: #1112 objective obedience, #1114 reverted by #1116) reached Fly 23:38:29Z.
- $10K goal (wst_7b4fcbb5f2384f31b6c3) on 7e927515: the reading carries the objective's limits — "at most USD 375 before any money comes in; at most USD 750 newly tied up a week; at most USD 3000 in all"; candidate reach 54.1% (coverage), p50 $28,546, NEEDS_EVIDENCE.
- Item 7: two unfamiliar objectives created in separate projects through the Goals console (runs 44418875326, 44418892413):
  - wst_66311cabe7e5442faa98 (Cash Mode 3): "Turn 10,000 dollars of starting capital into 100,000 dollars within 90 days".
  - wst_db2e2e0e5204477692d5 (Cash Mode 4): "Earn 5,000 dollars a month in recurring revenue within 60 days, ≤10 owner hours a week, ≤1,500 dollars capital".
- **Result: FAIL.** Both plans are NO_CANDIDATE and identical in shape: lead arrangement buyer "viktorrria", offer "germany" (freelance-marketplace residue); every constructed arrangement cut ("the project holds no published price"; on 7e927515: 68 of 208 in the goal's scope, all cut); "5,000 dollars a month" read as a 5,000 total.
- Defects D1 (junk construction labels), D2 (a fresh project sees no Brain-level price evidence), D3 (monthly-rate objective read as a total) assigned to a code agent on branch claude/fresh-goal-plans.

## 01:15Z 11-19 — #1118 live (a5a0adf9, Fly 01:07:32Z); item 7 re-read

- Fixed on production: no "viktorrria"/"germany" (HN author handles and place names no longer become buyers or offers); the monthly goal reads "5000 USD settled cash a month (a recurring run-rate, counted over the trailing 30 days, to be reached by the deadline)"; borrowed prices now reach a fresh project ("among the Brain's validated findings").
- Still failing: both fresh-project goals construct only 4 arrangements (the 204 others were the junk) and cut all 4 (borrowed prices too dispersed to compare). NO_CANDIDATE. Root cause under investigation: construction reads only the goal's own project's map, so a new project cannot reach the 16,262-arrangement map Brain holds in Cash Mode 1. Assigned to branch claude/fresh-goal-knowledge.

## 02:15Z 11-19 — #1120 live (a56a65fb, Fly 02:07:22Z); all three objectives now plan

| Goal | Constructed | Estimated | Candidate | Reach (coverage) | p50 | Steps |
|---|---|---|---|---|---|---|
| $10K in 30 days, ≤$3K (wst_7b4f…, Cash Mode 1, own map) | 404 | 12 | Puzzle Society (quant portfolio) | 53.3% | $27,907 | 12 typed steps |
| $10K → $100K in 90 days (wst_6631…, fresh) | 404 (888 candidates) | 12 | retainer on Crucinova (reconstructed) | 1.4% | $705,442 | 2 (retainer; sell and collect) |
| $5K/month recurring in 60 days, ≤10 h/week, ≤$1.5K (wst_db2e…, fresh) | 404; 165 in scope | 12 | VA (quant portfolio) | 1% | $11,378 | 12, ending "Renew the same VA for the next period" |

- Item 7 moves from NO_CANDIDATE to CANDIDATE_ONLY on both unfamiliar objectives, scoped to each objective (165 of 404 in scope for the monthly goal; a renewal step for a run-rate). The $10K goal is unchanged by #1120 (own map).
- Low reach on the two new goals is an honest reading: their inputs are borrowed MECHANISM bounds, not evidence.
- Remaining defect: buyer labels are often not reachable populations ("Crucinova itself", "paying", "therefore an unidentified individual", "individual account of unknown business"). Assigned to branch claude/buyer-names.
- Also seen: the 100K reconstruction reports p50 $705,442 beside a 1.4% reach. That is a heavy-tailed sweep (p10/p50/p90 $1,011/$16,621/$542,162 at baseline), not an error, but it reads badly. Noted, not yet changed.

## 03:40Z 11-19 — #1122 live (0565698b, Fly 03:23:38Z; also carries Factory #1121)

Fragment buyers are gone from all three plans. Leads now:

| Goal | Lead buyer | Reach (coverage) | p50 | Scope |
|---|---|---|---|---|
| $10K/30d (Cash Mode 1) | homeowner | 55.3% | $16,939 | 404 constructed, 12 estimated |
| $10K→$100K/90d (fresh) | state technical utility services bureaus | 0.4% | $185,840 | 404, 12 estimated |
| $5K/month/60d (fresh) | Artisanal Sudoku | 0.3% | $39,595 | 147 of 404 in scope, 12 estimated |

Other buyers in the plans: VA, employer, small business operators, St Louis Development Corporation, Puzzle Society. Each plan has 9–12 typed steps with kill criteria. All three are CANDIDATE_ONLY, which is correct: their inputs are assumptions, not evidence.

Still open:
- The lead changes from read to read (Puzzle Society → homeowner on the same goal). This is the parked P4 stable-selection defect.
- Item 5 (a research round asks the slot price) is not yet verified; I asked the release owner for the round id.

## 05:55Z — P4 stable selection live (#1123, release 1a4ea56e)

**Root cause:** every plan read stores what it composed in the arrangement library (`rememberArrangements`), and `selectCandidates` ranked candidates by that stored p50. So a read reordered the next read's candidates.

**Fix:**
- The selection reads only research verdicts.
- Rotation advances by the hour.
- The goal's recent leaders are held.
- Evidenced candidates come first.

**Deploy 44461261520:** all 4 SQLite shards passed, including shard 4, which failed #1105 and #1114. Postgres passed. Fly passed.

**Production, sequential reads on 1a4ea56e:**

| Goal | Reads | Lead (identical on every read) |
|---|---|---|
| wst_7b4f… ($10K/30d) | 3 (05:30, 05:33, 05:38) | arr_ed03111d5938 "Small and mid-size firms sending year-end client and employee gifts", reach 24.5%, p50 $2,610 |
| wst_6631… ($100K/90d) | 2 | arr_1c912684db66, reach 0.4%, p50 $185,840 |
| wst_db2e… ($5K/mo) | 2 | arr_88ba66b2ee5c, reach 0.3%, p50 $39,595 |

Repeated reads are now stable.

**Open:** the $10K goal's previous lead (arr_19a99390e28b homeowner, 55.3%) was not held across the release. An agent is establishing whether that is a held-leader defect or a lead that existed only because of the stored-p50 ranking.

## 07:05Z — Held leaders at model entry (#1125, release cb6d27b5) and item 5

**#1125:**
- Deploy 44470197803 passed all 4 SQLite shards, Postgres and Fly.
- Production reads on cb6d27b5:

| Goal | Reads | Lead | Reach (coverage) | p50 |
|---|---|---|---|---|
| wst_7b4f… ($10K/30d) | 2 (06:49, 06:54), identical | RECONSTRUCTED arr_1ccdb59e0206 + cop_880e5bc7 | 70.1% | $30,664 |
| wst_6631… ($100K/90d) | 1 | arr_1c912684db66, unchanged | 0.4% | |
| wst_db2e… ($5K/mo) | 1 | arr_88ba66b2ee5c, unchanged | 0.3% | |

- On the $10K goal, an implausible combination (median 2118× capital) was flagged and refused.
- The plan output does not print the model's slot names, so the LEADER slot itself is not directly visible on production. What is visible is "4 held as the plan's leaders" and a stable lead.

**Item 5, the price re-ask (verified by the release owner, probes 44471115583 and 44471399871):**
- 05:35:32Z: round cdr_df62f598e6044e029644 asks "$N per slot" (UNIT_ECONOMIC price_per_unit) for arr_1ccdb59e0206. It took the slot from an hour-stale pathway round (#1117).
- 2821 is eligible and next in line.
- The candidate is QUEUED: grant rgl_2b3bcf1a holds 13 of 13 live mission slots (6 RESEARCHING, 7 AUDITING), with 914 ideas waiting. This is a capacity limit.
