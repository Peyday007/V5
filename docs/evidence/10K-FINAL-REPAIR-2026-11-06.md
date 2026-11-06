# The $10K chain: final coordinated repair (2026-11-06)

Owner's order, 2026-11-06: reconcile the twelve problems the 2026-11-05 test
found (`10K-SYSTEM-TEST-2026-11-05.md`) with what is merged, deployed or owned
by another session; finish every remaining software fix; restore the database;
keep research moving without RunPod; run the permanent `GOAL_PLAN_MAP` test on
production and repair what it finds. Every figure below was printed by
production; the run that printed it is named beside it.

Goal `wst_7b4fcbb5f2384f31b6c3`, project `prj_22fb4fec295f403a8a22`.

## 1. The twelve problems, reconciled

The 2026-11-05 test marked fourteen stages BROKEN or MISSING. Two are not
software: the GPU (RunPod host capacity) and the free providers' own quotas.
Buyer identification and pricing are one requirement on the map
(`EVIDENCE.BUYER_PRICE`). That leaves twelve.

| # | problem (2026-11-05) | fix | owner | state at 01:46Z, 2026-11-06 |
|---|---|---|---|---|
| 1 | Database saturated: pool 8/8, 1 029 callers waiting | #531 #537 #538 #542 #543 #544 | DB session, this session | Server healthy (pool wait p95 57 ms, no lock waits); what remains is event-loop stalls of up to 65 s that cost the pool its connections (`CONNECTION_LOST` 54). See §2 |
| 2 | Deploy health: duplicate migration 137; guard read a timeout as a wrong build | #538, #540, #546 | DB session, 11-05 test session | Fixed. Deploys 42142024100 and 42145629357 succeeded |
| 3 | No permanent whole-chain test | #540 (`GOAL_PLAN_MAP`) | 11-05 test session | Fixed. Runs hourly and 15 min after each release |
| 4 | Goal planner held the event loop (11.6 s) | #541 | §90 session | Fixed |
| 5 | Cash passes held the event loop (82 s) | #547 | §90 session | Live 01:51Z |
| 6 | Scheduling: packets idle, claimable work waiting | #510, #530 | Factory, §90 session | Still BROKEN (`RECOVERY.STALLS` 1/29): the work is queued; the lane cannot execute it (rows 1, 12) |
| 7 | Error recovery: `RECOVERY.RETRY` 123/298 | #508, #523 | Factory, research session | UNPROVEN (12 retries in the window) |
| 8 | Research packets do not finish | #529, #535 | research session | `DECISION.JOB_OUTCOME` 0/5, `ANALYSIS.AUDIT` 9/15 |
| 9 | Source discovery 43%, verification 28% | #532 | research session | UNPROVEN: too few attempts since the fixes |
| 10 | Goal rounds end without a report; constructed rounds abandoned | #525, #547 | §90 session | No round settled in the window; 8 open |
| 11 | Buyer and price never established | behind 8 and 10 | — | `EVIDENCE.BUYER_PRICE` 0/17 |
| 12 | No opening reaches the plan | behind 10 and 11 | — | `RUNPOD_GOAL_OPENINGS` 0 |
