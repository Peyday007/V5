# A hosted campaign against Brain's own repository

What this records: the Software Factory was pointed at `Peyday007/V5` — the
repository it runs in — and took an approved objective through a plan, two unit
stages, an integration, an independently-reviewed verdict and a repair, on the
hosted plane, with nobody watching. Every claim below resolves to a row, a
commit, a timestamp or a workflow run.

**It has not reached a pull request, and the reason is a defect in Brain rather
than in the work.** That is the more useful half of this document, so it is
written out in full: everything about the campaign was correct, every state
column read healthy, a fleet with idle capacity sat beside it, and the one bin
that was waiting could not be sent for by any path — not the dispatcher, and
not an operator either. The last section says plainly what is proven and what
is not.

---

## The surface, read from production

```
fleet show
  account Brain Research A  ENABLED  plan=Max  target=4
    Factory surface 1  ENABLED
      ref     trig_01JN1h6UdhvR3bMpWFvaRbD2
      worker  wkr_f8e118e87fd141689adc
      caps    [repository, repository-write]
      secret  BRAIN_ROUTINE_TOKEN_FACTORY   (present)
```

```
admin routing show
  worker-10  wkr_f8e118e87fd141689adc
    families=[FACTORY]  repositories=[peyday007/v5]
    capabilities=[repository,repository-write]
    set by factory-onboarding:usr_14439966398243339341
```

The `set by factory-onboarding:` prefix is what says this row came from
`onboardRepository` rather than from `admin routing set` — and that function
writes the routing row and the project's path boundary in one call,
deliberately, because two rows that must agree about one repository should not
be written by two people at two times.

**No forge credential.** The deployment carries 24 secrets and
`BRAIN_FORGE_TOKEN` is not one of them. `Peyday007/V5` is public, so `forge.ts`
reads it unauthenticated — which is the stronger form of §27's *"Brain holds no
credential for any repository"* rather than an exception to it.

**The permission grant is where the worker runs.** `.claude/settings.json` on
`production` pre-approves `mcp__factory-brain`, `mcp__factory-brain__*`,
`mcp__factory_brain` and `mcp__factory_brain__*`. Both separator spellings,
because which one a connector name produces is not worth guessing at fire time.
§22's split, unchanged: Brain owns dispatch, the surface owns whether a worker
may act.

## The change request

```
factory submit
  created   fcr_07a0e4e92abc4ec886f7
  base      58c6deccf11f41f41de845129cf1a44b78e72071 on production
  repository https://github.com/Peyday007/V5
  checkout  (none — so execution_mode is derived REMOTE)
  verification npm run typecheck, npm run lint, npm test, npm run build
```

`execution_mode` is derived and never chosen (§27): a contract pinned from a
checkout has a `repositoryRoot` and one pinned through the forge does not, so
the absence of a root *is* the statement that execution is remote.

## The objective

> Close the two gaps the work register leaves a person to fill by hand. First:
> when a campaign a workstream points at opens a pull request, nothing records
> that pull request against the workstream — a person has to notice it and link
> it, so the register says `PR_READY` only when somebody remembered, and says
> `IN_PROGRESS` about work that is actually waiting on a review. Second: the
> register cannot say `MERGED`, `DEPLOYED` or `VERIFIED_LIVE` about anything
> without a person typing an attestation, because Brain holds no forge
> credential and refuses to read a URL as a merge — which is right, and leaves
> the whole right-hand half of the owner's question "what actually shipped?"
> answerable only by hand.

## The stages, as bins

Every one of these is a bin Brain made, a fire Brain sent, a session that
arrived, and a result Brain validated against the forge rather than against
what the worker said about itself.

| bin | stage | state | fired at sessions |
|---|---|---|---|
| `bin_78cf47b5592b4ad5b405` | PLAN | COMPLETE gen 2 | `cse_01BSoDbYL7iYzRFx5nDRwzfU` |
| `bin_e3273471cf304e00af8d` | UNITS | COMPLETE gen 2 | `cse_01NGWBApXFErWGm5JGbLSaGy` |
| `bin_f62f17cecd694c138d49` | UNITS | COMPLETE gen 2 | `cse_01NuQfHMAKz2hUdSuGLKoAQi` |
| `bin_14d8b43d566f4565acb3` | INTEGRATE | COMPLETE gen 2 | — (taken by a session already present) |
| `bin_0d76003bac5b415cbd0a` | REVIEW | COMPLETE gen 3 | `cse_01FqMW8SXAd3fuG4RnW7vJ7j`, `cse_01VgrsAYk7u8uX6U2S5RRXXD` |
| `bin_2466314735054b9fa3bf` | UNITS (repair) | COMPLETE gen 3 | `cse_01V9GFMb5rcmQ6yp5qKXPWb9`, `cse_01Ave4RfVzuNqGdcAK1rU99s` |
| `bin_43915e4f93ca4e3db111` | INTEGRATE (repair) | see below | `cse_014Pf7msAWoGphbTKVGAExXs`, `cse_01AfxfG1J7ZxEmmsqoTnqjvG` |

Branches on the forge, each one a `git ls-remote` reading rather than a report:

```
4b63f5c430ffc862c9a1caa08638c982c5582a06  factory/campaign/fcp_189ea30c7ded4e7b9280
99d6933e01c3b9e05a6b19e2d1739b727eb5522d  factory/fcp_189ea30c7ded4e7b9280/pr-merge-observation/a1
d79c1c1972c0ce4a1fdeed8f7c0f266fce353411  factory/fcp_189ea30c7ded4e7b9280/writeback-pr-link/a1
95b87eaa12dd6340e593c465794f32a9fcbf6247  factory/fcp_189ea30c7ded4e7b9280/repair-late-link-never-attested/a1
```

## Review independence, refused in production rather than asserted

The review bin recorded this, and it is the whole of what the floor is for:

```
bin_0d76003bac5b415cbd0a  FACTORY_REVIEW
  refused  session_01NGWBApXFErWGm5JGbLSaGy x1 until 2026-09-21T13:21:56.045Z:
    Session session_01NGWBApXFErWGm5JGbLSaGy implemented part of this campaign,
    so its verdict on the same work is not an independent review. Nothing is
    recorded.
```

`cse_01NGWBApXFErWGm5JGbLSaGy` is the session Brain fired at
`bin_e3273471cf304e00af8d`, the units bin — the same suffix, which is what says
the session the worker reported and the session Brain's own `bin_dispatch` row
names are one session rather than two that agree. It came back for the review
and was refused **before the lease**, so it cost the bin no attempt, no lease
and no generation (§23). The review was then taken by
`cse_01VgrsAYk7u8uX6U2S5RRXXD`, which had implemented nothing.

## Where it got to, and the defect that stopped it

Read from production, `factory status --campaign fcp_189ea30c7ded4e7b9280`:

```
campaign fcp_189ea30c7ded4e7b9280 INTEGRATING — 1 unit(s) to bring together on 4b63f5c430ff
base 58c6deccf11f -> 4b63f5c430ff on factory/campaign/fcp_189ea30c7ded4e7b9280
units: 2/3 integrated, 0 ready, 0 leased, 0 failed
sessions 6, max observed concurrency 1 (MEASURED)
reviews 1, findings 1 (0 open, 0 repaired)
lane target 3 — initial
paid-API executions recorded: 0
  IMPLEMENTED  repair-late-link-never-attested (attempt 1/3)
        branch factory/…/repair-late-link-never-attested/a1 @ 95b87eaa12dd
  INTEGRATED   writeback-pr-link (attempt 1/3)
  INTEGRATED   pr-merge-observation (attempt 1/3)
```

Two of those lines are the thing this campaign was run to establish.
`max observed concurrency 1 (MEASURED)` is the reading that used to be
`0 (UNKNOWN)` on every hosted campaign, because every writer of
`factory_sessions` was on the local plane; it is derived from Brain's own
`bin_events` and `bin_dispatch` rows. And `paid-API executions recorded: 0`
held from the first stage to the last.

The campaign then stopped, and every row around it read healthy.

### `bin_43915e4f93ca4e3db111`

```
BIN bin_43915e4f93ca4e3db111  LEASED  gen 1
  attempts   1/2
  heartbeat  2026-09-21T14:47:18.445Z  expires 2026-09-21T15:07:18.445Z
  renewals   37  refusals 0

  DISPATCH
    gen 0  SENT  attempt 1/5  sent 14:32:41.085Z  session cse_014Pf7msAWoGphbTKVGAExXs
    gen 1  SENT  attempt 1/5  sent 15:07:45.726Z  session cse_01AfxfG1J7ZxEmmsqoTnqjvG

  EVENTS
    14:32:36  BIN_READY
    14:32:41  DISPATCH_SENT     cse_014Pf7msAWoGphbTKVGAExXs
    14:33:01  BIN_ASSIGNED      wkr_f8e118e87fd141689adc  session_01VgrsAYk7u8uX6U2S5RRXXD
    14:35:12 … 14:47:18  BIN_HEARTBEAT ×37
    15:07:36  DISPATCH_INTENT   PENDING
    15:07:46  DISPATCH_SENT     cse_01AfxfG1J7ZxEmmsqoTnqjvG
    (nothing, for nineteen hours)
```

Everything there is correct. A worker arrived twenty seconds after the fire,
worked for fourteen minutes, and its Cowork session ended — which is how a
Cowork activation ordinarily ends. The lease lapsed at 15:07:18 and the
dispatcher refired twenty-seven seconds later, exactly as it should. The
session it fired never checked in.

From that point the bin was unreachable, and by a route the intent table makes
unavoidable:

- `bin_dispatch` is `UNIQUE (bin_id, lease_generation)` and
  `ensureDispatchIntent` is `ON CONFLICT DO NOTHING`, so there is no second
  intent to be had at generation 1;
- `claimDispatchIntent` sees only `PENDING` and `SENDING`, so the `SENT` row is
  never claimed again;
- the generation advances only when a worker **takes a lease**, and nobody was
  coming to take one.

`reopenNoShowDispatches` exists for exactly this and could not see it, because
it asked `b.state = 'READY'`. This bin is `LEASED`.

### Why `READY` was the wrong word

§19's rule is that **an expired lease is claimable work**, and
`services/dispatch/loop.ts` says so directly above its own call to
`listDispatchableBins` — *"which is not the same set as READY. A bin whose
worker died is claimable the moment its lease runs out."* `DISPATCHABLE_SQL`
has always agreed: `state = 'READY' OR (state = 'LEASED' AND lease_expires_at
<= ?)`.

The constant that holds that sentence exists because it had already been
written as `state = 'READY'` four times, and its own comment predicted a fifth.
This was the fifth. The reason the constant did not prevent it is mechanical:
this read sits in a query that aliases `bins`, so a bare string beginning
`state =` cannot be dropped into one, and the author wrote the narrower
sentence by hand.

And the narrower sentence missed the **worse** half of the condition. A
session that never arrives leaves the bin `READY` — that is the case the
function was written for, and it is the rarer one. A session that *arrives*,
takes the lease and then ends mid-stage leaves the bin `LEASED` for ever after,
which is the ordinary shape of a Cowork activation.

The predicate is a function of the alias now and `DISPATCHABLE_SQL` is composed
from it, which is the only arrangement in which a sixth reader gets the
sentence for free.

Nothing downstream changes. The reopened intent goes back to `PENDING`; the
dispatcher's pre-fire re-read asks `isDispatchable` again before spending a
fire, so a bin somebody took in the meantime is refused there exactly as
before; and what the arriving worker does with an expired lease is
`assignNextBin`'s ordinary takeover — the generation advances, the attempt is
charged because the previous one genuinely did not finish, and a late
completion from the dead session matches nothing. The `max_attempts` ceiling
and the abandon-rather-than-skip branch are untouched.

Both new guards were run against their own defect before they were trusted.
Restoring `state = 'READY'` fails the reopen; reopening *any* `LEASED` bin —
dropping the `lease_expires_at` comparison — fails the one that says a live
lease is left alone.

### There was no operator transition either

Worth recording, because it is what makes this §24's own sentence rather than a
tuning defect. On the deployed code there is nothing an operator can do to this
bin. `factory answer-bin` answers a bin parked at `NEEDS_HUMAN`; this one is
`LEASED`. `regrantBinAttempts` raises an attempt ceiling, and the ceiling was
not what was stopping it — the bin still had an attempt in hand. `step10
cancel-bin` is scoped to the acceptance project and refuses a bin from anywhere
else. **A state that says waiting which nobody can resolve is not waiting; it
is stuck**, and this one had no answering transition at all.

## What is proven here, and what is not

**Proven, from production rows:**

- A campaign against `Peyday007/V5` was submitted through the forge, approved by
  a person, and executed entirely on the hosted plane with `execution_mode`
  derived rather than chosen.
- Five stages ran as bins Brain made, fired, and validated: a plan, two unit
  stages, an integration, and a review. Every unit result was confirmed against
  the repository's own account of itself — the branch at the commit reported —
  rather than against the worker's file list.
- The review produced a finding, the finding became a repair unit in the same
  campaign, and that unit was implemented and pushed
  (`…/repair-late-link-never-attested/a1 @ 95b87eaa12dd`).
- **Review independence was refused in production**, by recorded lineage, before
  the lease: the session that implemented a unit came back for the review bin
  and was turned away by name, at no cost to the bin.
- **`max observed concurrency 1 (MEASURED)`** on a hosted campaign, from
  `factory_sessions` rows derived out of `bin_events` and `bin_dispatch`. This
  reading was `0 (UNKNOWN)` on every hosted campaign before the sweep existed,
  because every writer of that table was on the local plane.
- **`paid-API executions recorded: 0`**, start to finish. The workers
  authenticated the way the session that launched them does, against the
  subscription already in place.
- Brain held no credential for the repository at any point. There is no
  `BRAIN_FORGE_TOKEN` among the deployment's secrets.

**Not proven, and not rounded up:**

- **The campaign has not reached a pull request.** It is `INTEGRATING` with one
  unit implemented and not yet brought together, stopped on the defect above.
  Nothing in this document should be read as saying the factory delivered.
- **The fix for that defect is not deployed.** It is committed on
  `claude/software-factory-progress-ir4qqz` with the full suite green on both
  backends, and until it is on `production` the campaign cannot move: there is
  no operator transition that reaches this bin. Once it is deployed, the
  dispatcher's own tick reopens the intent and fires — nobody has to do
  anything.
- Concurrency of **1** is what overlapped, not a ceiling. §27's rule holds: a
  ceiling nobody has observed reads `UNKNOWN`, and one session at a time is what
  this campaign actually ran.

## The gates

| gate | result | commit |
|---|---|---|
| `npm run typecheck` | clean | `6c9fcdb` |
| `npm test` (SQLite) | 208 files, 4414 tests passed, 1 skipped | `e23dd4a` |
| `Postgres suite` (CI) | success | `e23dd4a` |

