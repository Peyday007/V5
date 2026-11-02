# Factory performance, measured — 2026-11-02

All figures come from GitHub (pull requests, workflow runs, job steps) and from
production Factory operator output (`factory campaigns`, `status` and `events`
runs of `.github/workflows/factory.yml`, 2026-10-31 to 2026-11-01). Nothing here
is estimated. Where something could not be measured, this says so.

## Headline

Factory works for small, single-file changes and does not work for large
objectives. Almost everything that reached production in the last six weeks was
written by interactive Claude Code sessions, not by Factory.

| measure | value |
|---|---|
| PRs merged since 2026-09-22 | 292 |
| of those, Factory campaign PRs | 20 (7%) |
| Factory campaigns in production | 95 (75 COMPLETE, 10 BLOCKED, 9 CANCELLED, 1 local) |
| Factory campaign PRs ever opened | 73 |
| merged | 20 |
| still open, unmerged | 53 (median age 32 days) |

## 1. "COMPLETE" means a PR was opened, not that it shipped

`factory campaigns` reports 75 campaigns COMPLETE. 53 of their pull requests
are still open, median 32 days old. Most are the one-defect fixes queued
2026-09-30 to 2026-10-04 (#57–#117). The campaign list and Build therefore
overstate what Factory delivered by roughly 3×. Nothing in Factory notices a
PR that nobody merges, closes or rebases.

## 2. Small changes are fast; large objectives fail

Small LOW-risk changes, released automatically (§58): #159, #163, #178, #185,
#186 and #191 went from PR open to merged in 4–68 minutes.

Every large objective attempted since 2026-10-30 either blocked, was cancelled
or was finished by hand:

| campaign | objective | outcome |
|---|---|---|
| fcp_0d2f… | throughput overhaul | PR #361 open 15.3 h; merged by the owner with 2 of 6 acceptance conditions NOT_MET |
| fcp_3a8b… | goal engine | BLOCKED — UNIT_EXHAUSTED_ATTEMPTS (integration) |
| fcp_97a0… | work routing | BLOCKED — SCOPE_AMENDMENT_REQUIRED |
| fcp_e519… | search intelligence | BLOCKED — UNIT_EXHAUSTED_ATTEMPTS |
| fcp_8775… | large-scale data collection | BLOCKED — 3 units out of attempts |
| fcp_0b8d…, fcp_54203…, fcp_0ff5… | (repeats of the above) | CANCELLED |
| fcp_0157… | Magic Deck Lab | all 14 units integrated, then stuck in review; finished by hand in PR #399 and retired |

## 3. Where the hours go: integration is serial

Magic Deck Lab (fcp_0157…, 14 units) is the cleanest measured run:

| time (UTC) | state |
|---|---|
| 08:07 | plan bin created |
| 08:38 | architect starts — **31 min waiting for a fire** |
| 08:39 | plan installed (72 s of work) |
| 09:43 | 2/14 integrated |
| 10:45 | 7/14 |
| 12:50 | 10/14 |
| 13:51 | 11/14 |
| ≤16:56 | 14/14, REVIEWING, 0 reviews started |
| 19:16 | a session opens PR #399 by hand |
| 19:17 | campaign retired; the repair needed `magic.wizards.com`, which Factory workers cannot reach |

From the recorded sessions:

- **Implementation is quick:** 3 to 12 minutes per unit.
- **Integration is slow and serial:**
  - Each implemented unit gets its own FACTORY_INTEGRATE bin, and each bin
    merges and runs this repository's commands.
  - The first took 2,491 s (41 min); the later ones 3 to 7 minutes each.
  - Integrations ran one after another on one worker identity. Observed
    concurrency was 3 at most, against a lane target of 3.
- About 8 of the 11 hours from plan to "14/14" were integration queueing.
- At 11:23 a tick failed outright on pool exhaustion (8/8 connections in use).

The same shape appears on #361, whose plan stage alone waited 2 h 07 m.

## 4. The release gate is red far more often than releases fail

Deploy runs since 2026-10-15, most recent 100:

| conclusion | runs |
|---|---|
| success | 24 |
| failure | 65 |
| cancelled | 10 |

Failed jobs, sampled from 25 of those failures:

| failed job and step | runs |
|---|---|
| Deploy to Fly / post-restart verification ("Prove the live Brain is actually shut", "Prove it survived the restart", verdict) | 23 |
| full test suite | 1 |
| waiting for Postgres evidence | 1 |

So **23 of 25 failures happened after the image was already released**. The
gate goes red on a working release. That is the §27 pattern, still unresolved,
and every red run sends a session (or the owner) to investigate or re-dispatch.
Successful deploys take a median of 27 minutes (p90 47 minutes).

## 5. Sessions poll Factory instead of being told

The operator door was used as a watch loop:

- `factory status` was run every 4 minutes from 01:56 to 03:25 on 2026-10-31
  (23 runs).
- It was then run hourly on 2026-11-01 for fcp_0157 (9 runs).

That is 41 of the 60 most recent factory.yml runs. Each run is a pooler
connection against a database that was already exhausting its pool (finding
3). CLAUDE.md rule 4 asks for exactly the opposite. Factory has no
notification when a campaign changes state, so a session has nothing else to
watch.

## 6. CLAUDE.md is a tax on every worker

| date | size |
|---|---|
| 2026-09-01 | 56 KB |
| 2026-10-01 | 842 KB |
| now | 1.0 MB — 14,789 lines, about 250k tokens |

Every Factory worker that checks out this repository loads it, and so does
every session. Most of it is per-incident history, not rules.

## Not measured

- **Owner prompts per session.** The session transcripts from the first pass
  of this investigation were lost when the session restarted, and they were
  not re-read. Findings 4 and 5 are proxies for that burden, not a count of
  it.
- **Per-unit timing for #361.** Its event log was not re-read.

## What would move the numbers most (ranked by measured effect)

1. **Integrate in batches.** One integration bin per ready set rather than per
   unit, and verification once per batch. This is roughly 8 of 11 hours on the
   one fully measured large campaign.
2. **Make COMPLETE mean merged or closed.** Then the 53 stale PRs can be
   triaged: close the superseded ones, rebase the rest, and let §58 release the
   LOW-risk ones.
3. **Fix or quarantine the post-restart verification.** It produced 23 of 25
   sampled failures, and each one costs a person's attention.
4. **Push campaign state changes to the requesting session** (or Needs you)
   instead of having it poll `factory status`.
5. **Cut CLAUDE.md** back to rules, and move incident history to `docs/`.
6. **Declare external hosts in the objective up front.** Fail at planning, not
   after 14 units, when a repair needs a host Factory workers cannot reach.
