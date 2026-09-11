# Retiring Oakwood from active production, and isolating worker routing

> Oakwood/V1 was revived for one reason: the hosted Software Factory proof
> needed a real repository, and `Peyday007/oakwood-junk-removal` PR #1 was the
> declared target. That proof is complete
> (`docs/FACTORY-EXECUTION-PLANE-EVIDENCE.md`). **Nothing about it is deleted
> here.** The campaign rows, the commits, the pull request and the evidence
> document stay exactly as written. What is removed is Oakwood's place in the
> *active* execution architecture, and the defect that let one workload claim
> another's work.

## The defect, stated plainly

Bin assignment was "the oldest ready bin among the projects this worker may
claim from". Project scoping was real and separated nothing, because **one
worker identity served every surface in the fleet and held membership on the
research project**. The ACC-14 trace established the consequence: Oakwood /
Factory worker surfaces claimed Deal Dispatch Step 12A research and audit bins.

A scope that cannot distinguish its callers is not a scope.

## What the fix is

`server/services/bins/routing.ts` — one deterministic decision keyed on the
**authenticated worker**, read by the candidate query, the admission hook and
the fire router. Every dimension must match: project, workload family,
repository where the work names one, declared capabilities, authorization
scope, and then, afterwards and unchanged, independence lineage. An explicit
`worker_routing` row is exhaustive; a worker with no row serves what its scopes
imply and **never repository work**.

`docs/ROUTING.md` is the durable description. This file is what was found in
production and what was done to it.

## What was in production, as found (2026-09-11)

`fleet show`, before anything was changed:

```
FLEET
  accounts 4   routines 6   target 4   in flight 0

  primary  ENABLED
      V1      ENABLED      trig_01CBLu5oCZziEwznw5q9xU7g  worker=wkr_1cdd82cfb2a54faf8edd
              caps=[repository]  fires=260 refusals=1 no-shows=0
      V1-oak  RETIRED      trig_0137jBhBj9fwHCM13Aaf7DTN  worker=—
              caps=[repository,repository-write]  fires=0
      V1-oak  QUARANTINED  trig_01YJpttXm67Nft6gcUUnXQAS  worker=—
              caps=[repository,repository-write]  fires=21 refusals=21
  friend-2  ENABLED
      V2      QUARANTINED  trig_01HR74TmLtm8L21sh2Xryqhq  worker=wkr_1cdd82cfb2a54faf8edd
  verify-hosted-account-a / -b   MISSING SECRET, not routable
```

`admin workers list`:

```
  airynworker1                 ARCHIVED   0 project(s)
  airynworker2                 ACTIVE     4 project(s)
  calebworker1                 ACTIVE     3 project(s)
  deal-dispatch                ACTIVE     1 project(s)
  verification-worker          DISABLED   1 project(s)
  verification-worker-research DISABLED   1 project(s)
  verification-worker-research-audit-a ACTIVE 1 project(s)
  verification-worker-research-audit-b ACTIVE 1 project(s)
  verification-worker-rival    DISABLED   1 project(s)
```

`admin routing show`: **no worker had an explicit routing scope.** That is the
defect stated as a row: one worker, `airynworker2` / `wkr_1cdd82cfb2a54faf8edd`,
was bound to both the research Routine and the second account's Routine, held
membership on four projects including Deal Dispatch, and carried the
`repository` capability at the fire. Nothing anywhere said which workload it
was for, because there was nowhere to say it.

Cowork-side schedules, from the account's own Routine list:

```
  trig_01YJpttXm67Nft6gcUUnXQAS  "Brain factory worker (oakwood)"  40 * * * *  ENABLED
  trig_016bDA4rM4DxvTyZPczqazu6  "Brain factory worker"            23 * * * *  ENABLED
  trig_01CBLu5oCZziEwznw5q9xU7g  "Brain Worker (dispatch)"         (no cron)   ENABLED
  trig_017iVUtF8VyxGdkxdTFsu3de  "Brain worker"                    (no cron)   ENABLED
  trig_01HCVV7m2TfcteXKSRJXF3G3  "Step 9 Brain Queue Drain"        6 * * * *   disabled
```

Factory campaigns in Deal Dispatch:

```
  fcp_84a56713cb174607970d REMOTE COMPLETE #1  — the proof; reviewed and confirmed by the forge
  fcp_05bc1b50de0f460680ec REMOTE BLOCKED  #1  — 4 unit(s) out of attempts [UNIT_EXHAUSTED_ATTEMPTS]
```

`BLOCKED` is not terminal: a blocked campaign is re-examined on every tick, so
that second one was live Oakwood work in an Oakwood-free architecture.

## What was done

Every action below is a row or a schedule, not a deletion. The administrator the
writes are attributed to is `rosserpeyton@gmail.com`, resolved against the
database rather than trusted, and each routing write lands in
`identity_events` with both the previous and the new value.

### 1. The boundary itself

Deployed from canonical `production`. `worker_routing` is the new table
(migration `040` / pg `031`), and from the moment it shipped **no worker in this
Brain could be handed repository work at all**, because a worker with no
explicit row serves what its scopes imply and never a repository family. The
retirement below is therefore not what makes Oakwood unclaimable; it is what
makes the state say so.

### 2. Explicit routing rows

```
admin routing set airynworker2 --families RESEARCH,GENERAL --admin rosserpeyton@gmail.com
    "Deal Dispatch research, audit roles and Russell turns only; no repository work.
     ACC-14 showed one worker identity serving every surface, so Factory sessions
     claimed Step 12A research and audit bins."
  -> airynworker2 now serves [RESEARCH,GENERAL].

admin routing set calebworker1 --families RESEARCH,GENERAL --admin rosserpeyton@gmail.com
    "Research and Russell work only; no repository work. Registered explicitly so
     the boundary is a row rather than an implication."
```

**No worker in this Brain is registered for any repository.** The two
verification fixtures and the `deal-dispatch` site connector are deliberately
left derived: the connector holds no `queue:claim` at all, and a fixture that a
script creates and destroys should not carry an operator's row.

### 3. The Oakwood fleet surfaces

```
fleet set-state --kind routine --ref trig_0137jBhBj9fwHCM13Aaf7DTN --to RETIRED
fleet set-state --kind routine --ref trig_01YJpttXm67Nft6gcUUnXQAS --to RETIRED
    reason: oakwood factory proof complete, surface out of active dispatch
```

The second had been QUARANTINED by the first-`AUTH`-quarantines rule after 21
refusals in 21 fires. Quarantine is a health state a surface can come back
from; `RETIRED` is the operator saying it should not.

### 4. The `repository` capability on the research surface

```
fleet set-capabilities --ref trig_01CBLu5oCZziEwznw5q9xU7g --capabilities ""
    reason: the research surface is not a repository surface
```

`V1` is the Routine Brain actually fires, and it carried `[repository]` so that
Oakwood factory bins would route to it. With the capability gone it cannot be
chosen for repository work at the fire either — which is belt and braces, since
the router already refuses it `NO_SURFACE_SERVES_THIS_FAMILY` on its worker's
scope.

### 5. The one non-terminal Oakwood campaign

```
factory retire --campaign fcp_05bc1b50de0f460680ec
    reason: oakwood proof complete, campaign retired from active dispatch
  -> retired fcp_05bc1b50de0f460680ec: was BLOCKED, now CANCELLED;
     0 bin(s) retired, 10 already terminal
```

`CANCELLED` rather than `FAILED`, for §24's reason: the campaign's own recorded
blocker stands untouched, and what changed is that the thing which asked the
question stopped wanting the answer. All ten of its bins were already terminal,
so nothing claimable was taken away from anybody — and `retireBin` was there for
the case where something had been, advancing the fencing generation so a late
completion from a previous owner matches nothing.

`fcp_84a56713cb174607970d` is **untouched and still COMPLETE**. The PR, the
commits, the review, the finding, the repair and the evidence document are
exactly as the proof left them.

### 6. The hourly schedules

Disabled on the Cowork side, where they live:

```
  trig_01YJpttXm67Nft6gcUUnXQAS  "Brain factory worker (oakwood) — retired, proof complete"   40 * * * *  disabled
  trig_016bDA4rM4DxvTyZPczqazu6  "Brain factory worker (hourly) — retired, Brain fires on demand"  23 * * * *  disabled
```

The first was Oakwood's. The second was the generic Factory hourly rescue, and
it goes for the same reason: **a timer is the wrong answer to a question
somebody is asking right now.** What is left is
`trig_01CBLu5oCZziEwznw5q9xU7g`, which has no cron at all — Brain fires it when
a bin becomes `READY`.

## What the fleet looks like now

```
  primary  ENABLED
      V1      ENABLED  trig_01CBLu5oCZziEwznw5q9xU7g  worker=wkr_1cdd82cfb2a54faf8edd  caps=[]
      V1-oak  RETIRED  trig_0137jBhBj9fwHCM13Aaf7DTN  worker=—
      V1-oak  RETIRED  trig_01YJpttXm67Nft6gcUUnXQAS  worker=—
  friend-2  ENABLED
      V2      QUARANTINED  trig_01HR74TmLtm8L21sh2Xryqhq   (its own account's token; see below)
  verify-hosted-account-a / -b   not routable
```

**No dispatchable Oakwood surface remains.** The one ENABLED routable surface is
`V1`, it carries no repository capability, and its worker is registered for
`RESEARCH` and `GENERAL` only.

## The Software Factory is preserved, and dormant

Item 10 of the correction asks that the completed hosted Factory stay available
for future explicitly authorized repositories, and that onboarding one create
isolated authorization rather than reusing Oakwood as a permanent executor. That
is now structural rather than a promise:

- `REPOSITORY_GRANTS` in `services/factory/repositoryEnvelope.ts` is `[]`. No
  campaign can be created against any repository, Oakwood included.
- **No worker is registered for any repository.** Even with a grant, nothing
  could claim the work.
- `V5` stays deliberately absent from the envelope: a campaign that could
  rewrite the machinery executing it is the one whose failure mode is not
  contained by declining a pull request.

Onboarding a repository is therefore three deliberate acts — a reviewed envelope
grant, a `worker_routing` row, and push access where that worker runs — and any
one of them missing authorizes nothing. Oakwood is not the executor of any of
them.

## What is not Oakwood, and is left alone

- **`friend-2` / `V2` is QUARANTINED** on repeated `AUTH 401` against its own
  account's deployment secret. That is a fact about that surface's credential,
  not about Oakwood, and the remedy is the owner's: correct the secret, then
  `fleet set-state --to ENABLED`. Nothing here touched it, and nothing here
  depends on it.
- **`trig_017iVUtF8VyxGdkxdTFsu3de`** is a leftover fire-only Cowork Routine
  registered in no account row. It has no schedule, so it fires only if somebody
  fires it, and it is not Oakwood's.
- **The verification fixtures** (`verify-hosted-account-a` / `-b`) are not
  routable: their secret is deliberately never set. A script creates and
  destroys them, so they keep no operator's routing row.

## Audit independence, stated at the tier it earned

Item 9 asks for enough distinct correctly-scoped worker identities to run
PRIMARY, ADVERSARIAL and JUDGE independently, without borrowing a worker from
another project.

The floor is **three distinct authenticated sessions**, one per role, with no
session holding two roles on one orchestration — `auditEligibility.ts`, as a
constant, because a caller that could choose the level could lower it. §23
records why that is the property rather than a count of accounts or Routines: the
threat an independent audit defeats is one model context reviewing its own work,
and making a subscription's availability a completion dependency made a finished
product unfinished whenever a particular account was down.

`V1` is registered `persist_session: false`, so every fire is a new session, and
the floor is reachable on one healthy Routine. The worker behind it is a member
of Deal Dispatch in its own right; nothing is borrowed. The achieved tier is
reported as what the lineage supports and never rounded up — currently
`SESSION_SEPARATED`, because both registered Routines resolve to one worker
identity.

Raising that to `WORKER_SEPARATED` or `ACCOUNT_SEPARATED` needs a second worker
bound to a second healthy Routine. That is an owner action on a Cowork account,
not a change to this repository, and it raises the reported tier with no code
change and no deployment. It is an optional stronger assurance tier, not a
completion dependency.

## Step 12A still reads what it read before

`step12a:acceptance`, run from production rows after every change above
(run 34647197229, 2026-09-11 21:01Z):

```
  A11_INDEPENDENT_AUDIT PASS
  ...
  STEP 12A — composed: 19/21 PASS · 0 FAIL · 0 BLOCKED · 2 NOT_RUN · 1 DEFERRED (of 22 gates)
```

**Zero FAIL and zero BLOCKED**: the boundary refuses crossings without refusing
the product. `A11_INDEPENDENT_AUDIT` is the derived, fail-closed gate — three
completed audit passes, three session references each resolving to a real
credential of the worker that presented it, those three distinct, no predicted
`future:` session, a judge stamped after both arguments, and a filed document
with bytes — and it passes after the change. The two `NOT_RUN` gates
(`A13_AUTO_NEXT`, `A19_DELIVERY`) are the pre-existing position §24 explains:
a follow-on exists only for a packet that filed short, and filing short is a
decision the domain reserves to a person. Nothing here closed or changed them.

## How to read a refusal, later

When a bin is sitting `READY` and nobody is taking it, the question is which
dimension refused it, and two read-only commands answer it from production rows:

```
admin routing check <worker> <bin>     # would this worker be handed it, and why not
fleet explain-route <bin>              # which surface Brain would fire, and what it refused
```

`routing check` calls the same `workerRoutingFor` the admission hook calls, so it
cannot describe a scope the claim would not apply. Neither writes anything, and
neither authenticates anything: a real claim is still decided inside the claim
loop at the moment it is made.

## The checks

- **SQLite suite**: 2143 passed, 37 skipped, 98 files (1 skipped).
- **Postgres suite**: the same suite against the other backend,
  run 34646667102 — `completed success`. `040_worker_routing.sql` and its
  Postgres twin `031_worker_routing.sql` both apply, and `worker_routing`
  carries the `seq` identity column every cursor-ordered query needs.
- **Both boot paths**: a fresh database applied every migration and answered
  `healthz`; an existing database migrated forward and answered after a
  restart. `Deploy` does the second one for real on every release — it removes
  a secret, which restarts the machine, and then re-runs the hosted
  verification against what came back.
- **Deployed only from canonical `production`**, through `Deploy`, with the
  first job refusing any other ref and the `production` environment's branch
  policy refusing one the workflow guard would miss.
- **Paid API executions recorded: 0.** Nothing here added a provider, a key or a
  spend path; the deployed Brain still has no `ANTHROPIC_API_KEY` and no
  `BRAIN_PROVIDER`.

## The decision matrix, rehearsed before it was taken

`admin routing check`, over two workers and two bins, so the boundary is shown in
both directions rather than only in the direction that refuses:

| worker serves | bin | decision |
| --- | --- | --- |
| `RESEARCH,GENERAL` | a Step 12A research packet | **WOULD BE HANDED IT** |
| `RESEARCH,GENERAL` | a factory unit bin naming Oakwood | `FAMILY_NOT_SERVED` |
| `FACTORY` for `peyday007/oakwood-junk-removal` | the same research packet | `FAMILY_NOT_SERVED` |
| `FACTORY` for `peyday007/oakwood-junk-removal` | the factory unit bin | **WOULD BE HANDED IT** |

Each refusal names the dimension and says the list is exhaustive. The fourth row
is what makes the second and third rows meaningful: the boundary refuses
crossings, not work.
