# The Software Factory as a service, through Russell

What a person does, what Brain does, and what each step is proved by. The
canonical rules are CLAUDE.md §27 (the factory) and §50 (this path); this file
is the journey.

## The journey

| # | Who | What happens | Where it is recorded |
|---|-----|--------------|----------------------|
| 1 | Person | Says what should change, in a Russell conversation attached to the project (for Brain itself: **Brain Architecture**). | `russell_messages` |
| 2 | Brain | A fleet worker reads the turn and proposes `REQUEST_SOFTWARE_CHANGE` with a title, objective, expected outcome, proposed acceptance conditions and, when the change is visible on Brain's own pages, a live check. The deterministic gate reads the person's own words; the target resolver refuses rather than guesses when the message names a different project or excludes the attached one. | `russell_software_requests` (`PROPOSED`), with `acceptance_conditions` and `live_check` |
| 3 | Person | Reads the card **in the same conversation**: objective, "Done means" (editable), the live check, the repository and the exact scope the project was given. Presses **Authorize** or **Not this**. | the contract (`factory_change_requests`) holds exactly the conditions on screen |
| 4 | Brain + fleet | The one starter (`approveAndStartCampaign`) builds the hosted campaign; bins are fired at the Routines registered for that repository; plan → implement → integrate (repository's own commands on the merged tree) → independent review → repair → pull request. | factory tables, `bin_events` |
| 5 | Brain | Every stage, blocker (with its remedy), resumption and the pull request becoming ready is written into the conversation as a **Brain** message, once each. | `software_delivery_milestones` + `russell_messages` (role `SYSTEM`) |
| 6 | Person | The release card shows exactly what merging would release: the pull request, base ← head, the head commit and whether it is the commit Brain integrated and had reviewed, every file with its line counts, the review verdict and independence tier, open findings, the repository's checks, and the conditions it was built to. **Merging the pull request is the release**, on GitHub, by the person — Brain does not merge (§27). **Refuse this release** records a refusal and stops Brain following it. | milestone `RELEASE_READY`, `RELEASE_REFUSED` (actor `PERSON`) |
| 7 | Brain | Observes the merge through the forge (`merged`, merge commit). For any repository other than Brain itself it says the deployment is outside what it can observe and stops. | milestone `MERGED`, `DEPLOY_UNOBSERVABLE` |
| 8 | Operator | For Brain itself: the merge lands on `production` and a `Deploy` of `production` releases it (§28 — only the canonical branch deploys, and never from a checkout behind it). | the Deploy run |
| 9 | Brain | The new process compares its own `BRAIN_REVISION` against the merge commit through the forge. When the revision contains it, Brain reports it is serving it, reads the checks on that revision, and runs the live check — a GET against itself, following same-origin scripts and styles — and reports the result in the conversation. | milestones `DEPLOYED`, `LIVE_VERIFIED` / `LIVE_CHECK_FAILED` / `RELEASED` |

The person's closed browser, a closed conversation and a restarted Brain change
nothing: every step is read from rows on the Russell tick, each milestone is
unique by `(request_id, milestone_key)`, and a milestone whose message a crashed
tick never wrote is finished by a later tick.

## What only a person can do, and why

- **Authorize** — it spends the fleet, and what success is is theirs, not a
  model's (§27: a factory grading its own exam).
- **Release** — merging to a protected branch is a person's act on the forge.
  The factory may open a pull request and may never merge one.
- **Onboard a repository for a project** — which project may change which code
  and inside which directories is a boundary with no default (§27), decided on
  Build → Repositories.

## What Brain will not claim

- A merge in a repository it does not run from is reported as a merge; its
  deployment is not observed and not guessed.
- The acceptance conditions are verified on the integrated tree by the
  repository's checks and the independent review before release. After release
  Brain checks the one live behaviour the card named, not every condition again.
- No live check declared means Brain confirms the deployment and claims nothing
  further about behaviour.

## Evidence

Fixture proofs, labelled as such: `tests/softwareDelivery.test.ts` (the ledger,
the stages, the release card, refusal, merge, deploy by revision, the live
check, the crash window), `tests/softwareThreadCard.test.tsx` (the card in a
browser), both on SQLite and Postgres. The live journey is recorded in
`docs/SOFTWARE-SERVICE-EVIDENCE.md` as it happens, with every claim resolving to
a row, a run or a commit.
