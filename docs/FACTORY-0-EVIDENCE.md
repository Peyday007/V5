# Software Factory 0 — what was built, what was proven, and what was not

A record of the first generation of the Software Factory: which parts were
written by hand, which the factory wrote for itself, what running it actually
found, and where it stops and waits for a person.

Read `docs/FACTORY.md` for how the factory works. This file is only evidence.

---

## 1. The split: bootstrapped by hand, versus built by the factory

The assignment's rule is that the factory may not be credited with work the
outer session did. So:

### Bootstrapped by hand (the seed kernel)

| Component | File |
| --- | --- |
| The contract, its immutability and its amendment ledger | `server/services/factory/contract.ts` |
| Schema: contract, campaign, units, graph, fleet, judgement, ledger | `server/db/migrations/035_software_factory.sql` (+ the generated Postgres twin) |
| The campaign and unit state machine, and the claim | `server/repos/factory.ts` |
| Workers, sessions, reviews, findings, artifacts, releases, the ledger | `server/repos/factoryFleet.ts` |
| Plan validation and installation | `server/services/factory/planner.ts` |
| The architect pass | `server/services/factory/architect.ts` |
| The worker registry and capacity | `server/services/factory/registry.ts` |
| The scheduler and its adaptive tuner | `server/services/factory/scheduler.ts` |
| Worktrees, diffs, merges | `server/services/factory/git.ts` |
| Running one unit on one worker | `server/services/factory/dispatch.ts` |
| Executors (local CLI, Cowork) | `server/services/factory/executors/` |
| The integrator | `server/services/factory/integrate.ts` |
| Independent review | `server/services/factory/review.ts` |
| The repair loop | `server/services/factory/repair.ts` |
| Metrics from the ledger | `server/services/factory/metrics.ts` |
| Assignment compilation | `server/services/factory/prompts.ts` |
| The reviewable artifact | `server/services/factory/assemble.ts` |
| The tick | `server/services/factory/loop.ts` |
| HTTP surface | `server/routes/factory.ts` |
| Operator tool, acceptance reporter, verifier | `scripts/factory.ts`, `scripts/factory-acceptance.ts`, `scripts/factory-verify.ts` |
| Seed tests | `tests/factory.test.ts`, `tests/factoryHttp.test.ts` |

Review and repair are in the seed rather than in the bootstrap campaign, and
that is a deliberate departure from the assignment's suggested split: the seed
cannot run a *complete* journey without them, and a campaign that could not be
reviewed could not produce the evidence the rest of this file is about.

### Built by the factory, in the bootstrap campaign

Planned by an architect worker, implemented by implementation workers in their
own worktrees, integrated by the factory, reviewed by a different session, and
repaired where the review found something.

_(Filled in from rows at the end of the campaign — see §3.)_

---

## 2. Defects running it found, which reading it had not

Every one of these was found by running the thing, and each is fixed forward
with the reason recorded rather than quietly patched.

1. **A glob owning a tree did not own its own directory.**
   `server/services/factory/**` did not match `server/services/factory`, so a
   unit owning a subtree would have had its own directory's diff rejected.
   Found by `tests/factory.test.ts`.

2. **`**` was read as "everything", including outside the repository.** A
   mutation scope of `**` accepted `../elsewhere/**` as a *narrowing*. A path
   that climbs or is absolute is now outside every scope, including that one.

3. **A worker log over the inline limit was stored as a hash, a byte count, and
   content nowhere.** A row that says evidence existed and cannot produce it.
   The tail is now kept with a marker naming what was dropped.

4. **A worker's reply was truncated at 8,000 characters**, which is shorter than
   the architect's plan. The pass was bought and then thrown away: the first
   architect session ran 440 seconds over 39 turns and was recorded as "no plan
   block".

5. **A refusal that was an oracle.** A campaign the caller may not see answered
   `No read with that id.` while one that does not exist answered `No such
   campaign.` — the same 404 with a different body, which is still a way to
   enumerate a Brain you have no access to. Found by writing the HTTP tests as
   an attack.

6. **The factory's own scaffolding landed in every worker's diff.** A worktree
   carries a link to the repository's dependencies, because a worktree that
   cannot run the repository's own commands cannot be verified — and the rescue
   commit swept that link in, so the integrator correctly rejected four units
   for a path no unit owns. Two corrections: the scaffolding is excluded by
   pathspec rather than by `.gitignore` (the factory put it there, so the
   guarantee must not depend on a file a campaign may change), and a rejection
   the factory caused no longer charges the unit an attempt — §23's sentence at
   a third altitude.

7. **A failing final check would have cycled forever.** Sending the campaign
   back to REVIEWING found the verdict that already judged that commit, acted on
   it again, and arrived at the same failure. The failure now becomes a repair
   unit authored from the exit code, because an exit code is a fact the factory
   observed and no model is asked what it means.

8. **Worktrees were nearly committed into the repository.** `data/` was ignored
   file by file, so `data/factory/` was not. A checkout of the repository inside
   the repository is not evidence.

---

## 3. The bootstrap campaign, from rows

_(Filled in at the end of the run.)_

---

## 4. What is not proven

_(Filled in at the end of the run.)_
