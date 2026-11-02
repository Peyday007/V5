# Factory autonomy, measured and corrected — 2026-11-02

Follows `docs/FACTORY-PERFORMANCE-2026-11-02.md` (branch
`claude/factory-performance-investigation-nb49ct`). Every figure here is from
GitHub runs, Factory rows or session records; where something was not measured
it says so.

## What still held, and what was corrected

| finding (prior report) | still true on 2026-11-02? | correction |
|---|---|---|
| Deploy goes red after a working release | Yes: 6 of 8 sampled red Deploys (41223245438 … 41416175495) released, then the verifier died opening its own connection (`EMAXCONNSESSION`, pool 15; storage HTTP 429 `too_many_connections`). The restart pass then failed on "no beacon". | `scripts/hostedOpen.ts`: bounded wait (15/30/60/120 s) on a "not now" refusal only. Verdict names `RELEASED, VERIFICATION COULD NOT RUN` vs `RELEASED, BEHAVIOUR DEFECTIVE`. Gate not loosened. (#417) |
| Fire waits dominate the critical path (31 min to start a plan, 41 min first integration, 2 h 07 m plan waits) | Yes: a fire nobody answered held its slot and blocked a re-fire for `IN_FLIGHT_WINDOW_MS` = 30 min; an abandoned intent revived after 2 h. | `NO_SHOW_WINDOW_MS` = 8 min for unanswered fires, used by both the in-flight count and the no-show reopen; revive after 20 min. (#417) |
| Integration is serial and slow | Partly. One integrator per campaign is a deliberate guarantee (only it moves the campaign branch) and it already batches every implemented unit. What made rounds slow: every unit bin and every round ran the full suite. | Intermediate rounds and unit bins run typecheck + `test:impacted`; the final round and the release gate run every contract command. (#417) |
| COMPLETE ≠ delivered (75 COMPLETE, 53 PRs open) | Yes: COMPLETE was set when the PR was opened, and nothing re-read the forge unless the campaign sat under a register workstream. | `delivery.ts` observes every finished campaign's PR (one list call per repository per 10 min): closed → CANCELLED, merged-not-running → BLOCKED "Dispatch Deploy", running → LIVE. `factory campaigns` prints the outcome and a tally. (#417) |
| Sessions poll `factory status` (41 of 60 runs) | Yes: nothing announced an end. | One `OBJECTIVE_FINISHED` record per terminal outcome (runIdempotent). `factory wait` is one run that ends with the objective; the session watches that run. (#417) |
| — (new) A new objective had to be merged and deployed before it could be submitted | Yes: `submit --file` read the image. ~27 min median per Deploy. | `submit/authorize-release --ref <branch>` read the file through the forge. (#417) |
| — (new) A review stage could wait for ever with every reviewer refused, silently | Yes. | The stage detail names the refusals and their reason. (#417) |

## The Factory's critical path now

submission (`--ref`, seconds) → approve → plan bin (fire, ≤ 8 min if the first
fire is a no-show) → units in parallel (one bin per ready unit) → integration
rounds (typecheck + impacted) → final round (full suite) → independent review →
delivery bin (PR) → release gate (LOW + grant: merge, Postgres suite, Deploy,
live verification) or the waiting session merges and deploys (MEDIUM/HIGH) →
`OBJECTIVE_FINISHED` → `factory wait` ends → one final message.

## Direct Claude Code baseline

53 of the owner's last 99 sessions map to a merged PR (session created → first
merge). With the 17 rows over 600 min removed (overnight idling):

| size | n | median | p90 |
|---|---|---|---|
| small (≤3 files) | 4 | 147 min | 387 min |
| medium (4–12) | 14 | 66 min | 251 min |
| large (>12) | 18 | 73 min | 242 min |
| all | 36 | 69 min | 305 min |

Caveats: timing starts at session creation (includes investigation and owner
reply time); merge only, not deploy; the small class has four rows.

## Benchmark: real objectives on the corrected Factory

_Filled in from the runs below._
