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
