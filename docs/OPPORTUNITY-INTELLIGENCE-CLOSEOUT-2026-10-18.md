# Opportunity intelligence: closeout, 2026-10-18

The release is live as `SERVING_REVISION 0f9efa5` (PR #224, Deploy 481: hosted
verification passed). Every figure below was read inside the released container
through a workflow: Cash report #98, Closeout report #128 (`what=refinement`),
Dispatch diagnose #26 and Fleet #511. They are compared against
`docs/OPPORTUNITY-INTELLIGENCE-BASELINE-2026-10-18.md`, which was taken on
`36a2b70`.

This is a reading taken a few hours after release. It is not a measured
improvement. The 24-hour reading (scheduled task `trig_01EvpFB5SaVVTMUneK8UT7NB`,
2026-10-19 00:55Z) appends to this file.

## What shipped

| workstream | commit | what |
|---|---|---|
| A | cc02989 | blocker keys, standing, reopen conditions, the person's `reconsider` (migrations 118 / pg 109) |
| D | c5768f0 | claims from blocked fragments reused, stored `block_cause`/`block_host`, UNREADABLE ladder, host reachability, automatic surface recovery, lessons in prompts (119 / pg 110) |
| B | 84ec861 | change detection, fan-out, the derived reconsideration pass in the operate loop |
| C | a23584a, 88a8181 | dive epochs, stage-1 screen, `diveRoom`, `ACCOUNT_SESSIONS_UNPRODUCTIVE` |
| E | 0dd363e | standing on the Cash page, funnel and usefulness blocks in `cash-report` |
| F | 1292710 | the end-to-end reconsideration walk; sibling conditions retired |
| integration | c8b7c11, 0f9efa5 | test sweep no longer deletes Postgres clusters; standing pass throttled; `byPiece` rename after Deploy 480's gate caught a key collision |

Integrated `test:impacted`: SQLite 143 files / 3,418 tests, Postgres 145 files
/ 3,436 tests. Both pass.

## Readings against the baseline

| measure | baseline (36a2b70) | after (0f9efa5) |
|---|---|---|
| opportunities | 255 | 273 |
| QUALIFIED / READY_TO_TEST | 0 / 1 | 0 / 1 |
| eligible for a deep dive | 0 | 10 |
| dive capacity | fixed 2, 0 in flight | grant-derived; 6 of 6 grant slots held, 1 dive in flight |
| permanently spent (ROUNDS_SPENT) | 61, no way back | 61 EPOCH_SPENT, reopen on a real change |
| DISQUALIFIED / EXPIRED | 21 / 2, no way back | 21 / 2, reopen conditions recorded |
| standing events (`CASH_OPPORTUNITY_STANDING`) | none | 356 |
| reconsiderations triggered | impossible | 0 (no qualifying change yet) |
| fragments accepted, 7d | 163 / 1,177 (13.8%) | 179 / 1,243 (14.4%) |
| accepted claims inside blocked fragments | 709, unusable | 768, counted as evidence for coverage |
| requirements closed by the archive | not measured | 78 / 1,024 (7.6%) |
| block cause stored at block time | 0 | 6 (1,058 legacy, classified by report) |

The rise in the accept rate is inside normal weekly variation and is not
claimed as an effect.

## Capacity

- **Airyn.** Fires fell from about 23 per hour before the hand-back fix to about
  5.5 per hour between 03:57Z and 10:48Z (38 fires). Brain Research A fired 82
  times in the same window.
- **`ACCOUNT_SESSIONS_UNPRODUCTIVE`** has refused nothing yet. The account
  target is now that rule plus the work-ready gate. The temporary 2-concurrent
  / 12-per-hour containment was replaced. Airyn's account target was raised
  from 2 to 4 (Fleet #511).
- **Caleb.** 3-A is still on operator hold, and his account had 0 fires.

## Demonstrated live

- Standing is derived and recorded for every opportunity.
- Dive eligibility is no longer zero.
- Capacity is derived from the grant, not a constant.
- Blocked-fragment claims count toward coverage.
- Usefulness lessons reach prompts.
- Block causes are being stored.
- The unproductive-start rule replaced the fixed budget without producing a
  burst of fires.

## Not yet demonstrated live

- A reconsideration triggered by a real change.
- A stage-1 screen completing.
- Automatic recovery of a host-blocked fragment.
- An `ACCOUNT_SESSIONS_UNPRODUCTIVE` refusal.
- Any increase in QUALIFIED throughput.

Each waits on events that have not occurred in the hours since release. The
24-hour reading reports whichever have.

## Open owner decisions

- Whether cross-project reuse should extend beyond ACCEPTED fragments. It is
  unchanged at §31's boundary.
- Whether the stage-1 screen should count against an epoch's two full dives. It
  does not today.
- Releasing Caleb 3-A from operator hold.

## 24-hour reading, 2026-10-19 01:00Z

Read inside the released container (`SERVING_REVISION c299324`, which carries
this release plus later unrelated merges): Connection report #113 (`hours=24`,
attempt 2 — attempt 1 failed on a Fly API timeout before reading anything),
Cash report #101, Closeout report #129 (`what=refinement`), Dispatch diagnose
#27.

### Opportunity intelligence

| measure | baseline | +3h | +24h |
|---|---|---|---|
| opportunities | 255 | 273 | 309 |
| SIGNAL / CANDIDATE / QUALIFIED / READY_TO_TEST | 204 / 50 / 0 / 1 | 220 / 52 / 0 / 1 | 253 / 55 / 0 / 1 |
| eligible for a deep dive | 0 | 10 | 22 |
| dives in flight / room | 0 of fixed 2 | 1, grant full | 3, grant full (all 6 slots held or spoken for) |
| dives started (all time) | — | — | 243 |
| stage-1 screens run | 0 | 0 | 10 |
| openings stopped by a screen (no full dive spent) | — | — | 7 (`STAGE_ONE_FAILED`) |
| EPOCH_SPENT (was ROUNDS_SPENT) | 61 | 61 | 61 |
| reconsiderations triggered | impossible | 0 | 0 |
| standing events | 0 | 356 | 432 |
| fragments accepted, 7d | 13.8% (163/1,177) | 14.4% | 15.8% (196/1,244) |
| accepted claims inside blocked fragments | 709 | 768 | 864 |
| block cause read from the column / legacy | 0 / all | 6 / 1,058 | 122 / 926 |
| requirements closed by the archive | not measured | 78/1,024 (7.6%) | 81/1,094 (7.4%) |
| accepted completions per session, 7d | — | 0.326 | 0.385 (1,760 / 4,569) |

Proved live in 24h: the stage-1 screen (10 run, 7 openings stopped before a
full dive), eligibility (22 vs 0), the cause column (122 rows written at
block time).

Not proved: a reconsideration (0 triggered; no qualifying change was
recorded), an automatic host recovery, and any QUALIFIED throughput (still 0).
The accept-share rise is a week-on-week reading over overlapping windows and
is not claimed as an effect.

### Capacity, per account, 24h

| account | baseline (24h before 36a2b70) | 24h ending 01:00Z |
|---|---|---|
| Airyn | 558 fires, 389 arrived, 1 accepted completion, 845 releases | 80 arrived, 61 completions, 202 releases |
| Caleb | 106 fires, 32 arrived | 27 arrived, 32 completions |
| Brain Research A | 182 fires, 212 passes | 243 arrived, 341 completions |

- All four Airyn Routines have been on an **operator hold since about
  15:00Z 2026-10-18**, so Airyn's figures cover roughly 11 hours. The hold
  reason says the Routine environment has no outbound web access, with proxy
  `CONNECT 403` and DNS failures. This session neither placed nor lifted that
  hold. Airyn has to allow web access for that Routine environment before it
  is re-enabled.
- **Caleb.** 3-A is still on operator hold. 3-B and 3-C were quarantined at
  about 23:30Z for 3 sessions that never checked in, and auto-recovery reads
  RECOVERING. 3-D reads RECOVERY_EXHAUSTED, so the account owner must act.
- `ACCOUNT_SESSIONS_UNPRODUCTIVE` refusals: **0**. Research capacity is being
  limited by `ACCOUNT_TARGETS_REACHED` (112,651 deferrals) and by the grant,
  not by the new rule.
- Fleet settings were not changed. The halt of useful work is caused by the
  Routines' environments, which only their owners can fix; it is not a Brain
  regression.
