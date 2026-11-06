# Parallel execution (§90): production result, 2026-11-06

Owner's order 2026-11-05 19:18Z: run every independent part of an objective at
once, start downstream work as soon as inputs exist, and prove it on the $10K
goal (`wst_7b4fcbb5f2384f31b6c3`). Every figure below is read from production
rows by `goalPipelineSpeed` (`server/services/goals/researchYield.ts`),
printed by `scripts/runpod-report.ts` (Cheap lane workflow, `runpod-report`).

## What changed

| PR | Change |
|---|---|
| #530 | Plan re-read on evidence (2-min floor, 30-min backstop); goal-plan pass beside Russell's tick; a round frees its research slot when its fragments are terminal; free-lane searches and page fetches in parallel, one per host; a call that never reached the database is retried; one `IN (…)` read instead of one checkout per row; production speed measurement |
| #534 | `hours` input for the report, for before/after windows |
| #535 | An audit lists the 25 most recent siblings instead of reading the whole layer at once (pool queue 1 021 → single digits) |
| #541 | `constructArrangements` hands the event loop back every 25 ms (11.6 s stalls) |
| #547 | Cash continuations 25 a pass; card readings yield between items (82 s stalls) |

The coordinator session's #557 (storage keep-alive: 1 113 → 3.9 TLS handshakes a
minute), #558, #561 and #562 shipped with them in `93bb258` (live 05:33Z).

## Before and after

| Measure | Before (18:30–21:30Z, 2026-11-05) | After (05:05–06:05Z, 2026-11-06) |
|---|---|---|
| Accepted research claims per hour, all work | 6.7 | 17.6 |
| Accepted research claims per hour, $10K goal | 0.7 | 6.9 |
| Free-lane jobs in flight, average / peak | 2.07 / 6 | 3.06 / 10 |
| $10K goal's jobs in flight, average | 0.31 | 1.96 |
| Free lane idle with work queued | ~17 min an hour | 0 |
| GPU | 2.35 slots busy while running, $0.24/h | 3.38 slots busy; $0.20 for 50 min, $0.0063 a job |
| Plan (quantitative) evaluation, median | 0.3 s | 0.4 s |
| Goal submission → first plan reading | 96 min | 96 min (unchanged: the first reading predates this work) |
| Goal submission → complete (RECOMMENDABLE) plan | not reached | not reached |
| Openings evaluated per hour / new openings | 0 | 0 |
| Opening → next plan read | not measurable (no new opening) | not measurable (no new opening) |

Readings: Cheap lane run 42113248430 (21:30Z, `hours=3`, the "3h before"
window) and job 127742450021 (06:05Z, `hours=1`); stall readings from the
Connection report jobs 127608266611, 127651859067 and 127696592499.

## What this does not show

The $10K plan still reads NOT_VIABLE over 17 openings; none of the hour's
accepted research filed a new opening. Throughput is up about 2.6× overall and
about 10× for the goal; whether that research finds a buyer and a price is the
research's, not the scheduler's (`why short` in the report: 16 of 17 openings
lack a reachable buyer, 15 of 17 a supported price).
