# Worker routing — which worker may be handed which bin

> One decision, `server/services/bins/routing.ts`, read in the three places that
> must agree: the candidate query, the admission hook and the fire router.

## Why it exists

Bin assignment was "the oldest ready bin among the projects this worker may
claim from". Project scoping was real and separated nothing, because **one
worker identity served every surface in the fleet and held membership on the
research project**. So a session started to implement a software repository
checked in and was handed a Step 12A research item, and a session started to
research could be handed a repository implementation bin. The ACC-14 trace is
what established it.

A scope that cannot distinguish its callers is not a scope.

## What it decides on

The authenticated **worker** — the one identity in the exchange the caller does
not supply. Not the Routine: Brain genuinely cannot tell which Routine has
arrived, because `worker_sessions` is keyed by a credential that is
per-connector rather than per-session (see CLAUDE.md §27). Not anything in a
request body. Not a tool list, which is not an access control.

`worker_routing` is one row per worker:

| column | meaning |
| --- | --- |
| `families` | the workload families this worker may be handed |
| `repositories` | `owner/name`, for repository work only |
| `capabilities` | checked only if the worker declares some |
| `reason`, `set_by` | why this scope, and who wrote it |

A row is **exhaustive**: the families on it are the only ones the worker may be
handed, so a worker registered for the factory is not also a research fallback.
A worker with **no row** serves what its authorization scopes imply —
`research:write` implies `RESEARCH` and `GENERAL`, anything else implies
`GENERAL` — and **never a repository family**. Deny-by-default is therefore the
resting state rather than a configuration somebody has to remember.

## The families

`RESEARCH`, `FACTORY`, `GENERAL`. The family of a bin comes from its **manifest
first and its label second**: a manifest carrying a `repository` block is
repository work whatever its `workload_class` says, because the manifest is the
work and the class is a label somebody wrote. Only `FACTORY` is a repository
family, so only it requires a repository match.

## The dimensions, all of which must hold

1. **Project** — the membership is active and carries `queue:claim`.
2. **Workload family** — the bin's family is one this worker serves.
3. **Repository** — for a repository family, the bin's manifest names a remote
   and `owner/name` is on the worker's list. A repository family bin whose
   manifest names nothing is refused (`REPOSITORY_NOT_NAMED`), never admitted as
   unscoped.
4. **Capabilities** — every capability the bin requires is declared, if the
   worker declared any at all.
5. **Authorization scope** — `services/identity/policy.ts`, unchanged.
6. **Independence lineage** — afterwards and unchanged:
   `services/research/auditEligibility.ts` and the factory's review floor.

The refusals are named (`PROJECT_OUT_OF_SCOPE`, `FAMILY_NOT_SERVED`,
`REPOSITORY_NOT_AUTHORIZED`, `REPOSITORY_NOT_NAMED`, `CAPABILITY_NOT_DECLARED`,
`SCOPE_MISSING`) because an operator reading "no capable surface" goes to look
at capabilities when the answer is a scope.

## Where it is enforced

- **`assignNextBin`'s candidate query** — the family clause is applied before
  the ordering, so a bin outside the caller's scope is not a candidate. A worker
  that serves nothing produces no query at all.
- **`binAdmission`** — the same decision again, as the `admit` hook `claimWork`
  and `assignNextBin` call *inside* the claim loop, ahead of the
  compare-and-swap. A refusal therefore costs no attempt, no lease and no
  generation: indistinguishable from losing the race.
- **`routeBin`** — the fire decision. A surface whose worker serves no matching
  family is refused `NO_SURFACE_SERVES_THIS_FAMILY`. A Routine bound to no
  worker is **eligible**: an unknown scope there can only waste a fire, and the
  half that could record something false is the claim, which fails closed.

Two enforcement points that agree are the requirement, not one: a guard on the
query alone hides a bin the hook would admit, and a guard on the hook alone
hands out a lease attempt for work the surface can never do.

They are allowed to disagree in exactly one direction. The query filters on
`workload_class`; the hook reads the manifest first. So the query may be **more**
permissive than the hook — an unlabelled bin whose manifest names a repository is
offered by the query and refused by the hook, which costs nothing because the
refusal is ahead of the compare-and-swap. The reverse would be the bug: a query
narrower than the hook makes a bin invisible to the very caller the hook would
admit, and nothing anywhere would say why.

## Onboarding a repository

Three things, and any one of them missing authorizes nothing:

1. a grant in `services/factory/repositoryEnvelope.ts` — in code, reviewed,
   because nobody supplies the limits their own work is judged against;
2. a `worker_routing` row naming that repository for the worker that will do it;
3. push access **where the worker runs** — Brain holds no repository credential
   and must never mint one.

The envelope is empty at rest. `V5` is deliberately absent: a campaign that
could rewrite the machinery executing it is the one whose failure mode is not
contained by declining a pull request.

## Operating it

```
# read it, including the workers with no explicit row
npm run admin -- routing show

# register a worker for repository work
npm run admin -- routing set <worker> --families FACTORY \
    --repositories owner/name --reason "why" --admin someone@example.com

# take a surface out of active dispatch: an explicit row listing no family
npm run admin -- routing retire <worker> --reason "why" --admin someone@example.com

# back to the derived default
npm run admin -- routing clear <worker> --admin someone@example.com
```

Retirement is a **scope, not a deletion**. The worker keeps its identity, its
credential digests, its memberships and every row it ever wrote, and becomes
unable to be handed work. That is what makes a retired surface still
attributable for the work it did.

The `Routing` workflow is the same four commands on the deployed Brain. It
reaches one area of `scripts/admin.ts` and no other, because a workflow that
could also create a project and approve a packet would be the operator console
again with a YAML file instead of a page (§26).
