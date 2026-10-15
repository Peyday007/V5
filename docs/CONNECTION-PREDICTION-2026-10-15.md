# Can the next connection failure be seen before it happens? — 2026-10-15

Read from production with `connection-report --history` (revision `312edb5`), over
2026-09-16 to 2026-10-15. Rows only. Every rate below is a count of rows, and
the denominator is stated.

## What the rows can and cannot say

- `DISPATCH_NO_SHOW` exists from 2026-09-23, `RECOVERY_PROBE_FIRED` from
  2026-10-03, and `infra_incidents` from 2026-10-06.
- `DISPATCH_SESSION_ARRIVED` and `DISPATCH_WRONG_WORKER` exist only from
  2026-10-11T17:01. **Before that there is no per-fire arrival record.** Any
  signal built on arrivals is measured over four days only.
- **No quarantine transition is recorded.** `setRoutineState` overwrites
  `fleet_routines` with no history row. A quarantine's time is inferred from
  the third no-show, the first wrong-worker arrival, or the first recovery
  probe. That is a telemetry gap.
- Pressure state (`SHEDDING`/`NORMAL`) is kept only per live process, so its
  history cannot be read back.
- History for Airyn 2-A and Brain Research 1-B timed out twice under database
  pressure. They are classified from the summary report instead.

## The failures, reconstructed

There were 14 new failures (episodes) in 7 clusters:

| when (UTC) | what | the hours before |
|---|---|---|
| 09-23 10:38–13:59 | Airyn 2-B/C/D, Research A, 1-C, 1-D: three no-shows each | First no-show 1.6–2.2h before. **No Brain incident** in the 4h before. All shared one worker identity at the time. |
| 09-24 09:01 | Factory surface 1 | First no-show 1.2h before. No incident. |
| 09-29 09:38 | Factory surface 2 | 0.6h before. No incident. |
| 10-03 09:30 | Factory surface 3 | 0.5h before. No incident. Never recovered. |
| 10-11 17:03–22:14 | Airyn 2-B/C/D, Factory surface 3: wrong worker | Appeared the minute wrong-worker detection was deployed. The misconfiguration predated it (115+ fires per Routine with no arrival). It could not have been predicted with the telemetry that existed then. |
| 10-14 00:45–01:24 | Caleb 3-A, 3-D | First no-show 1.9h and 16.7h before. One arrival-path incident occurrence. |
| 10-15 01:53 | Caleb 3-A again | 0.2h before. Recovered by probe 5.4h later. |

Caleb 3-B and 3-C were quarantined on 10-11/10-12 with **one and two**
no-shows since their last arrival. See *a defect* below.

**Brain's own outages did not cause these quarantines.** Infra misses
(`DISPATCH_INFRA_NO_SHOW`) are separated correctly and are not counted toward
quarantine. Measured against these episodes, hour by hour per active Routine,
since 10-06:

| signal | precision | recall |
|---|---|---|
| ≥10 arrival-path incident occurrences in 4h | 8% | 31% |
| a process restart in 4h | 4% | 35% |

## Warning signs, scored against healthy periods

| sign | fired | followed by a quarantine within 24h | lead |
|---|---|---|---|
| first real no-show since the last arrival | 39 | 14 (36%) | 0.2–20h, median ≈1.6h |
| a sibling on the same connector fails | 14 | 10 (71%) | 0–0.6h |
| ≥2 fires, 0 arrivals in 6h (arrival era only) | 41 instant-hours | 23 (56%); catches 47% of failing hours | — |
| fleet infrastructure pressure / restarts | — | 4–8% | — |
| access-token `EXPIRED` refusals | fires ~90% of hours | uninformative: clients refresh routinely | — |

Notes on the table:
- The first real no-show precedes every no-show quarantine by construction,
  since the quarantine is the third one.
- When one Routine on a connector fails, its siblings fail with it. The
  failing unit is the account's connector or Claude Routine configuration,
  not one Routine.

**Conclusion: Brain can see a failure coming minutes to about two hours
ahead, not days.** No signal in the rows gives multi-hour warning with an
acceptable false-alarm rate. The causes are on Claude's side of the boundary:
a Routine selecting the wrong connector, or a Routine's sessions not reaching
Brain. Neither emits anything until a fire goes unanswered.

## A defect the reconstruction found

`unansweredFiresByRoutine` (the quarantine count) reset only on
`worker_sessions.observed_at`. That row is written once per credential, and
only when a bin is taken. A check-in that took nothing reset nothing. So did a
session whose credential a sibling Routine on the same connector had recorded
first. Caleb 3-B was quarantined as "3 consecutive" with four arrivals between
its no-shows. The count now also resets on the Routine's last
`DISPATCH_SESSION_ARRIVED` (`tests/dispatchDeferral.test.ts`).

## Recovery mechanisms

- Token refresh, the infrastructure-outage chaos matrix, probes and
  wrong-worker restoration: 95 tests, all passing, with fault injection in
  isolation.
- In production, the recovery probe lifted Caleb 3-A twice: 21.5h and 5.4h
  after failure.
- Airyn 2-A's quarantine lifted by itself on 10-15 04:01.
- What recovery cannot do: a Routine whose sessions never reach Brain
  (Caleb 3-B/3-C/3-D, Factory surface 3), or one that holds the wrong
  connector (Airyn 2-B/C/D). Every probe there settles `NO_MCP` or
  `AMBIGUOUS`. Only the account owner can change the Claude Routine.

## The check that came out of it

`connection-report` now prints an **EARLY WARNING** section per enabled
Routine:
- `FIRST_NO_SHOW` — a real no-show since the last arrival;
- `SIBLING_DOWN` — another Routine on the same connector is quarantined;
- `FEW_ARRIVALS` — at least 4 fires in 24h and fewer than half arrived.

Each is labelled with the precision measured here, and none claims more
lead time than about two hours.
