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
