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
