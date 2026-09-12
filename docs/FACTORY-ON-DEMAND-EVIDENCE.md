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
npm test             106 files, 2307 passed | 37 skipped, 0 failed      (SQLite)
npm test             106 files, 2332 passed | 12 skipped, 0 failed      (Postgres 16)
npx vite build       clean
```

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

## Proving the connector is the worker it is meant to be

A second connector *name* separates nothing. The MCP credential is issued **per
connector**, so a connector is one Brain worker identity however it is labelled —
and the trap is the converse: pointing an existing connector at a new Routine
hands it the old worker, and Brain's routing boundary, keyed on the authenticated
worker, then has nothing to separate.

So the check is not that a connector exists. It is that **a token was minted for
the intended worker and used**, which is a row. `npm run fleet -- verify-surface
--ref <trig_…>` reads it and prints two blocks that must not be confused:

* `CONFIGURED` — the rows an operator wrote: the Routine, its account, its
  capabilities, whether its secret is present in this deployment, the worker it
  is bound to, and that worker's families and repositories.
* `OBSERVED` — what has actually happened: OAuth tokens minted for that worker
  and how many were used, fires sent, and fires nobody answered.

A perfect `CONFIGURED` block over an empty `OBSERVED` one is a plan rather than a
proof, and the command **refuses** rather than passing — the same distinction
`evidence_class` draws, at an operator's command. Exercised here against a
scratch Brain: a Routine with no binding refuses naming that; bound to
`factory-oakwood-site` by name it prints `families [FACTORY]`, `repos
[peyday007/oakwood-junk-removal]` and still refuses, because no connector had
authenticated as that worker yet.

The refusal that matters most is *"the bound worker also serves [RESEARCH] — a
factory surface must not share an identity with research work"*. That is what a
reused connector looks like from Brain's side, and it is exactly what a second
connector name would have hidden.

`bind-worker` takes the worker **name** as well as its id, because onboarding
names the worker and never shows the id — a runbook that has to say "find the id"
has a step somebody invents.

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
repository, branch, connector selection and trigger, the Fly secret's exact name,
and the three Fleet commands that register, bind and verify it.

What it unlocks, with no further prompt: readiness becomes `READY`, the next tick
re-arms whatever is deferred for that repository, and the campaign runs the
existing plan → implement → integrate → review → repair path to a pull request
Brain will not merge.
