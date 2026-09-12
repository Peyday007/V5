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

The repository is deliberately **not** one of the dimensions the re-arm decides
on, because it is not one the fire decides on either. §27 settles the repository
at admission, where being wrong records something false; at the fire, being wrong
costs one activation. Fail closed where the unknown could record something false;
fail open where it could only waste a fire.

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

## Verification

```
npx tsc --noEmit          # clean
npm test                  # 2294 passed | 37 skipped, 0 failed
npx vite build            # clean
```

`BRAIN_TEST_DATABASE_URL` is not reachable from this environment, so the
Postgres run is not recorded here. The only SQL changed is
`rearmSurfaceDeferredIntents`, which became a `SELECT … WHERE … ORDER BY
created_at LIMIT ?` followed by a guarded single-row `UPDATE`: positional
parameters only, no `rowid`, no `DISTINCT`, and an `ORDER BY` on a real column —
so it is sayable in both dialects. Nothing else touches persistence, and there is
no migration.

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

## What is not proven, and cannot be from here

**A Routine bound to the factory worker.** Brain cannot create one, and that is
§22's split rather than a gap: a fire surface is a Routine in a Cowork account,
authenticated by a connector, with a per-Routine deployment token. A Brain that
could mint its own execution surfaces or choose their permissions is exactly what
that split forbids.

So the last mile is the owner's, and it is four steps:

1. **Build → Repositories → Onboard** `Peyday007/brain-worker-bootstrap`. Copy
   the invitation link; it is shown once.
2. In Claude, **add a second connector** to this Brain's `/mcp` endpoint and open
   the invitation link **first**, so the consent screen offers that worker and no
   other. A second connector is required rather than preferred: the MCP
   credential is per-connector, so reusing the research connector would make the
   factory worker and the research worker one identity again.
3. In Cowork, **create a Routine that uses that connector with the repository
   attached**, and put its fire token in the deployment secrets.
4. `fleet register-routine --account <name> --ref <trig_…> --secret <SECRET_NAME>
   --capabilities repository,repository-write`.

What it unlocks, with no further prompt: readiness becomes `READY`, the next tick
re-arms whatever is deferred for that repository, and the campaign runs the
existing plan → implement → integrate → review → repair path to a pull request
Brain will not merge.
