# Software Factory core — completion record

The handoff for the Factory core at the point its last construction stage
closed. Every claim resolves to a commit, a workflow run, a test or a production
reading, and each section says which of those it rests on. Historical evidence
lives in `FACTORY-*-EVIDENCE.md` beside this file and is not restated.

## Revisions

| | |
|---|---|
| Final branch | `claude/factory-core-completion-ri3kqj` |
| Final code SHA of this work | `901a42d` (all Factory-core code; nothing after it is this work's) |
| Released image carrying it | `662d337` — `901a42d` plus another session's `scripts/manufacturing.ts`, one test and docs |
| `deployed/production` tag | `662d337` (moved by deploy 325 at 10:38:54Z; `901a42d` before it, from deploy 323) |
| Deploy runs | 323 (`35836137130`, `901a42d`) and 325 (`35847875747`, `662d337`) |
| Production before this work | `f727b14` (deploy 315) |

**Ancestry.** A fast-forward throughout, nothing rebased or rewritten:
`f727b14` → the prior Factory closeout's 20 commits (`5d5dbc2` … `9262bbd`,
first pushed to `claude/software-factory-progress-ir4qqz`) → `d975db2` →
`e37cca0` → `b4615e6` → `4cf11e7` → `6f48991` → `41f4373` → (production's own
`ba5c0b2`, the fleet lane, and `533463f`, the puzzle kernel, landed on top) →
`ce67700` → `901a42d` (a merge of `533463f`, not a rebase). `production` was
only ever advanced by `git push <sha>:production` after `git merge-base
--is-ancestor` confirmed a fast-forward: `f727b14 → e37cca0`, `e37cca0 →
6f48991`, `6f48991 → 41f4373`, and `533463f → 901a42d`. The
commit carrying this document touches only `docs/`, which `.dockerignore`
excludes, so it changes nothing the image contains.

The prior closeout's last reported revision, `d359be5`, failed Postgres run 337
on a test that hoped for a race rather than forcing one. `9262bbd` fixed the
test (no production behaviour was wrong) and Postgres run 338 passed on it.

## Defects repaired in this continuation

Each was reproduced, pinned by a regression that was run against the defect and
seen to fail, then fixed.

**Found by the final adversarial sweep of the Factory surface (in `d975db2`,
`e37cca0`):**

1. **Forbidden paths were forbidden only when a plan named them exactly.** The
   planner read a unit's owned *glob* as a literal path, so `**`, `server/**`
   and `.github/**` passed, and nothing after the planner read the list — a unit
   owning `**` could change the deploy workflow or the policy module and pass
   ownership at integration. `services/factory/forbidden.ts` refuses at planning
   and, binding, on the files that actually moved: `integrateUnit` (local),
   `verifyUnitReport` and `verifyIntegrationReport` (hosted). 8 regressions
   failed on the old code.
2. **A stage that failed three bins was blocked for good.** The count had no
   baseline; the blocker named remedies that touch no bin. It now counts from
   the newest `FACTORY_STAGE_REAUTHORIZED`; the answer is `factory reauthorize
   --why stage-corrected`.
3. **A unit out of attempts had no answer** on either plane.
   `services/factory/regrant.ts` + `factory regrant-unit`: raises, never resets,
   closed reason set, `UNIT_ATTEMPTS_REGRANTED`.
4. **A forge-confirmed units report Brain could not record was silent and
   re-fired.** Now an uncharged `UNIT_REFUSED` row, the stage is held, and after
   five tries it costs the one attempt that bounds it.
5. **A tick that threw left no trace.** `FACTORY_TICK_FAILED`, once per message
   per hour, printed by `factory status`.
6. **A finished local campaign said "No pull request yet"** while its reviewed
   branch existed. Build names the branch and commit.
7. **`factory campaigns` answered for the first project only.**
8. Two dead exports removed; two vacuous `every` assertions given a floor.

**Found by running against production (in `b4615e6`, `4cf11e7`, `6f48991`):**

9. **The deploy's own post-restart verification timed out at the JUDGE step.**
   Deploy 316 measured the JUDGE submission at 12m26s over a 415-document
   archive before the restart and more than 15 minutes over 431 after it, where
   the harness's 900s bound fired. Cause, established rather than correlated:
   one `recomputeProject` asked the bucket whether each document exists three
   times (file-state pass, dependency refresh, planner), serially, inside its
   transaction, and the judge path recomputes twice; the verification project
   grows by a document or two per deploy, so every later deploy would have
   failed here. `objectExists` now answers from a memo scoped to one recompute,
   prefetched sixteen at a time before the transaction opens.
   `tests/recomputeStorageCalls.test.ts`: three calls per document before, one
   after, and a missing document still reads missing.
10. **A review tier was rounded up.** `fcp_189ea30c7ded4e7b9280`'s round-1
    review is recorded `WORKER_SEPARATED` although one worker ran every session.
    The first implementing rows carry the sentinel `unknown-worker`, and
    `reviewLineage` read it as a different worker. Worker separation now needs
    every implementer named. The historical row keeps what it said; the
    campaign evidence document records the correction.
11. **Per-account throughput credited unknown sessions to a named account.**
    The same campaign read 13 sessions for "Brain Research A" beside a peak
    overlap swept from the 10 that recorded it; three recorded `UNKNOWN`.
    Sessions are grouped by the account each recorded now, and a merge by a
    worker spanning accounts is `UNKNOWN`.

**Found by the deploy's own post-restart verification (in `ce67700`):**

12. **A judge submission issued a statement per document in its layer, several
    times over, inside its transaction.** Deploy 318 carried defect 9's fix and
    its pre-restart judge fell from 12m26s to 2m56s; after the restart the JUDGE
    submission ran nine minutes and died inside `createAudit` on
    `canceling statement due to statement timeout`, and deploy 319's release
    then could not boot because Supabase's storage API answered
    `544 DatabaseTimeout` — the Supabase database itself was saturated.
    Replaying the hosted verification against a local Postgres over one layer of
    433 documents with every statement logged found **3 240 statements inside
    the one judge transaction** and 1 946 inside the synthesis filing: 
    `deriveLayer` read each present document's latest audit and its findings
    only to compare the answer with null, and `buildAuditContext` read every
    sibling document's extraction run and every block of it for text no prompt
    prints. `documentIdsWithAudits` and `currentExtractionRunsFor` answer both
    in one statement per layer; the same replay issues **191** and **197**.
    `tests/auditRoundTrips.test.ts`: sixteen more documents add no statements
    (the old code went 29 → 77 on the context alone and fails the test), siblings
    still say why they cannot be read, and the batched audit read answers as
    the per-document one did.

Reported and deliberately not changed: `stopFactoryRemoteLoop` has no caller,
exactly like every sibling loop's stop function — shutdown relies on unref'd
timers and process exit for all of them. The stored `PATCH` artifact has no
reader; on the local plane the deliverable is the reviewed branch in the
operator's own checkout, which Build now names.

## Authoritative gates

| SHA | Local (`typecheck` + `vitest run`) | Postgres |
|---|---|---|
| `e37cca0` | typecheck exit 0; 210 files passed, 1 skipped; 4497 passed, 44 skipped; exit 0 | run 340 (`35802629342`): 211/211 files, 4541/4541 tests |
| `6f48991` | typecheck exit 0; 211 files passed, 1 skipped; 4502 passed, 44 skipped; exit 0 | run 346 (`35813247191`): 4546/4546 tests |
| `901a42d` (final code) | typecheck exit 0; 214 files passed, 1 skipped; 4588 passed, 44 skipped; exit 0 | run 363 (`35828583529`): 215/215 files, 4632/4632 tests |

Deploy runs also run the suite themselves before releasing (see below).

## Deployment

**Deploy 316** (`35806337199`, `e37cca0`): branch guard, typecheck, tests, build,
production-tip check and release all succeeded (released 01:49:10Z;
`deployed/production` → `e37cca0`). Hosted verification before the restart:
`PASS 229/229`. Restart succeeded. Hosted verification after the restart:
`FAIL could-not-complete — tools/call (brain_submit_audit): nothing answered
within 900s`. Verdict red. Defect 9 is the cause; nothing was rolled back,
because the release itself was sound and the fix ships forward.

**Deploy 317** (`35816319489`, `6f48991`): the test gate failed on one assertion in
`laborSurface` — `Found multiple elements with the text: /human interface/`, a
query that hoped for a race between two renders. `flyctl deploy` never ran and
nothing was released. Fixed on `production` in `41f4373` (another session's
identical fix landed first; see CLAUDE.md §41).

**Deploy 318** (`35821408658`, `41f4373`): released 05:33:18Z
(`deployed/production` `e37cca0` → `41f4373`). Before the restart: `PASS
229/229`, JUDGE 2m56s (defect 9's fix working). After the restart the JUDGE
submission ran nine minutes and died in `createAudit` on a statement timeout:
defect 12, fixed in `ce67700`.

**Deploy 319** (`35823462122`, `ba5c0b2`, the fleet lane's dispatch): the new
machine could not boot — Supabase's storage API answered `544
DatabaseTimeout`. **Deploy 320** (`35828432053`, `533463f`, the puzzle
kernel's dispatch) released `533463f` at 07:19:38Z and was cancelled during its
restart phase. **Deploy 321** (`35829507159`) was cancelled before any job ran.
**Deploy 322** (`35835570950`, `533463f`) was refused at the second asking of
the canonical guard, immediately before `flyctl deploy`, because `production`
had meanwhile advanced to `901a42d` — the guard doing exactly what §47 built it
for; nothing released.

**Deploy 323** (`35836137130`, `901a42d`): guard, typecheck, tests and build
passed; the late guard found `901a42d` still the tip; released 08:50:31Z
(`deployed/production` `533463f` → `901a42d`). Before the restart:
**`HOSTED-VERIFICATION: PASS 229/229`**, with the JUDGE submission taking
**1m42s over 434 documents** (08:52:40 → 08:54:22) against deploy 316's 12m25s
over 415 — defects 9 and 12 proved together on the released image. The restart
succeeded (`healthy again after 1 attempt(s)`, 08:57:49). After the restart the
verification ended `FAIL could-not-complete` at 09:13:17 on `(ECHECKOUTTIMEOUT)
unable to check out connection from the pool after 15000ms in Session mode`,
on an ordinary `SELECT` against `research_fragments`. That error is
Supavisor's (the Supabase pooler's), not Brain's pool: every one of the
pooler's fifteen session slots was held. The post-restart boot banner read
**34 backends connected** where the pre-restart one read 9, and
`brain_propose_fragments` took 8m43s against 13s before the restart on the same
image — contention at the shared database, not a code path that grew. It is the
pooler condition CLAUDE.md §27 records, not the judge pass. One re-run (attempt
2) was spent to confirm it and was cancelled mid-build when another session
advanced `production` and dispatched deploy 324 on the new tip.

**Deploy 324** (`35844174439`, `662d337`, another session's dispatch after it advanced
`production` from `901a42d`; attempt 2 of deploy 323 was cancelled mid-build
at that moment): the image was built and the machine config updated at
09:58:55Z, and the machine never passed a health check. The app's boot log says
why, twice: `The document store could not be checked (HTTP 544)` /
`{"statusCode":"544","error":"DatabaseTimeout","message":"The connection to the
database timed out"}` at 09:59:18Z and 10:06:03Z. Cloud mode refuses to boot
without its store (CLAUDE.md §18), which is correct. `/healthz` answered `503`
after ~35s on every probe from 10:13 to 10:23. Supabase's public status page at
10:24 read *Partially Degraded Service*, with Compute capacity, Storage, API
Gateway and us-east-2 degraded and storage incidents open, while this project's
storage endpoint itself answered `200` — so the failing hop is Supabase's
storage service reaching its own database.

**Deploy 325** (`35847875747`, `662d337`, another session's dispatch):
guard, typecheck, tests (10:35:59Z) and build passed; the late guard found
`662d337` still the tip; **released 10:38:53Z** and `deployed/production`
moved to `662d337`. `/healthz` answered `200` in 0.28s at 10:41. **The hosted
verification before the restart succeeded** (step "Prove the live Brain is
actually shut", 10:42:30Z). The restart step succeeded (10:47:35Z). The machine
then never answered again: "Wait for it to answer after the restart" failed at
11:10:25Z and the run ended cancelled; `/healthz` read `503` at 11:03 and 11:24.
The same Supabase condition: a read-only `factory campaigns` dispatched at 10:24
(`35848602130`) waited out the release and then failed at 10:49:59Z inside
`initDatabase` with `Connection terminated due to connection timeout` — the
database itself, not only the store, was unreachable. The job logs of a
cancelled deploy job are not retrievable, so the pre-restart pass is evidenced
by the step's own success (the step fails unless the harness prints its PASS
marker), not by a pass count. Deploy 326 (`35850047752`, `96b1bfc`, another
session) was cancelled before release.

## Production acceptance (live, read through `factory.yml` on the deployed image)

Taken on `e37cca0` after deploy 316's release and restart. The attempt to
repeat them on the final image is recorded at the end of this section.

- **`campaigns`, every project** — both projects listed, which the previous
  image could not do: Deal Dispatch (`fcp_189ea30c7ded4e7b9280` COMPLETE →
  `https://github.com/Peyday007/V5/pull/31`; the Oakwood campaign COMPLETE →
  PR #1; two operator-retired campaigns CANCELLED) and Verification scope
  (`fcp_bb1fda90085a4d3fb97a`, the restart-persistence beacon, "never
  executed"). No live campaign anywhere.
- **`status fcp_189ea30c7ded4e7b9280`** — COMPLETE, base `58c6deccf11f` →
  `6f92e7968fa5` on `factory/campaign/fcp_189ea30c7ded4e7b9280`; units 4/4
  integrated, 0 ready, 0 leased, 0 failed; 13 finished sessions, max observed
  concurrency 2 (MEASURED); reviews 2 (round 1 CHANGES_REQUIRED on
  `4b63f5c430ff`, round 2 PASS on `95b87eaa12dd`); findings 2, both REPAIRED
  (`late-link-never-attested` at `95b87ea`, `merge-observer-has-no-caller` at
  `6f92e79`); paid-API executions 0; one historical refusal row
  (`INTEGRATION_REJECTED` on `bin_0b6cdc2502d54b75b8c1`, the double hand-out
  fixed before this work); no tick-failure or uncharged-refusal rows.
- **`events`** — 43 rows, the whole chain: plan → units → integrate
  `4b63f5c` → review 1 → repair → integrate `95b87ea` → review 2 PASS → repair →
  integrate `6f92e79` → `PR_DELIVERED` #31 OPENED at `6f92e79` → COMPLETE →
  `BRAIN_WRITEBACK`. Every acceptance is `verifiedBy: forge`. `VERIFICATION_RAN`
  is `UNKNOWN` (no forge checks were present), never read as a pass.
- **`bins`** — all 13 bins COMPLETE; none leased, none NEEDS_HUMAN, none
  dispatchable. The review bin carries the live refusal of the implementing
  session `session_01NGWBAp…`, so the independence floor was enforced in
  production, not only in tests.
- **`throughput`** — every figure carries MEASURED / DERIVED / UNKNOWN and
  unmeasured ones print "not measured"; this reading is what exposed defect 11.
- **The deliverable** — PR #31 on the forge: `merged: true` into `production`
  at 2026-09-22T14:12:44Z by Peyday007, head `6f92e7968fa5…`, identical to the
  integration SHA Brain recorded and delivered.

### On the final image

A read-only `factory campaigns` against `662d337` (`35848602130`) could not
open the database (`Connection terminated due to connection timeout`, 10:49:59Z)
because of the Supabase condition above, so there is **no operator reading on
the final image**. The readings above were taken on `e37cca0`. Nothing in the
Factory has changed since them that could move them: every code change after
`e37cca0` in this work is to the audit/recompute read path (defects 9–12) and
to throughput/lineage reporting (10, 11), and `fcp_189ea30c7ded4e7b9280` is
terminal — COMPLETE, 4/4 units integrated, 13/13 bins COMPLETE, two reviews
(round 1 CHANGES_REQUIRED, round 2 PASS), both findings REPAIRED, PR #31
delivered at `6f92e79` and merged into `production` at 2026-09-22T14:12:44Z.
Its integration SHAs are `4b63f5c` → `95b87ea` → `6f92e79` on
`factory/campaign/fcp_189ea30c7ded4e7b9280`; its only refusal row is the
historical `INTEGRATION_REJECTED` on `bin_0b6cdc2502d54b75b8c1`.

## Proven by tests versus proven live

- **Live:** the objective → plan → units → integration → independent review →
  repair → re-integration → re-review → delivery chain, end to end, on a real
  campaign (the rows above and PR #31 merged); review independence refusing an
  implementing session; the operator surfaces (`campaigns`, `status`, `events`,
  `bins`, `throughput`) reading real rows on `e37cca0`; and **defects 9 and 12
  together**: on deploy 323's released image the JUDGE submission took 1m42s
  over 434 documents, against 12m25s over 415 before either repair, inside a
  pre-restart hosted verification of `PASS 229/229`.
- **Not proven live on this work's final code:** survival of a restart. Both
  post-restart halves that ran on it failed for reasons outside the code —
  deploy 323's on the Supabase pooler's `ECHECKOUTTIMEOUT` with 34 backends
  connected, deploy 325's because the machine could not reach Supabase at all.
  Restart survival of campaign, units, reviews and writeback *is* live-proven
  on earlier images (deploys 314/315), and nothing in this work touches the
  persistence those checks read; that is an argument, not a reading, and is
  labelled as one.
- **Tests only:** the forbidden-path refusals, stage re-authorization, unit
  regrant, the unrecordable-report hold, tick-failure rows, the local
  deliverable card, the per-account grouping, and the audit round-trip bound
  (`tests/auditRoundTrips.test.ts`) — each exercised by a regression run against
  its own defect first. None of those conditions has occurred on the live
  campaign, so production has had nothing to show.

## Operator surfaces (`factory.yml` → `scripts/factory.ts`)

`campaigns` (every project) · `status` (state, blocker, units with attempts and
failure detail, reviews, findings, sessions, and every refusal row) · `bins` ·
`events` · `throughput` · `pull-request`. Recovery: `answer-bin`,
`reauthorize` (`repository-granted`, `surface-restored`, `stage-corrected`),
`regrant-unit`, `set-state`, `release`, `retire`. Product surface: `/build`.

## Liveness: every state has a way out

| Condition | Out |
|---|---|
| bin lease expires | takeover of the expired lease; lease floor per contract |
| bin at NEEDS_HUMAN | `factory answer-bin` |
| stage exhausted (3 failed bins) | `factory reauthorize --why stage-corrected` |
| surface cannot push | deferred with cool-off; ceiling answered by `reauthorize` |
| unit out of attempts | `factory regrant-unit` |
| report forge-confirmed but unrecordable | retried uncharged, then bounded by one attempt |
| worker quarantined | `factory set-state` (guarded, audited) |
| no surface / no reviewer | derived blocker, cleared on the tick the condition stops |
| release awaiting a person | `/build` release card or `factory release` |
| obsolete campaign | `factory retire` (destroys nothing) |
| tick throws | `FACTORY_TICK_FAILED` row; the next tick retries |
| process restart | tick lease expires; state re-derived from rows |

## Remaining blockers

None inside the Factory core. One outside it, and it is the only thing between
this work and a green post-restart verdict: **the Supabase project
`somjwbtqwmnxndmpujgn` was unreachable from 09:59Z** (storage `544
DatabaseTimeout` at boot, database connection timeouts from an operator read,
Supabase's own status page reporting degraded Compute, Storage and us-east-2).
When it answers again, re-dispatch `Deploy` on the tip of `production`; the
code it needs is already there.

## Seams the four-account fleet lane integrates with

- **Onboarding:** `services/factory/onboard.ts` — `onboardRepository` writes the
  worker, membership, scope set and exhaustive `worker_routing` row;
  `repositoryOnboarding` derives `NOT_ONBOARDED` / `AWAITING_SURFACE` /
  `READY`. `FACTORY_ROUTING_CAPABILITIES = ['repository','repository-write']`.
- **Capacity:** `services/capacity/contribution.ts` — `contributedCapacity` /
  `contributedForRepository` is the only reading the Factory takes of member
  capacity; a projection, never a gate.
- **Bin requirements:** plan and review bins need `repository`; units,
  integrate and deliver bins need `repository` + `repository-write`
  (`services/factory/remote.ts`). The fire router and `services/bins/routing.ts`
  choose the surface; the Factory decides nothing about accounts.
- **Attribution:** review tiers and per-account throughput read the worker and
  account each row *recorded*. A fleet change that leaves a bin unable to say
  who finished it produces `unknown-worker` / `UNKNOWN`, which now correctly
  lowers the reported tier rather than raising it — so attribution quality on
  the fleet side is what lets the Factory report `WORKER_SEPARATED` or an
  account's merges at all.
- **Pooling:** one Factory worker may be bound to several Routines across
  accounts; review independence is judged on the session from Brain's own
  dispatch row, never on the account count.
