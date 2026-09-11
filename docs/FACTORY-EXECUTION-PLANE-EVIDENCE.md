# The hosted execution plane, as it actually ran

What this records: the Software Factory accepting and completing a software
objective **inside the deployed Brain**, with no checkout on that machine, no
local dispatcher, no active chat session carrying work between steps, and no
paid model API. Every line below resolves to a commit, a check run, a row or a
timestamp; where something is not proven it says so.

The target was `Peyday007/oakwood-junk-removal` pull request **#1** and the two
MINOR findings its previous review left open: the build shipped the repository's
own manifest to the public site, and `package.json` declared a Node floor that
continuous integration never exercised.

---

## What ran

Campaign `fcp_84a56713cb174607970d`, change request pinned at `1395af68b438`,
continuing pull request #1 on its existing branch
`factory/campaign/fcp_4b7d0487f2f342069687`.

| When (UTC) | What happened | Evidence |
| --- | --- | --- |
| 11:38:45 | Operator answered a stranded integrate bin: budget regranted 2/2 → 2/6, bin reopened, generation 4 → 5. Nothing reset. | `factory answer-bin` |
| 11:40:38 | The hourly Cowork Routine fired its worker. **No prompt from anybody.** | Routine `trig_01YJptt…` |
| 11:41:20 | That worker merged two unit branches and pushed. | `be9d5d112b15`, `d7e9ce418690` |
| — | Brain asked the forge, confirmed the branch and the files, moved the campaign head, and released the unit that depended on it. | campaign head `1395af68` → `d7e9ce41` |
| 12:27:26 | The dependent unit implemented and pushed. | `dba72935ea38` |
| 12:28 | The same session integrated it; Brain confirmed and advanced. | head → `dba72935` |
| 14:23:57, 14:54:48 | **Brain fired the review itself**, choosing the surface from the fleet. Sessions were created; none could be identified, so none was handed the bin, and the intent gave up out loud at 5/5. | `bin_dispatch` `ABANDONED` |
| 15:58:17 | Operator provisioned a fourth worker surface — the remedy the refusal itself names. | `session_01Wrxb…` |
| ~16:05 | Independent review: **PASS**, `SESSION_SEPARATED`, one MINOR finding. The reviewer ran the repository's own entry points and proved the guard was not vacuous by planting a file. | PR #1 body, "Independent review" |
| 16:09:32 | The finding became a repair unit and was implemented. | `8b2e6852921b` |
| 16:10:43 | Repair integrated. | `d054e565a941` |
| 16:12:02 | **Delivery updated pull request #1 — exactly once.** One `renamed` event on its timeline. | PR #1 timeline |

Final state: `COMPLETE — reviewed and confirmed by the forge`, 4/4 units
integrated at `d054e565a941`, 1 review, 1 finding now `REPAIRED`, and
**`paid-API executions recorded: 0`** at every reading.

The repository's own continuous integration is green on the delivered commit:
`Verify on Node 22`, `Verify on Node latest`, and `The run exercised the declared
range` — the check the repair itself added.

**Brain restarted seven times during this campaign.** Every deploy replaces the
Fly machine and then proves the Brain answers again; the campaign carried on
across all of them without losing a unit, a lease, a commit or an attempt,
because every stage is a row rather than a cursor.

---

## What running it found

Nine defects, each one invisible to reading and each one recorded in
`CLAUDE.md` §27 and `docs/FACTORY.md` rather than quietly fixed.

1. **An honest blocker is a result.** `headSha` was required of every report, so
   a worker blocked *before* pushing could not describe what happened. It said
   the right thing twice and its bin retired at `NEEDS_HUMAN`.
2. **A surface blocker is not a work blocker.** A `BLOCKED` integration charged
   every implemented unit an attempt whatever the cause. Derived from the rows
   now: no conflict and no non-zero exit code means nothing judged the tree.
3. **An acceptance is not idempotent by its own effect.** Returning a unit to
   `READY` is exactly the state the implementation ingest acts on, so a refused
   integration made the old report re-accept the unit: refuse, re-accept,
   integrate, refuse. Keyed on the bin now, both ways.
4. **A ceiling with no way out is a livelock.** Brain cannot tell which surface
   will arrive, so a hard stop counted in surface blocks is reached by the wrong
   surface first. It defers instead, and `FACTORY_STAGE_REAUTHORIZED` answers the
   far higher ceiling that remains.
5. **A timer is the wrong place to answer a question somebody is asking now.**
   The worker checked in again within the same minute, was told there was no
   work because the twenty-second tick had not run, and ended. An hour per stage
   for want of twenty seconds. `checkIn` derives once, scoped, then retries.
6. **A prohibition in a prompt is not a control.** A unit worker pushed to the
   campaign's integration branch, which its manifest forbids by name. Brain
   cannot prevent it — push access is granted where the worker runs — so it reads
   the branch and records `STALE_BASE_DETECTED`.
7. **An authentication failure is not backpressure.** Eighteen consecutive
   `AUTH 401` against one Routine ended every burst, so the healthy Routine
   beside it was never tried. `AUTH`, `NOT_FOUND` and `PAUSED` quarantine that
   surface and the burst continues.
8. **A fix deployed after the damage does not undo the damage.** Shortening a
   backoff left every intent already written behind a day-long wall.
   `rearmSurfaceDeferredIntents` derives the condition instead of scheduling it.
9. **A contract that lies about its own inputs refuses work and says nothing.**
   `session_ref` was documented as deciding nothing while review independence
   decided on it, so a worker that omitted it was refused every review with no
   row to say why. Brain knew which session it had fired the whole time.
10. **A rule applied by one of two runners is worse than none.**
    `reconcileRepairs` had one caller, the in-process orchestrator, so on this
    plane a repaired finding was never closed — and the pull request body said a
    limitation remained that its own head commit had fixed.

---

## What is not proven, and what is stale

- **The review earned `SESSION_SEPARATED`, not `WORKER_SEPARATED`,** and is
  reported at the tier its lineage supports. Every surface in this fleet
  authenticates with one connector credential, so Brain resolves them all to one
  worker identity. The earlier `WORKER_SEPARATED` review recorded on this pull
  request is untouched and still true of the round it describes.
- **The pull request body is one commit stale in one sentence.** Delivery
  composed it while the finding was `REPAIR_QUEUED`; the repair integrated
  moments earlier and the body still lists it under *remaining limitations*. The
  row is now `REPAIRED` and the defect that caused it is fixed, but the body was
  written once and has not been rewritten — updating it again would be a second
  update to a pull request the instruction said to update exactly once.
- **Each review round consumes a surface.** `implementingSessions` is
  campaign-wide, so a session that implemented anything at all cannot review any
  later round. That is the correct strict reading — the review judges the whole
  campaign — and it means an *n*-round campaign needs *n+1* surfaces.
- **`maxObservedConcurrency` reads `UNKNOWN`.** Nothing measured overlap here,
  and a ceiling nobody observed is never reported as one.

---

## The one external action

**Brain cannot fire a Routine that has the target repository attached.**
`BRAIN_ROUTINE_TOKEN` authorizes exactly one Routine —
`trig_01CBLu5oCZziEwznw5q9xU7g`, which has `Peyday007/V5` attached — so every
fire aimed at the oakwood-attached Routine returns
`AUTH 401 "Token is not authorized for this routine"`. That surface is now
quarantined with the reason on its row, which is correct and is not a fix.

Either of these, done once in the Claude web UI, closes it:

- attach `Peyday007/oakwood-junk-removal` to the **Brain Worker (dispatch)**
  Routine's sources, and declare `repository,repository-write` on it; or
- create a Routine there with that repository attached and the `cloud-brain`
  connector, and set its API token as a Fly deployment secret for a new fleet
  row.

Until then the pushing stages are reached by the Routines' own hourly schedule
rather than by Brain's dispatcher. That is unattended — no chat, no person, no
prompt transported — but it is hourly rather than immediate, and Brain choosing
the surface is the half that is currently blocked.

Brain must not mint its own worker or choose its permissions to get around this.
A worker identity that can act non-interactively is granted where the worker
runs; that is §22's rule and the reason Brain holds no repository credential.
