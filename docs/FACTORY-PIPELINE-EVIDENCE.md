# The Factory pipeline, run end to end

What was actually run on 2026-09-20, what it produced, and — the half that
matters — what is a reading and what is not.

---

## The run

A bounded objective against a **fixture repository**, with the real Claude Code
CLI as the executor. The fixture is a throwaway git repository holding one
module and one test, created for this run; it is deliberately not one of the
authorized targets, because a routing boundary needs a routing row and a
manifest and no grant at all, and a demonstration's convenience is never a
reason to widen a production authorization.

```
objective   Make formatAmount handle negative amounts and thousands separators,
            so a refund line and a large total both read correctly on a receipt.
contract    fcr_ede1366de14a4cdcba49
            pinned at ac500307b67a on main, verification `npm test`, both read
            from the repository rather than supplied
campaign    fcp_cc807f8219ce4dd0ace6
```

### What each tick did

```
PLANNING     a surface became available, and nothing is planned yet
EXECUTING    architect proposed 1 unit(s), 1 installed
             1 unit(s) planned, 0 ready
REVIEWING    dispatched 1, integrated 1
             format-amount-negative-and-thousands: Merged 1 commit(s), 2 file(s), +15/-1
VERIFYING    round 1: PASS, 0 finding(s), WORKER_SEPARATED
ASSEMBLING   final verification passed: npm test
COMPLETE     2 commit(s), 2 file(s), +15/-1 on factory/campaign/fcp_cc807f8219ce4dd0ace6
             writeback recorded

stopped after 6 tick(s) in COMPLETE
```

### The final state, from the rows

```
units:    1/1 integrated, 0 ready, 0 leased, 0 failed
sessions: 3, max observed concurrency 1 (MEASURED)
reviews:  1, findings 0 (0 open, 0 repaired)
paid-API executions recorded: 0
  INTEGRATED format-amount-negative-and-thousands (attempt 1/3)
    branch factory/fcp_cc807f8219ce4dd0ace6/format-amount-negative-and-thousands/a1 @ e0601f274935
```

### The diff a worker actually wrote

```diff
 export function formatAmount(cents) {
-  return `$${(cents / 100).toFixed(2)}`;
+  const negative = cents < 0;
+  const absCents = Math.abs(cents);
+  const dollars = Math.floor(absCents / 100);
+  const remainder = absCents % 100;
+  const dollarsWithSeparators = dollars.toLocaleString('en-US');
+  const centsPart = String(remainder).padStart(2, '0');
+  return `${negative ? '-' : ''}$${dollarsWithSeparators}.${centsPart}`;
 }
```

plus two tests beside it, in the same unit, inside its declared paths. Run on
the integration worktree: **3 passing, 0 failing.**

---

## What this establishes, and what it does not

**Established.** Plan, implement, verify, integrate, independently review and
assemble, driven by real workers on a real repository, with every claim read
from the repository rather than from a worker's summary: the branch is at the
commit reported, the files that moved are inside the unit's declared paths, and
the verification ran on the merged tree.

- **`paid-API executions recorded: 0`** is the spawn's own environment rather
  than a promise in a comment: `localCli.ts` removes every API-key variable from
  the child, so the surface authenticates the way the session that launched it
  does.
- **`WORKER_SEPARATED`** is the tier the recorded lineage supports and is not
  rounded up. The reviewer's worktree was **detached at the reviewed commit**
  and its tool allowance contains no writing tool, so "a reviewer cannot
  silently mutate reviewed work" is a property of the execution rather than a
  rule in a prompt.
- **`MEASURED`** concurrency of 1 is the true maximum overlap of real session
  intervals. A ceiling nobody observed would read UNKNOWN.

**Not established, and worth saying rather than glossing.**

- This is the **local plane**, not the hosted one. `execution_mode` is `LOCAL`,
  derived from the contract carrying a `repositoryRoot`. The remote plane —
  bins, a fired fleet, a worker with its own checkout — is proved separately in
  production and is not what ran here.
- It is a **fixture repository**, so nothing here says anything about access to
  an authorized target. That is the first real campaign's to prove, and
  reporting a green fixture as a green campaign would be the comfortable
  half-truth this repository refuses.
- One unit, one review round, no repair. The repair path did not run, so this
  run is no evidence about it.

---

## The defect it found

The first two attempts did not reach `COMPLETE`, and the reason is worth more
than the run.

`NO_HEALTHY_EXECUTION_SURFACE` is raised from two places — `planningStage` when
no free slot holds `ARCHITECT`, and execution when there is nothing to run a
planned unit on — and `unblockStage` resumed both into `EXECUTING`.

Right for the second, and wrong for the first. A campaign with nothing planned
walked `EXECUTING` → `INTEGRATING` → `REVIEWING` on an empty diff and stopped at

```
UNIT_EXHAUSTED_ATTEMPTS: Nothing was integrated, so there is no change to
review. A campaign with an empty diff has not produced software.
```

Every word of which is true, and the diagnosis is wrong: nothing was integrated
because nothing was ever **planned**, and an operator reading it goes looking at
attempts on units that do not exist. §27's own sentence — *a warning that cries
wolf is worse than no warning* — because it teaches a reader to stop believing
the one place that says a campaign is genuinely stuck.

It resumes into `PLANNING` when the campaign has no units, derived from the rows
rather than from a memory of which stage blocked. The regression test was run
against the unfixed branch to watch it fail (`expected 'EXECUTING' to be
'PLANNING'`) before it was trusted to pass, and the opposite direction is pinned
beside it — a campaign whose units are planned must not be sent back to
planning, because re-planning work that is half integrated is the same defect
wearing the other face.

---

## Reproducing it

```
npm run factory -- submit   --project <id> --file objective.json
npm run factory -- approve  --change-request <id> --user <admin>
npm run factory -- register --name architect-1 --capabilities ARCHITECT
npm run factory -- register --name impl-1      --capabilities IMPLEMENT,INTEGRATE
npm run factory -- register --name review-1    --capabilities REVIEW
npm run factory -- run      --campaign <id> --max-ticks 40
npm run factory -- status   --campaign <id>
```

The objective file needs `repositoryRoot` for a local pin and at least one
acceptance condition — the contract refuses without one, because a campaign
whose success is undefined cannot be judged.
