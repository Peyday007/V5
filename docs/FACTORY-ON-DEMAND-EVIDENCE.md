# On demand: a factory repository, onboarded and un-stranded

What this records: the Software Factory can now be pointed at a newly authorized
repository, be told nothing else, and **not lose the work while the setup is
missing**. Every claim below resolves to a row, a test, a commit or a timestamp,
and the one thing that is not proven here says so in the last section — because
it cannot be proven from inside Brain at all.

The proving ground is `Peyday007/brain-worker-bootstrap`, the one entry in
`services/factory/repositoryEnvelope.ts`. `V5` remains deliberately absent
(§27): a campaign that could rewrite the machinery executing it is the one whose
failure mode is not contained by declining a pull request.

---

## The defect this closes

A campaign submitted against a repository no worker was registered for did all
of the following, correctly, and ended unrecoverable:

1. planned a stage and made it `READY`;
2. was refused `NO_SURFACE_SERVES_THIS_FAMILY` by the fire router;
3. **counted that refusal as a failed attempt**, five times, and abandoned the
   intent — and an abandoned stage counts against the campaign's per-stage
   ceiling;
4. showed nothing anywhere about why, because the reason was a `DISPATCH_UNROUTED`
   ledger row and every state column read healthy;
5. would not have restarted even after the repository was onboarded, because the
   re-arm watched `fleet_routines` and onboarding writes `worker_routing`.

Four of those five are Brain deciding something permanent about work on the
strength of a condition a person could fix in a minute.

## The two refusal codes, and the action that answers each

| Refusal | What it means | The authorized action |
| --- | --- | --- |
| `NO_SURFACE_SERVES_THIS_FAMILY` | no enabled Routine resolves to a worker that may be handed this family | onboard the repository (registers the worker and its routing row), then bind a Routine to it |
| `NO_CAPABLE_SURFACE` | a surface serves the family but declares neither `repository` nor `repository-write` | register the Routine with `--capabilities repository,repository-write` |

Both are **deferred**. Everything else is unchanged and still exhausts:
`NO_ROUTINES_REGISTERED` and `ALL_SURFACES_INELIGIBLE` are fleet-wide facts
rather than this stage's, and the admission-level refusals —
`PROJECT_OUT_OF_SCOPE`, `REPOSITORY_NOT_AUTHORIZED`, `SCOPE_MISSING` — are
decisions rather than deferrals, taken ahead of the compare-and-swap so they
cost no attempt, no lease and no generation.

## What a deferred stage keeps

Asserted in `tests/factoryOnDemand.test.ts` and
`tests/factoryOnboarding.test.ts`, over three and four dispatch ticks
respectively:

- the intent stays `PENDING` with `lastErrorKind` naming the refusal;
- `attemptCount < maxAttempts` — the attempts a scope refusal never justified
  spending are still there;
- the bin stays `READY` with `workerId` and `leaseId` null, so **no lease has to
  be released** for a real worker to take it;
- the campaign carries `blockerKind = NO_HEALTHY_EXECUTION_SURFACE` with a
  sentence naming the remedy, and `state` stays `PLANNING`, because the campaign
  *is* planning and `BLOCKED` would throw away what happens when the surface
  arrives;
- the blocker clears on the tick after the condition stops holding — derived,
  never scheduled.

## What resumes, and what does not

`rearmSurfaceDeferredIntents` now watches `worker_routing` as well as
`fleet_routines`, and re-checks each candidate with **`routeBin` itself** before
putting it back. So the re-arm and the fire are one function and cannot disagree.

- registering a factory surface wakes factory work;
- a research packet nothing serves stays exactly where it was, with its
  day-long backoff and its own reason intact;
- an intent deferred for a reason onboarding does not answer — a rate limit — is
  not touched;
- no attempt is spent: a re-arm is not a retry;
- the re-arm stamps the intent, so a second re-arm in the same state returns 0.

**That paragraph originally continued "the repository is deliberately not one of
the dimensions the re-arm decides on", and it was wrong. The correction is
recorded rather than quietly applied.** The reasoning was §27's — Brain cannot
tell which surface has *arrived*, because `worker_sessions` is keyed by a
per-connector credential — and it is still true and was never about the fire.
Choosing which Routine to fire is Brain's own decision over rows Brain wrote:
`fleet_routines.worker_id` names the worker, and that worker's `worker_routing`
row names its repositories. There is no unknown there to fail open on.

The repository is therefore a dimension of both, and the re-arm inherits it for
free because the predicate *is* `routeBin`. See **Two repositories** below for
what leaving it out actually cost.

## Onboarding, as one action

`services/factory/onboard.ts`, reached at
`POST /api/projects/:projectId/factory/repositories/:grantId/onboard` behind
`requirePerson` and `decideProjectAccess` at `ADMIN` — the level a membership
grant already carries, and a level no worker principal reaches, by type.

It writes, from the grant and from constants and from nothing the caller sent:

- one worker per grant, `factory-<grantId>`, created or reused;
- a membership on this project carrying exactly `FACTORY_WORKER_SCOPES` — seven
  scopes, none of which can write anybody's research;
- an exhaustive `worker_routing` row: families `['FACTORY']`, repositories
  `[<owner/name>]`, capabilities `['repository', 'repository-write']`;
- exactly one live invitation, every earlier one revoked;
- one `ONBOARD_FACTORY_REPOSITORY` row in `identity_events` carrying the grant,
  the envelope id, the repository, the scopes, the families, the capabilities and
  the invitation **id**.

It issues **no credential**. A Cowork connector authenticates with OAuth, so what
it needs is not a secret to paste but a way for the consent screen to name one
worker: a single-use, expiring invitation that on its own cannot read anything,
call a tool or obtain a token. The token appears in the reply once and nothing
reads it back — asserted directly in `tests/factoryOnboarding.test.ts`.

And it **cannot register the surface**, which is §22's split rather than an
omission: the surface owns whether a worker may act, so Brain says precisely what
is missing and notices the moment it arrives.

| Readiness | Meaning | What is left |
| --- | --- | --- |
| `NOT_ONBOARDED` | no worker registered for this repository | one button |
| `AWAITING_SURFACE` | Brain's half is done | connect it in Claude, then register a Routine |
| `READY` | an enabled Routine is bound to that worker | nothing |

Beside them the card reports how much work is already waiting on this repository,
counted from rows. That number is what makes a setup task worth doing today, and
it carries the promise that distinguishes deferring from failing: the work
resumes by itself and nothing has to be submitted again.

## The rendered card found a defect no service test could

Pressing **Onboard** reloads the list. The reload counted as loading, and loading
unmounted the whole section — **taking the invitation shown once down with it.**
Every server test passed: the rows were written, the invitation was issued, the
reply carried the link, and the person would never have seen it.

Fixed by treating loading as a phase only while there is nothing to show, and
keying the section by project so a *change* of project still throws it away — an
invitation must never outlive the project it was issued for, on screen or
anywhere else. `tests/buildRepositories.test.tsx` renders the real component over
the real `FactoryApi` and pins it, along with: the three readinesses reading as
three situations; the remaining steps in order; the waiting-work sentence; one
press producing exactly one request; a second press while in flight producing
none; the invitation selectable rather than a link; a refusal shown as a refusal
with nothing issued; and no invitation anywhere on the page for a repository
nobody onboarded.

## The whole path, in one test

`tests/factoryOnDemand.test.ts` walks it once, with only the forge and the fire
endpoint stubbed:

1. an authorized objective is submitted and approved → a plan stage;
2. the fleet is healthy and wrong for the family → deferred, attempts intact, no
   lease, **zero fires**;
3. the campaign says `NO_HEALTHY_EXECUTION_SURFACE`, still `PLANNING`;
4. the Build projection says `NOT_ONBOARDED`, with the waiting count and the
   ordered steps;
5. onboarding runs; readiness becomes `AWAITING_SURFACE`; a Routine is bound and
   readiness becomes `READY`;
6. **the next ordinary `dispatchTick` re-arms and fires — nobody prompts
   anything** — the intent goes `SENT`, it is *the same intent at the same
   generation*, and the campaign's blocker clears;
7. the worker that arrives is handed that stage through the ordinary check-in.

A second scenario ticks three times against an in-flight fire and asserts
`fires === 1` and one intent: a duplicate tick, a restart mid-flight and two
instances are the same thing from here, and the intent's `UNIQUE (bin_id,
lease_generation)` with `ON CONFLICT DO NOTHING` is what makes them one fire.

## Durability, duplicates and revocation

| Scenario | Where | What holds |
| --- | --- | --- |
| Restart while deferred | `tests/factoryPersistence.test.ts` (two real processes, one data directory) | worker, routing, membership and readiness all survive; `AWAITING_SURFACE`, remaining still names the connector |
| Duplicate onboarding | same file, and `factoryOnboarding` | same worker, `createdIdentity: false`, one live invitation, the previous link now 400 |
| Partial setup | `factoryOnboarding` | four ticks change nothing: PENDING, attempts intact, `READY` bin, no lease, projection says which half is missing |
| Revocation | `factoryOnboarding` | routing cleared → admission refuses on the next request; the bin is untouched; the card returns to `NOT_ONBOARDED` |
| Archived identity | `factoryOnboarding` | onboarding refuses rather than quietly reviving it |
| Lost response | `factoryOnDemand`, `factoryOnboarding` | `ensureDispatchIntent` twice is one intent; a second re-arm in the same state is 0; three ticks are one fire |
| Permanent authorization refusal | `factoryPersistence` | an unauthenticated caller is refused outright; a person with **write** access gets the same 404 **and the same body** a missing project gives, while the administrator still sees the repository registered |

## Isolation, history and cost

- **Routing isolation is untouched and is what the re-arm now respects.** The
  onboarded worker's row is exhaustive: it is admitted its own repository, refused
  another with `REPOSITORY_NOT_AUTHORIZED`, and refused research with
  `FAMILY_NOT_SERVED`; a research worker is refused the factory bin.
- **Factory history is untouched.** Nothing here deletes, resets or rewrites a
  campaign, unit, bin, attempt, lease or ledger row. Every refusal keeps its
  reason.
- **$0 paid API.** Nothing added calls a model. Onboarding is rows; the deferral
  is rows; the re-arm is rows; the fire is the same subscription-backed Routine
  fire Step 10 measured.
- **`/operator` stays deleted.** Onboarding lives on Build, and
  `tests/operatorConsoleRemoved.test.ts` still passes — the guard here is
  *stronger* than the console's was, being `ADMIN` on the project rather than
  Brain-administrator-plus-same-site.
- **Canonical deployment.** Shipped from `production`, the branch
  `.github/CANONICAL_BRANCH` names, by the one `Deploy` workflow (§28).

## Two repositories, and the dimensions that keep them apart

A second authorized grant is what made three questions answerable, and all three
had wrong answers. `tests/factoryTwoRepositories.test.ts` is where they are now
held.

**Onboarding A registered a surface Brain would fire for B.** Two factory
surfaces in one family were interchangeable to the router, which chose between
them on headroom; the assigner then refused the wrong one with
`REPOSITORY_NOT_AUTHORIZED`, so nothing false was recorded — what was spent was an
activation, one of the bin's dispatch attempts, and the chance to try the surface
that could have done it. The refusal is now
`NO_SURFACE_SERVES_THIS_REPOSITORY`, it names the repository, and four dispatch
ticks against a wrongly-registered surface produce **zero fires**. With both
onboarded, each bin routes to its own Routine and the re-arm wakes only the one
whose surface arrived.

**Two conditions a person was on their way to fixing killed campaigns.**
`NO_ROUTINES_REGISTERED` and `ALL_SURFACES_INELIGIBLE` exhausted the bin's five
dispatch attempts and abandoned it — for an empty registry and a fully
quarantined fleet, whose documented remedies are `fleet register-routine` and
`fleet set-state`. Both are `OPERATOR` waits now. Six ticks against a quarantined
fleet leave the intent `PENDING` with its attempts intact, no lease held and zero
fires; lifting the quarantine fires it on the very next tick.

**And a fleet that was merely switched off said it had no routing row.** Every
candidate was refused on its own state before any scope question was asked, so
the flags those questions set stayed false and the first check after the loop
claimed the refusal. `ALL_SURFACES_INELIGIBLE` is checked first now and its
reason names `fleet set-state`.

The classification is a `Record` keyed by the refusal union rather than two sets
that had to be total between them and were not — a missing key is a compile
error — and it lives beside the union in `router.ts`, because
`rearmSurfaceDeferredIntents` reads the same table. That repository function used
to keep its own copy of the list; the moment the router grew a refusal the two
disagreed, and an intent deferred on a word the filter had never heard of waited
out a wall no operator write could shorten. It takes the kinds as a required
argument now and holds no list at all.

**What still refuses permanently, still does.** `decideRepository` refuses V5 in
four spellings and every unauthorized remote; onboarding refuses an unknown grant
without enumerating what it would have allowed; the admission hook refuses a
worker the other repository's bin ahead of the compare-and-swap, so the bin's
attempt count is still `0` afterwards. None of those produces a `RoutingRefusal`,
so none of them is reached by any of the deferral above.

## An onboarding whose response was lost

The write commits and the caller never learns what it said, so the invitation —
shown once — is gone and nothing in the rows says so. Recovery is to repeat it,
and what makes that safe is that onboarding is a repair rather than an
accumulation: the same worker, one membership, one routing row, one live
invitation, and **the invitation whose link was lost is revoked**, because a
token nobody read is still a token somebody could have. Three repeats spend no
dispatch attempt, create no second intent, and leave the readiness a person reads
identical each time.

## Verification

```
npx tsc --noEmit     clean
npm test             107 files, 2356 passed | 37 skipped, 0 failed      (SQLite)
npm test             107 files, 2381 passed | 12 skipped, 0 failed      (Postgres 16)
npx vite build       clean
```

on the reconciled tree, after Step 12A's workstream merged into `production`.

Against Postgres, with a local cluster initialised for it:

```
/usr/lib/postgresql/16/bin/initdb -D … -U brain --auth=trust
/usr/lib/postgresql/16/bin/pg_ctl -D … -o '-p 5433' start
BRAIN_TEST_DATABASE_URL='postgresql://brain@127.0.0.1:5433/braintest?sslmode=disable' npm test
```

Twenty-five tests that skip on SQLite run there, which is the point of the second
backend and the reason the totals differ.

**The Postgres run is recorded this time rather than reasoned about.** An earlier
version of this file said the backend was not reachable from here and argued the
changed SQL was portable by inspection. The inspection was correct and that is
not the point: §25's own lesson is that a repository layer over two databases is
true or merely compiling, and only one of the two can tell you which — the same
sentence written after `012_checkpoint_seq.sql`, after the three connect tables,
and after `workerSessionForBin` tiebroke on a column Postgres does not have.
Portable-looking SQL is not a substitute for execution.

There is no migration in this change.

## In production

Deployed from `production` by the one `Deploy` workflow, run **210**, commit
`d27683e`, finished **2026-09-12 09:57:51Z**. The canonical-branch guard passed
as its first job; typecheck, the suite and the build ran in the second; the third
deployed, proved the live Brain shut, spent the bootstrap secrets, restarted it
and proved it survived.

Read back from the deployed Brain at `northline-brain.fly.dev`:

| Check | Answer |
| --- | --- |
| `GET /healthz` | `ok` |
| `POST /api/projects/:id/factory/repositories/:grantId/onboard`, anonymous | `401` — no principal, so nothing to decide for |
| `GET /api/projects/:id/factory/repositories`, anonymous | `401` |
| `GET /operator` | `404`, still |
| Client bundle | `assets/index-DuEdhprq.js`, byte-identical hash to the local build of this commit |

And in that served bundle: `rs-factory-repositories`, *Onboard this repository*,
*Registered — waiting for a surface*, *resumes by itself*, *not a credential* and
the `/onboard` call each appear once, and the string `operator` appears **zero**
times.

What cannot be read from outside is anything behind a person's session, which is
every projection the card renders. Onboarding is an `ADMIN` decision made in a
browser, so the live half of it is the owner's — below.

---

## Proving the Routine runs as the worker it is bound to

**The first version of this check was too weak, and the correction is recorded
rather than quietly applied.** It read two things: `fleet_routines.worker_id`,
and whether an OAuth token had ever been minted for that worker and used. Both
are true facts and neither is the claim. The binding is an **operator's
assertion** — a row somebody wrote — and a token is held by a **connector**,
which is not a Routine. One Claude account can hold several connectors and
several Routines, and nothing about a minted, used token says which Routine has
the connector that holds it. So "registered for worker X" and "X authenticated
somewhere" can both be true of a Routine whose Cowork configuration actually
selects the *research* connector — which is exactly the mistake a second
connector *name* invites, and the one this command exists to catch.

What settles it is a chain of four links, every one a row Brain wrote itself:

| Link | The row | Why it cannot be faked |
|---|---|---|
| **Fired** | `bin_dispatch`, `routine_id` = this Routine, `sent_at` set | Brain chose the surface and sent the fire |
| **Arrived** | `worker_sessions`, written *from that dispatch row* at arrival | the worker id is Brain's attribution, never the worker's claim |
| **Assigned** | that session's `bin_id` | the bin the fire was for was handed to it |
| **Completed** | that bin reached `COMPLETE` | it did work Brain accepted, not merely authenticated |

`services/dispatch/surfaceProof.ts` is the decision, pure over rows it is handed
so it is replayable and testable, and `tests/factoryTwoRepositories.test.ts`
exercises all four outcomes: the closed chain, no arrivals at all, arrivals that
never completed anything, and — the fault this is for — **arrivals that
authenticated as a different worker**, which is reported as a fault rather than
as a missing proof and names the worker it actually was.

**The controlled fire is `verify-surface --probe`.** It creates one bounded
self-test bin: a `DETERMINISTIC_CHECK` asking for the sha-256 of a value carried
inside the bin, belonging to no campaign, with every repository operation in its
prohibited actions. It exists to be fired at, answered and finished, and nothing
reads its result but this command. Smoke-tested against a scratch Brain: the bin
is created with family `FACTORY`, the worker's own repository and the Routine's
capabilities, so it routes to that one surface and nowhere else.

`CONFIGURED` and `OBSERVED` stay two blocks that must not be confused, and a
perfect configured block over an empty observed one refuses rather than passing.

`bind-worker` takes the worker **name** as well as its id, because onboarding
names the worker and never shows the id — a runbook that has to say "find the id"
has a step somebody invents.

## The campaign that was created here, and why it was retired

A campaign was submitted and approved against the deployed Brain to exercise the
deferral end to end, and it did exactly that:

```
campaign fcp_bd1725a9b19b4688ac8e PLANNING — waiting for a plan
BLOCKER NO_HEALTHY_EXECUTION_SURFACE: FACTORY_PLAN bin bin_e6ae061e726e4918acbe
  is ready and no registered worker may be handed it
  (NO_SURFACE_SERVES_THIS_FAMILY). The work is fine; there is nobody to give it
  to.
units: 0/0 integrated, 0 ready, 0 leased, 0 failed
paid-API executions recorded: 0
```

Every property this work was for, in one production reading: `PLANNING` rather
than `BLOCKED`, the remedy in the blocker, the bin `READY` with no lease, nothing
spent, and a resume derived from the write that fixes it rather than scheduled.

**It has been retired, and the reason is the correction this section exists
for.** It targeted `brain-worker-bootstrap` — the *checkout* a Routine attaches,
not a target anybody asked for work in — against an objective I wrote rather than
one a person chose. Neither the repository nor the objective was a decision that
was mine to make, and a campaign that would start the moment a surface appeared
is not made acceptable by being currently dormant.

```
factory retire --campaign fcp_bd1725a9b19b4688ac8e
  retired bin_e6ae061e726e4918acbe FACTORY_PLAN (was READY)
  retired fcp_bd1725a9b19b4688ac8e: was PLANNING, now CANCELLED;
    1 bin(s) retired, 0 already terminal
```

`retire` is the supported transition and it destroys nothing: `CANCELLED` rather
than `FAILED` because the work did not fail — something stopped wanting it — and
the campaign's recorded reason, its change request, its pinned commit and its bin
all stay exactly as written. `objectives/bootstrap-settings-guard.json` is
removed from the repository for the same reason.

The fleet it was waiting on, read the same way (`fleet show`): four accounts, six
Routines, one eligible. `primary/V1` is the research surface — `caps=[]`, bound
to `wkr_1cdd82cf…`, the identity `friend-2/V2` also carries. The two `V1-oak`
Routines are `RETIRED` with *"oakwood factory proof complete surface out of
active dispatch"* and bound to no worker. **There is no factory surface**, which
is why the refusal above names the family rather than the repository.

## Oakwood was re-authorized here, and that was a mistake

`oakwood-site` was added back to the repository envelope during this work, on the
argument that the retirement's stated rationale — *"the factory's own executor
must not be whichever target it last proved itself on"* — was really about a
Routine's attached checkout rather than about the envelope, so removing the grant
had not fixed the thing it named.

The distinction is real and is now written down properly. **What did not follow
from it was authority to reverse the decision.** Oakwood's retirement is a
standing operator decision; an imprecise rationale is a reason to write the
rationale down better, never to widen what the rule allows.

It is removed. What was preserved throughout, and is untouched now:

* pull request #1, its four integrated units, its commits, its review and its one
  open MINOR finding;
* `docs/FACTORY-EXECUTION-PLANE-EVIDENCE.md` and the campaigns it records;
* the two `V1-oak` Routines, retired with their recorded reason.

The one change made to that repository during the mistake — a `.claude/settings.json`
pre-approving the factory connector — is reverted on `main` (`19dc7df`), because
a settings file for an unattended factory worker asserts that the repository is
about to have one.

**And the isolation properties it was re-added to demonstrate never needed it.**
What separates two repositories is a `worker_routing` row and the bin's own
manifest, both of which can be written for a repository the envelope refuses. The
tests use a fixture remote now and assert that the envelope refuses it, which is
strictly stronger: the same separation, proved without any production
authorization at all.

## Setup readiness is not a completed campaign

These are two claims and this document keeps them apart on purpose.

**Setup readiness** is everything above: the refusal classification, the
repository dimension on the fire router, the deferral and its derived re-arm, the
onboarding action and its rendered card, the correlated surface proof, and the
walkthrough. All of it is verified on both backends and deployed.

**A completed unattended campaign** is a different sentence and is **not
claimed**. Nothing has run: there is no factory surface yet, no authorized target
and no approved objective. When all three exist, what has to be shown is a
campaign carried by the permanent workers through implementation, integration,
independent review, repairs and a delivered pull request — across a Brain restart
— with no prompt from any session supplying the work. Until that has actually
happened, this document says only what it can.

## What is not proven, and cannot be from here

**A Routine bound to the factory worker.** Brain cannot create one, and that is
§22's split rather than a gap: a fire surface is a Routine in a Cowork account,
authenticated by a connector, with a per-Routine deployment token. A Brain that
could mint its own execution surfaces or choose their permissions is exactly what
that split forbids.

Everything on Brain's side of that line is done, including the two things that
used to be left to the operator's judgement: both repositories' checked-in
`.claude/settings.json` now pre-approve the factory connector's tool prefix, so a
fired worker does not halt at a permission prompt with nobody there; and the
walkthrough names every value rather than describing it.

The remaining steps are the owner's and are written out in full in
[`docs/workers/CONNECTING-THE-FACTORY-WORKER.md`](workers/CONNECTING-THE-FACTORY-WORKER.md)
— connector name and URL, the invitation-before-connect ordering, the Routine's
repository, branch, connector selection, paste-ready prompt and trigger, the Fly
secret's exact name, and the Fleet commands that register, bind, probe and verify
it.

**And two decisions after them that are also not automation gaps.** There is no
authorized target repository and no approved objective, so when those steps
finish the fleet is ready and idle. Naming a target is one reviewed entry in the
envelope; saying what should become true in it is an objective a person approves.
Until both exist, the correct state of this factory is a verified surface with
nothing to do — which is what it now has, rather than a campaign somebody's agent
invented for it.
