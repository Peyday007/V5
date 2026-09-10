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
| Schema: contract, campaign, units, graph, fleet, judgement, ledger | `server/db/migrations/037_software_factory.sql` (+ the generated Postgres twin) |
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
| Seed tests | `tests/factory.test.ts`, `tests/factoryHttp.test.ts`, `tests/factoryPersistence.test.ts` |
| Pins for three repairs the round-3 reviewer found untested | `tests/factoryBulkTick.test.ts` |

Review and repair are in the seed rather than in the bootstrap campaign, and
that is a deliberate departure from the assignment's suggested split: the seed
cannot run a *complete* journey without them, and a campaign that could not be
reviewed could not produce the evidence the rest of this file is about.

### Built by the factory, in the bootstrap campaign

Planned by an architect worker, implemented by implementation workers in their
own worktrees, integrated by the factory, reviewed by a session that did not
write the code, and repaired where the review found something. 3,950 lines
across 16 files.

| Component | File | Unit |
| --- | --- | --- |
| One read of a campaign, and the derivations three modules would each invent | `server/services/factory/campaignView.ts` | `campaign-view` (INTERFACE, critical path) |
| The briefing a person reads | `server/services/factory/projections.ts` | `projections` |
| A finished campaign in Brain's project history | `server/services/factory/writeback.ts` | `writeback` |
| Throughput with an evidence class on every number | `server/services/factory/throughput.ts` | `throughput` |
| A campaign whose process died, resumed from rows | `server/services/factory/recovery.ts` | `recovery` |
| The pull request, assembled from rows | `server/services/factory/pullRequest.ts` | `pull-request` |
| The factory, documented | `docs/FACTORY.md` (325 lines) | `factory-docs` |
| The loop and the HTTP surface reaching the new modules | `server/services/factory/loop.ts`, `server/routes/factory.ts` | `wiring` |
| Their tests | `tests/factoryCampaignView.test.ts`, `factoryProjections`, `factoryWriteback`, `factoryThroughput`, `factoryRecovery`, `factoryPullRequest`, `factoryWiring` | each unit's own |

The architect's unit specifications were not generic. The `campaign-view` unit's
objective included *"highest round, tie-broken by createdAt then array order —
do NOT take the last element of a list whose order you have not checked"*, which
is §24's recorded defect, applied by a worker that had read this repository's own
operating instructions.

Twelve of the twenty units are repairs the review generated. Nothing in the list
above was hand-written by the outer session, and nothing in the seed-kernel list
was written by the factory.

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

9. **Belt and braces became a conflict, and the crash took the tick with it.**
   `:(exclude)node_modules` names an ignored path explicitly, which git refuses
   outright once the ignore rule is also in place. The scaffolding is now staged
   and taken back with `git rm --cached --ignore-unmatch`, which cannot fail
   either way — and, more importantly, a lane's throw no longer propagates out
   of `Promise.all`. It killed the whole tick, left every other lane's unit
   LEASED, and made a failed `git add` recoverable only by a lease expiry. Each
   lane is now contained: it fails its own unit and records why.

10. **The sweeper was eating the evidence that recovery happened — and the first
    fix for it never landed.** The correction is recorded twice because it
    happened twice: the change was written, the commit message described it, and
    the edit had silently matched nothing, so what was committed was the comment
    beside it. Nothing caught that until a recovery drill produced a takeover
    with no takeover recorded. It is fixed now with a test that fails if the
    sweep widens again — which is what should have pinned it the first time. An expired
    lease on a unit with attempts left is claimable work, and the claim path
    takes it as a *takeover*, recording which worker died holding it. The
    sweeper ran first and swept those rows to READY — same work, no record. A
    signal that exists only if you do not sweep is a signal you lose, which is
    §23's arrival-credit defect in a new place. The sweeper now touches only
    leases no claim will come for.

11. **A dead dispatcher's sessions held capacity that did not exist.** A session
    exists to run a unit, so a RUNNING session whose unit is not LEASED is a
    session whose process is gone — but `workerLoad` counted it, so the dead
    dispatcher's lanes held phantom slots forever. Measured, not theorised: when
    the dispatcher died here, three sessions stayed RUNNING and the recovered
    dispatcher could start exactly one lane out of four. Orphaned sessions are
    now closed at the start of every tick, before the scheduler reads what is
    free.

12. **A provider refusal at the review was invisible and never deferred
    anybody.** The dispatch path treats a refusal properly — defer the unit,
    refund its attempt, mark the worker rate-limited, leave the failure streak
    alone. The review path did only the first half of the last part: it recorded
    RATE_LIMITED on the session and then neither wrote it to the ledger nor
    deferred the worker, so the campaign's own throughput report could not see a
    refusal that had happened and the next tick picked the same refusing surface
    immediately. Found because the drill campaign was genuinely refused, which is
    also where the production evidence for F10 came from.

13. **A reviewer was being asked to judge the repository rather than the
    campaign.** A campaign merges its base branch in whenever that branch moves,
    so `pinnedBase..head` grows to include everything other people landed since
    the pin. The review and the assembled artifact now diff against the merge
    base, which is the question a pull request actually asks.

---

## 3. The bootstrap campaign, from rows

Change request `fcr_ca6d1b17285d4a578f61`, campaign `fcp_9c66057104d6466cace0`,
project `prj_6776de19b47742fa993a`.

| | |
| --- | --- |
| Submitted and approved | through `POST /api/projects/:id/factory/change-requests` and `.../approve`, signed in |
| Base pinned at | `816865655ac5` on `claude/pensive-bell-dr81a4` |
| Acceptance conditions | 7, all approved before the first unit was planned |
| Work units | 20 — 8 planned by the architect, 12 repairs the review generated |
| Dependency edges | 8, with one INTERFACE unit on the critical path and four units waiting on it |
| Worker sessions | 34 (2 architect, 29 implementer, 3 reviewer) across 6 registered workers |
| Worker time | 772s architect, 10,421s implementer, 1,432s reviewer |
| Maximum concurrency | **4, MEASURED** — the true peak overlap of session intervals, against 6 declared slots |
| Lane target | raised from 3 to 4 by the tuner, from its own evidence, with the reason recorded |
| Integrations | 20 merged, 6 refused (4 for scaffolding in the diff, 1 conflict-free verification failure, 1 scope) |
| Review rounds | 3 — CHANGES_REQUIRED, CHANGES_REQUIRED, **PASS** |
| Independence achieved | SESSION_SEPARATED, SESSION_SEPARATED, **WORKER_SEPARATED** |
| Findings | 17 — 12 repaired and re-reviewed, 5 MINOR carried into the artifact as limitations |
| Artifact | a pull-request body and 171,538 bytes of patch: 49 commits, 16 files, +3,950/-13 |
| Released | by a person, once, through `POST /api/factory/campaigns/:id/release` |
| Wall clock | 09:03:42Z to 13:01:41Z — 3h58m from first event to last |
| Paid model API | 0 executions recorded, out of 28 finished sessions |

### What the independent review actually found

Round 1, six findings, including: the campaign writeback attempted exactly once
inside the COMPLETE transition with no later tick able to retry it; a recovery
stale bound of 10 minutes that would abandon a live reviewer; a call site pinned
only by a grep for its import, so deleting the call would keep the suite green;
an "exactly one event" property that was a SELECT followed by an INSERT with no
unique constraint behind it; a ceiling reported MEASURED whenever any session
ran; and documentation defining DERIVED as the one thing the module exists to
refuse.

Round 2, six more, including a finding the factory made against itself that this
file's own §2 is about: *"`recoverAll()` is exported and tested but nothing
outside tests calls it."*

Round 3: PASS, with five MINOR findings recorded as limitations rather than
closed — three of them saying that a repair from round 2 is asserted by no test.

**Three of those five are now closed, by hand, in the outer session.** They said
that reverting a round-2 repair would leave the suite green, and the assignment's
own verification standard is that reverting a critical repair makes its test
fail — so they are the one class of MINOR finding that cannot be left standing.
`tests/factoryBulkTick.test.ts` pins all three: the batch tick's bulk recovery
pass, by recovering a campaign whose own tick refuses above the line where it
would have recovered; the writeback retry, by the terminal campaign nothing that
walks live campaigns can reach; and the 90-minute unattached-session default, by
taking the default instead of supplying a bound. **The factory did not write
these.** It found them — its reviewer's wording was *"a revert of any of them
would leave the suite green"* — and it correctly did not queue them, because
MINOR is non-gating by design and the campaign was already released. Closing
them was a decision about the assignment's verification bar, made outside the
campaign, and counting them as factory output would be the exact claim §1 exists
to keep honest.

**The other three are now closed too, and one of them needed a correction to the
finding itself.** `tests/factoryFindingsClosed.test.ts` pins all three, each
failing alone when its own fix is reverted: the throughput breakdown now sweeps a
MEASURED peak overlap per worker, per role and per account and carries queue time
as UNKNOWN with its reason rather than omitting it; `assemble.ts` renders through
`renderPullRequest` instead of holding a second template, so the stored artifact
and the live route cannot disagree; and `recoverAll` now reaches terminal
campaigns whose workspace is still on disk, with the single-campaign tick's
terminal branch retiring its own scratch as well.

The correction: the PR-body finding named three divergences and one of them does
not exist. It said `assemble.ts` used `reviews[reviews.length - 1]` and would
therefore report the *older* verdict once a campaign had more than one round.
`listReviews` orders by round ascending, so the last element is the newest — the
two readers always agreed about the verdict. The other two divergences were
real: acceptance conditions with no MET/NOT_MET status against conditions with
one, and OPEN-only limitations against OPEN plus REPAIR_QUEUED plus
ACCEPTED_LIMITATION. A reviewer being wrong about one of three claims is not a
reason to dismiss the finding — the defect it named was there — and it is a
reason to say which claim was wrong rather than to let the fix imply all three
were.

### The recovery drill

A separate campaign, `fcp_97e7399a36014135938c`, run to exercise the recovery
path on real work rather than a fixture:

1. A dispatcher claimed the unit with a 60-second lease and started a worker.
2. The dispatcher was killed (`SIGKILL`) while its worker was live. Its heartbeat
   stopped; the lease ran out at 13:33:40Z.
3. A different dispatcher claimed the expired lease and recorded
   `UNIT_TAKEOVER` naming the worker that died holding it — *"the previous lease
   expired and the unit was claimable again"*.
4. That attempt produced the work and integrated it.

The row reads `from` and `worker_id` as the same registered worker, and that is
worth saying plainly rather than leaving to be misread: the scheduler had four
implementers free and handed the retaken unit back to the same one. What changed
is the **session** — `fss_6a73…` ABANDONED at attempt 1, `fss_7ac7…` FINISHED at
attempt 2, on its own branch — which is the thing a resume is about. A takeover
by a second worker identity would be the same mechanism with a different row in
one column, and this drill did not produce one.

Running the drill found three defects in the factory itself — the campaign tick
lease being neither renewed nor short, the integration branch name that could
collide, and the sweeper narrowing that had never landed. All three are in §2.

---

## 4. What is not proven

**Every one of the twenty-four production-shaped conditions passes**, read from
rows by `npm run factory:acceptance -- --campaign fcp_9c66057104d6466cace0`. The
last to arrive was F10: a provider genuinely refused a reviewer session during
the recovery drill, and the rows show what the factory did with it — the session
marked RATE_LIMITED, no unit attempt charged, no worker quarantined for being
refused. It was not simulated, and it was not forced.

What follows is what the twenty-four do **not** cover.

**Cross-account independence is not proven and is not claimed.** All six
registered workers draw on one subscription (`account_ref`
`local-subscription`), so the strongest tier any review could earn here is
`WORKER_SEPARATED`, which is what round 3 earned and what is recorded. A second
account raises the tier with no code change — the ladder already reads it from
lineage.

**The hosted deployment is an external boundary.** The control plane is deployed
and verified on this machine: merged into the working branch, typechecked, the
full suite green on both backends, the client built, migrated over a populated
database, restarted, and re-proved through the real HTTP routes. Deploying to
the hosted Brain needs a Fly.io token and a Supabase service key that are not in
this environment, and `verify:hosted` is designed to run inside that container.
That is a credential boundary, not a missing capability.

**The Cowork executor is registered-capable and unusable.** `COWORK_ROUTINE` is
a real second worker kind and its probe reports itself unusable, because the
factory-unit handshake for Brain's dispatch fleet is not built. It is UNKNOWN
capacity rather than available capacity, and the scheduler will not route to it.

**Five MINOR findings are open on the bootstrap campaign.** They are in the
artifact, verbatim, and three of them say that a repair is asserted by no test.
They were not closed to make the campaign finish: the completion rule is the
reviewer's own severity, and MINOR is what the reviewer called them. Three were
closed afterwards by hand; see §3.

**A container restart re-proved the campaign and cost the Postgres re-run.** The
environment restarted after the last full verification. Everything the restart
could confirm, it confirmed: the repository, the database and the worktrees came
back; the server booted with *no migration to apply* (35 already applied, which
is what additive means); the campaign reads COMPLETE with its pin, its twenty
integrated units, its thirty-four sessions, its measured concurrency of four and
its approved release; an anonymous caller is still refused at
`/api/factory/campaigns/:id`; and the twenty-four conditions still read 24/24
from rows. `tests/factoryPersistence.test.ts` is the authenticated half of that
same property and it passed in the suite that followed: two real server
processes over one data directory, signing in through `/api/auth/login` and
re-reading the campaign through the authorized route.

What it cost is exact and worth stating rather than rounding. The local Postgres
cluster lost its role credentials with the restart, and re-establishing them is
an action this session is not permitted to take. So the **last recorded Postgres
run is against commit `6ab7299`** — 86 files, 1970 tests, exit 0, measured by
`factory-verify` rather than asserted — and the only changes after it are
`tests/factoryBulkTick.test.ts` and these documents. No production code moved.
The honest reading is therefore: both backends green on the code, and the three
added tests exercised on SQLite only. F16 reads recorded rows per dialect and
does not pin a commit, so its PASS is true of what it measures and is not
evidence about those three tests.
