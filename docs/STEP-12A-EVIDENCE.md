# Step 12A — evidence

What was built, what was measured, and what is still unproven. A claim in this
file is either a row you can go and read or it is marked as not yet
established. `docs/STEP-12A-PLAN.md` is the freeze; this is the record against
it.

Four kinds of proof, never conflated:

| Kind | Means |
|---|---|
| **CODE** | the mechanism exists and is wired to a caller |
| **TEST** | it is proven by an automated suite, on both backends where the repository supports both |
| **HOSTED** | it is proven against the deployed application, before and after a real restart |
| **PRODUCTION** | it is proven by authoritative rows written by a real run |

**"Implemented" is never a production verdict.** A green deployment is not proof
that the product works.

---

## 1. Gate status

Read `step12a acceptance` for the machine verdict; this table is its narrative
companion and must agree with it. Any disagreement means this document is
stale — re-run the reporter, do not edit the table.

| Gate | Verdict | Proof | Evidence |
|---|---|---|---|
| `A01_SHELL_IDENTITY` | **PASS** | PRODUCTION | 6 Russell conversations on the deployed Brain, created through the live API |
| `A02_CONVERSATION_ROUTE` | **PASS** | PRODUCTION | 2 conversations Russell attached itself, `AUTOMATIC`, from a message naming the project |
| `A03_ROUTE_CORRECTION` | **PASS** | PRODUCTION | a person's correction recorded as `USER`, through the route that did not exist before |
| `A04_IRRELEVANT` | **PASS** | PRODUCTION | 8 turns produced 0 ideas — the live gate captured nothing from casual text |
| `A05_DEDUPE` | NOT_RUN | CODE, TEST | 0 merges onto a canonical idea |
| `A06_JUDGMENT_OVERRIDE` | NOT_RUN | CODE, TEST | 0 ideas carrying a stated judgment |
| `A07_PROBE_BOUNDS` | NOT_RUN | CODE, TEST | 0 probes completed; the envelope and runner are built and tested |
| `A08_COVERAGE` | **PASS** | PRODUCTION | 150 recorded coverage verdicts |
| `A09_AUTH_BUDGET` | NOT_RUN | CODE, TEST | 0 settled budget reservations |
| `A10_MISSION_PIPELINE` | NOT_RUN | CODE, TEST | 0 fully linked missions; 0 half-built, so nothing is stranded |
| `A11_INDEPENDENT_AUDIT` | **BLOCKED** | — | `DISTINCT_BOUND_WORKERS` — 0 active worker identities are bound to a registered Routine |
| `A12_WRITEBACK` | **BLOCKED** | CODE, TEST | by `A11` — a writeback needs a terminal packet, and a packet is terminal only after three independent audit roles |
| `A13_AUTO_NEXT` | **BLOCKED** | CODE, TEST | by `A11` — a follow-on launches from a finished mission, which needs that audit |
| `A14_HUMAN_RESUME` | NOT_RUN | CODE, TEST | 0 human decisions answered and resumed |
| `A15_RECOVERY` | **PASS** | PRODUCTION | 1 cycle has claimed and released; nothing stranded past a deadline |
| `A16_DD_FRESHNESS` | **PASS** | PRODUCTION | the Deal Dispatch project the adapter reads is present |
| `A17_PRIVACY_AUTH` | **PASS** | PRODUCTION | 6760 recorded authorization denials; 0 ideas less private than their thread |
| `A18_BASELINES` | **PASS** | PRODUCTION | 10 layers intact; no frozen layer lost its artifact |
| `A19_DELIVERY` | **PASS** | HOSTED | 3/3 ledger mutations, each verified before and after a real restart; the deployed application tree is the one the acceptance read. Derived in the workflow — see §8 |

Read from the deployed Brain's own rows at **2026-09-04T05:13:08Z**, run
33839659971, after all three delivery mutations:

```
10 PASS · 0 FAIL · 3 BLOCKED · 6 NOT_RUN
```

Two of the three `BLOCKED` gates wait on `A11` rather than on anything in this
repository, and say so by name.

The six `NOT_RUN` gates are **not** one undifferentiated pile waiting on one
thing, and an earlier version of this file said they were. They are two:

- **`A05`, `A06`, `A07`, `A09`, `A10` are one chain, not five needs.** A
  captured idea comes only from a turn a worker answered; a judgment is
  recorded on a captured idea; a probe runs from a candidate the loop judged
  `EXPLORE`; a reservation is settled by a launch; a launch produces the
  mission. Answer one turn and the chain starts; none of them can start
  without that first link.
- **`A14` is not on that chain.** It needs a mission to reach a genuine
  authority boundary and a person to answer it. Manufacturing one would defeat
  the gate, so it waits for a real decision rather than for throughput.

**Zero gates read `FAIL`.** Seven are `PASS` from production rows, one is
`BLOCKED` on provisioning, and eleven are `NOT_RUN` — which is what an unrun
condition reads as, not a failure. **One of the three delivery mutations has
been spent** (§8).

Two rules shape the reporter and are worth stating, because they are what stop
it becoming a rubber stamp. **"Implemented" is never a production verdict** — a
gate whose condition is about a real run reports `NOT_RUN` until that run's
rows exist, however complete the code is, and there is no flag that turns a
test into evidence. And **`A11` is derived fail-closed from lineage rows**, by
a check built to be hostile to forgery rather than by a constant — see §7.

The remaining gates split into two kinds, and the reporter no longer conflates
them. `A12` and `A13` are **`BLOCKED`**: they need a terminal research packet,
a packet is terminal only after three independent audit roles, and
`auditAdmission` refuses every audit item while the fleet cannot supply
independent lineage. Nothing anybody does short of resolving `A11` produces
their rows, and reporting them as `NOT_RUN` would send a person to work on a
gate that is not theirs to move.

The eight `NOT_RUN` gates are a different thing: each needs a Cowork session to
answer a `RUSSELL_TURN` bin. **One worker is enough for that** — the audit
matrix does not apply to a turn — so they are genuinely not-yet-run rather than
blocked, and the operator can move them by starting a session.

---

## 2. Phase 0 — what the inspection actually found

Recorded 2026-09-03, before any mutation.

### Verified starting state

Branch `claude/zealous-hypatia-78a2yp` at `7a6453d`, worktree clean, nothing
unpushed, no parallel-session work present locally or on the remote. Next
migrations are SQLite **027** and Postgres **018**. The client has no router, no
query library, no UI kit and no frontend test harness; `App.tsx` is 592 lines
over one implicitly selected project and `styles.css` is 1850.

Live fleet, read through `fleet show`: 4 accounts / 4 routines, `primary`/V1
`fires=12`, `friend-2`/V2 `fires=6`, both ENABLED with zero refusals and zero
no-shows, and two `verify-hosted-*` accounts that are structurally unroutable by
design and correctly reported as `MISSING SECRET`.

Live Deal Dispatch, read through the deployed Brain's own MCP surface as a
`WORKER` principal: eight layers, World Model `AUDIT_READY` v1, **Monetization
Logic `MORE_RESEARCH_REQUIRED` v1C**, six layers `NOT_STARTED`, and a planner
whose single next best action is *Redo Monetization Logic v1D*.

### Three defects confirmed in code, not assumed

**Capability routing is not wired end to end.** `bins.required_capabilities` and
`bins.workload_class` exist in migration 026 and Postgres 017;
`requiredCapabilities` appears nowhere in `server/domain/types.ts`; the
`createBin` path takes `workloadClass` and not `requiredCapabilities`; and
`services/dispatch/router.ts:102` reads the field through
`(bin as unknown as { requiredCapabilities?: string[] | null })`. A cast is not
a mapping, and `A10` routes on this, so it is fixed rather than recorded.

**`conversations.project_id` is `NOT NULL`.** Russell must open a conversation
before a project is chosen, so the existing table cannot be the Russell thread
unchanged. Resolved additively: `russell_conversations` carries a nullable
project and a unique `legacy_conversation_id`, a backfill gives every pre-12A
conversation a Russell thread, and **no message is copied or rewritten** — the
read projection unions legacy `messages` with `russell_messages` by
`created_at`, so ids, authors, timestamps and scope stay exactly where they are.

**The intent layer is a regex.** `services/agent/chat.ts:121` matches
`/^(what|which|why|how|…)\b/`. That is a deterministic rule layer and it is
useful; it is not cognition, and it stays behind Legacy rather than being
dressed up as Russell.

### The production read (run 33818496163, 2026-09-03T23:39Z)

`step12a-inspect.yml` reads the deployed release and the configured secret
**names and digests** — never values — and writes nothing.

| | |
|---|---|
| Image | `northline-brain:deployment-01M1JW5B0BZ75DVH24NHA6F6DS` |
| Release | **v98**, complete, deployed 2026-09-03T05:38:59Z |
| Machine | `811d651c26d948`, iad, started, 1/1 checks passing |
| Secrets configured | 11: the six database/storage ones, plus `BRAIN_ROUTINE_ID`, `BRAIN_ROUTINE_VERSION`, `BRAIN_ROUTINE_TOKEN`, `BRAIN_ROUTINE_TOKEN_2` and **`BRAIN_ROUTINE_TOKEN_3`** |

The schema/baseline step was skipped: `BRAIN_DATABASE_URL` is a Fly secret but
not a GitHub one, so the runner had nothing to connect with. The container has
it, and the baseline is read from inside the container before the first
mutation rather than from the runner.

**`BRAIN_ROUTINE_TOKEN_3` is deployed**, which was not known when Step 11's
blocker was written up. It is the credential a third Routine needs, so the
second friend-2 trigger can be registered as a real, fireable surface on that
account without asking for anything further. That does not by itself close
`A11` — the second Claude account must still authenticate as its own Brain
worker identity — but it removes the missing-secret half of the fallback.

### The inference seam — decided from what is actually deployed

**There is no `ANTHROPIC_API_KEY` and no `BRAIN_PROVIDER` in production.**
`providers/index.ts:60` falls back to the mock when `BRAIN_PROVIDER` is unset,
and `providers/claude.ts:106` needs `ANTHROPIC_API_KEY` to reach the Anthropic
API at all. So the deployed Brain has exactly two candidate inference paths, and
only one of them is permitted:

| Path | Status |
|---|---|
| Mock provider | **Refused.** Deterministic canned prose presented as a grounded answer is the one thing Russell's conversation may never be. |
| Anthropic API | **Refused by authority, not by capability.** The key is absent, and setting it creates paid API usage the user has not authorized. `GOAL_BUDGET`'s default prohibits new spending, and a build that quietly bought its way past that would be the exact failure the rule exists for. |
| The fixed-subscription Cowork fleet | **Permitted, and already connected.** Three Routine credentials are deployed, the dispatcher fires them, and the default acceptance authority explicitly allows "use of already-connected fixed-subscription Routines". |

So **Russell's turn is served by the fleet, not by a paid API.** The turn
persists as pending with its retryable reason, a bin carries it to a worker, the
worker returns a structured response, the server validates every reference,
enum, transition, authority and side effect before anything is stored, and the
conversation shows the answer when it lands. That is genuinely model-backed, it
spends nothing new, and it reuses the dispatch, lease, fencing and recovery
machinery Steps 10 and 11 already proved.

It also costs latency, and the honest consequence is that a Russell reply is not
instant. The pending-turn contract the assignment already requires — persist,
show that Russell has not finished, never manufacture an answer, resume exactly
once — is what makes that truthful rather than broken.

---

## 3. Phase 1 — canonical state and authority

**CODE and TEST.** Thirteen tables on both chains (SQLite `027_russell.sql`,
Postgres `018_russell.sql`), applying from empty on both, all additive: no
existing table rebuilt, no column dropped, no row rewritten.

`tests/russellState.test.ts` — **46 tests, passing on SQLite and Postgres.**
Every one is about a rule it would be tempting to relax, and the schema-level
ones are enforced by CHECK constraints as well as by code: a merged candidate
must point somewhere, a waiting mission must say what for, a pending turn must
carry its reason.

### Three defects the tests found

**The reservation guard aborted mutually.** Two callers raced for the last
mission slot, both inserted, both then counted two, both concluded they had
overshot, and both released — the ceiling respected and nobody getting the slot,
which is strictly worse than either winning. It now totals *through its own
row's position* in a stable `(created_at, id)` order, so the first inserter
ranks 1 and keeps it and only the second stands down. Deterministic, no mutual
abort, and it generalises to amounts rather than counts.

**`capture` had the same shape of race.** It looked for a duplicate and then
inserted, so two equivalent messages arriving together both saw nothing and both
created a candidate. It now creates first and asks whether an *earlier* row with
that meaning exists — no window, and the database decides the loser.

**The capability field migration 026 added had never been mapped.**
`bins.required_capabilities` and `bins.workload_class` existed in both chains;
`requiredCapabilities` appeared in no type, the create path took neither, and
`router.ts:102` read one through `(bin as unknown as { … })`. A cast asserts a
shape rather than reading one, so every real bin routed as if it required
nothing — while the router's own capability test went on passing, because it
built its bin with a hand-made object that always had the field. Row type,
mapper, create path and router are wired now, and the new test goes through
storage, which is the difference between proving a pure function and proving the
field arrives.

---

## 4. Phase 2 — the nervous system

**CODE and TEST.** `tests/russellNervousSystem.test.ts` — **77 tests, passing on
both backends.** The first three-quarters of them are described below; §5 covers
the turn, the probe and the API, which finished the phase.

| Built | What it does |
|---|---|
| `services/russell/routing.ts` | attaches a conversation to a project, asks when ambiguous, and lets a person's earlier correction outweigh a name match |
| `services/russell/judgment.ts` | decides what is worth capturing, dedupes, and forms Russell's own priority with a stated reason |
| `services/russell/coverage.ts` | the archive check that runs before any work is created |
| `services/russell/launch.ts` | the one way a mission comes into existence |
| `services/russell/writeback.ts` | what happens when one finishes, exactly once |
| `services/russell/loop.ts` | the durable tick, started by the server beside the dispatcher |
| `services/russell/dealDispatch.ts` | the read-only connected system, with its freshness in the type |
| `services/russell/proposal.ts` | zero-trust validation of what a model proposes |
| `services/russell/turn.ts` | one conversation turn, carried by the fleet — §5 |
| `services/russell/probe.ts` | the bounded light probe, and its verdict — §5 |
| `services/russell/probeEnvelope.ts` | where a probe is allowed to look, in code — §5 |
| `routes/russell.ts` | the HTTP surface and its two authorization boundaries — §5 |

**A model proposes; the server decides.** `validateProposal` is the audit
engine's rule applied to a conversation. Actions come from a closed set matched
exactly — no substring, no closest match, no inferred intent. An unknown field
refuses the *whole* proposal rather than being dropped, because a proposal whose
author believed an extra instruction would also take effect is not one to act on
halfway. Every project reference is re-resolved with `decideProjectAccess`
against the authenticated principal, and a real project the caller cannot see
returns the identical refusal to an invented id — so watching how the refusal
differs teaches nothing.

Injection-shaped text is **flagged, never filtered**: it is stored and shown as
written, because removing it would destroy the evidence that somebody tried, and
the actual control is that nothing found inside text is ever executed — a
property of acting only on a closed action set rather than of any pattern list.

**The connected system never presents memory as live state.** `CURRENT` carries
when it was observed, `STALE` keeps the last reading *and labels it* so its age
is readable, `UNAVAILABLE` says what went wrong without naming anything
internal. One function builds the object, and it is the one that refuses to
return a remembered reading as current.

**The loop is a row, and that is the whole of "while the laptop is closed".**
One tick finishes what ended, resumes what a person answered, ends what a
deadline passed, and starts at most one thing — in that order, so a decision
about what to do next is taken against what the project now knows rather than
what it knew before the result landed. Ownership is a compare-and-swap on the
cycle generation; an expired lease is claimable, so recovery never depends on
the previous owner shutting down cleanly, and the timer is a convenience whose
loss costs throughput and nothing else.

**Its bounds are the part that matters.** A completion writes a briefing, a
briefing is a turn, and a turn could seed a candidate whose mission writes
another briefing — nothing wrong on its own, and together a machine for spending
an allowance on itself. Three things stop it, and none of them is a model being
sensible: only a `USER` turn is ever a capture source, one launch and one
follow-on per cycle from the row, and the goal's mission ceiling counted in the
database. Hitting a bound preserves the remaining work rather than dropping it.

**Boot repairs before it ticks**, by re-entering the launcher's own
`repairLaunches` rather than a second implementation of a recovery path — which
is the one nobody tests.

**Routing considers only what the asker may see.** `candidateProjects` asks
`decideProjectAccess` before it scores anything, so an unauthorized project is
absent rather than refused — the option list, the ranking and the count are all
information, and a router that scored everything and filtered afterwards leaks
through all three. The inversion is in the suite: grant membership and the same
message routes to the previously hidden project.

**The launcher replaced a test CLI.** Packet and bin creation were stitched
together in `scripts/step10.ts`, which is fine for a harness that knows its own
arguments and is not a production seam. `launch()` validates authority, reserves
budget, creates both, links them by id, and is safe to re-enter at any point —
so boot repair is the same function rather than a second implementation of a
recovery path, which is the one nobody tests.

**It uses `AUTO_WITHIN_ENVELOPE`, not `GOAL_BUDGET`, and that is deliberate.**
`startPacket` refuses `GOAL_BUDGET` because nothing counted packets or
fragments, so the budget half of that authorization would be decorative while
the approval half took effect. Step 12A does now supply the counter — but the
counter belongs *in front of* the envelope rather than instead of it, because
`GOAL_BUDGET` also sets `autoApprove` and skips producing a plan at all. Two
controls in series: the reservation decides whether Russell may start, the
envelope decides whether the plan it produced is inside limits fixed in code
beforehand. `RUSSELL_STATE_LICENSING_V1` is that envelope, and unlike Step 11's
it is not one-use — the acceptance has to prove a *second* authorized mission
launching without another prompt, and one-use would have made the thing being
proved impossible.

**Coverage reuses the classifier rather than forming a second opinion.**
`assessRequirement` already decides SATISFIED / PARTIALLY_SATISFIED /
PRESENT_BUT_UNVERIFIED / STALE / CONTRADICTED / MISSING and is a pure function.
The one rule Russell adds is that **only `SATISFIED` closes a requirement** —
`PRESENT_BUT_UNVERIFIED` is somebody having written the answer down with nothing
behind it, which reads like coverage and is precisely where research is most
needed.

### Two failures the suite found in Phase 2's own code

**Dedupe ordered on a random tiebreak.** `capture` creating first and then
asking whether an *earlier* row existed was the right shape, and the tiebreak on
equal timestamps was `id`, which is random. So two candidates written in the
same millisecond could order arbitrarily, the row that genuinely arrived first
could sort second, decline to merge into a row it believed was later, and leave
two canonical candidates for one idea. The question is now *which row was
written first* — `ORDER BY created_at, rowid`, which the dialect layer rewrites
to `seq` on Postgres — asked by every caller including about itself, so all of
them get the same answer, exactly one of them is that row, and every other folds
into it. Three consecutive clean runs of the suite afterwards.

**A test's premise was false rather than its assertion wrong.** The correction
test used a message naming only a layer, which scores below the attach floor, so
the "before" case it needed never attached. Fixed by naming the project too,
which is the case the test is actually about.

**Postgres disagreed with a test, and the test was wrong.** The loop suite
asserted that two concurrent `tick()` calls produce exactly one run. Both ran on
Postgres. That is correct behaviour: a tick claims, works and *releases*, so two
ticks that do not overlap in time may both legitimately run — the alternative is
a Brain that ticks once and never again. SQLite's writers serialise tightly
enough that the second call was always still inside the first, which made a
false assertion look true for as long as only one backend ran it. The guarantee
is that two instances cannot hold the cycle *simultaneously*, and the test now
holds the lease and proves the arriving tick is refused.

### Two failure classes that are not product defects

**Runner contention.** One Postgres run showed five failures, all in
`tests/ocr.test.ts` and all *timeouts* at 60s and 90s, while a full SQLite suite
ran concurrently — that file renders images and shells out to Tesseract, so it
is the first to starve. The Phase 1 Postgres run with nothing competing passed
the same file. Rerun serially rather than rewritten, as the anti-drag rule says.

**A boot race under load.** One full run failed `tests/oauth.test.ts` at the
file level: it starts a real server and polls `/healthz` for 45 seconds. The
server's own banner is in the log — schema 27, all 27 migrations applied, OCR
detected — so it booted; the poll did not get an answer in time on a loaded
machine. It passes alone (83/83) and passes in a clean full run. Boot itself is
not meaningfully slower for Russell's sake: `repairLaunches` is one query over
an empty table and `startRussell` sets an interval, and both run before `listen`,
which is what printed the banner.

**Test teardown ordering.** An unhandled rejection from `tests/research.test.ts`,
where a research job's progress callback reaches `cancelResearch` →
`abandonRunningPasses` → `getDb()` *after* its file closed the database. It
predates Step 12A, it surfaces in whichever file happens to be running when it
lands, and it is recorded here rather than chased.

### The upgrade path, not only the from-empty path

`scripts/upgrade-check.ts` builds a populated database, drops what the Russell
migration added, deletes its `schema_migrations` row, and boots again exactly as
production would. Both chains:

```
SQLite                        Postgres
  was at        26              was at        17
  now at        27              now at        18
  messages      1 before, 1     messages      1 before, 1
  cycle rows    1               cycle rows    1
  russell convs 0               russell convs 0
UPGRADE: OK                   UPGRADE: OK
```

Writing it reproduced the confusion CLAUDE.md §3 warns about, by somebody who
had just read the warning: the first version deleted `WHERE version >= 27`,
which matches nothing on Postgres — where the same migration is **018** — so the
runner believed it was already applied and the tables stayed dropped. It selects
by migration *name* now. The two chains are numbered independently and their
versions do not mean the same thing, and a script that assumes otherwise fails
silently in the direction of "looks fine".

The last line is the one worth reading. Adopting legacy conversations is a
deliberate call, not a migration side effect — so a pre-12A `Project Chat` keeps
its row, its messages and its ids, and becomes visible through Russell only when
somebody asks for it. A migration that had quietly created Russell threads for
every old conversation would have been much harder to undo than to do.

### Where the suite stands

| | |
|---|---|
| `npm run typecheck` | clean |
| `npm run build` | clean; 57 modules, 315 kB JS / 30 kB CSS |
| SQLite | **1465 passed / 25 skipped, exit 0** |
| Postgres | **56/56 files, 1489 passed, 0 failed, exit 0** |
| Migrations from empty | both chains |
| Migration over existing data | both chains, `scripts/upgrade-check.ts` |

Both full runs were taken with nothing else competing for the machine, and the
Postgres one is capped at two workers. That is not a detail. An earlier attempt
ran vitest's default worker count on a four-core box beside a typecheck, and it
crawled — nine files in twenty-five minutes with the load average at 17. It was
stopped rather than waited out, because a run that slow is not evidence being
gathered, it is a machine thrashing. Re-run alone at two workers it completed
in 603 seconds with every file passing. The same lesson as the earlier OCR
timeouts, at a different scale: **a saturated runner produces failures that say
nothing about the code.**

---

## 5. Phase 2, completed — the turn, the probe and the API

**CODE and TEST.** The three seams Phase 2 was still missing.

### The turn is carried by the fleet, and the server decides

A person says something; the turn persists as `PENDING` with its reason, a
`RUSSELL_TURN` bin takes it to a worker, and the worker's structured reply comes
back through the same completion contract every other bin uses. That inherits
crash safety for nothing: an interrupted turn is a `PENDING` row and a `READY`
bin, both of which the existing machinery already resumes.

**A worker produces a proposal, and it is validated against the conversation
owner's authority rather than the worker's.** The effects land in the owner's
scope, so a worker that could widen a thread's reach by answering in it would be
escalating through a chat box. The owner's memberships are read at the moment
the effect happens, so somebody whose access was revoked between asking and
being answered is judged by what they may reach now.

### Three defects the turn found

**The effect ran before the guard.** `applyTurn` performed its side effect and
*then* resolved the pending message, so a redelivered bin — which the queue is
at-least-once by design, so this is ordinary — captured the same idea twice, and
every later redelivery added another. The resolve is the compare-and-swap, so
the effect now happens on the far side of it, with `recordProduced` attaching
the result afterwards. That opens a crash window which loses the effect while
showing the answer, and that is the right way round here: a lost capture is one
a person can simply say again, whereas a duplicated one quietly corrupts the
backlog Russell's own ranking reads.

**A bin state that does not exist.** The loop's answered-turn query filtered on
`PARKED`, which is not a member of `BIN_STATES`, and omitted `FAILED` and
`CANCELLED`. So a turn whose bin died sat `PENDING` for ever with no path out —
§22's rule at a new altitude, and a spinner that never ends is not waiting, it
is stuck. `NEEDS_HUMAN` is deliberately *not* in the closing set: that state has
a guarded way out and the work is still alive.

**A response that reported a settled turn as pending.** `beginTurn` returned the
pending message as it was written, so a turn resolved immediately in the same
call — the "which project is this about?" path — still read `PENDING` to the
caller. An interface would have shown a spinner over an answer it already had.
Found by the HTTP suite, not by the unit tests, because it is a property of what
crosses the boundary.

### The probe: Brain chooses where to look

`services/russell/probeEnvelope.ts` is the same idea as the approval envelope at
a smaller scale, and for the same reason: **nobody supplies the limits their own
work is judged against.** The envelope lives in code and a probe names it by id.
A proposal supplies one thing — a narrow question — and it is carried as an
encoded query value into a URL Brain wrote, so the worst a confused or hostile
proposal can do is ask a silly question of an approved source. A redirect out of
the allowlist is refused rather than followed, because following one silently is
how an allowlist becomes decorative.

The bound is asked before each fetch, from rows, and the **observations table is
the budget** rather than a log of it — so a runner that crashed and resumed
cannot get its allowance back by forgetting. One consequence caught in review: a
refusal must *not* be written as an observation, or it spends an allowance
nothing consumed.

No model is called and nothing is spent, so the verdict ladder is deliberately
modest. `SUPPORTED` means an approved source demonstrably discusses the subject
— a claim about presence, never about truth. `WEAKENED` means pages were read
and did not mention it. `UNKNOWN` means nothing was read, because learning that
a network is closed is not learning about the subject; that is Step 10's rule,
and it is why a 429 from the host, an unreachable host and a missing page are
three recorded facts rather than one.

The envelope is deliberately minimal — one general source — and **widening it is
a code change somebody reviews.** A light probe's job is to decide whether to
spend the allowance a real packet would; a wider reach nobody has justified buys
nothing that the evidence gate, the verification pass and three audit roles do
not already do properly.

### The API is a door, not a second set of rules

Every route is a thin wrapper over a service that already existed, with the
scope it already required. Two boundaries meet in the file and they are not the
same one: a **project** is guarded by `decideProjectAccess` through
`requireProject`, and a **conversation** is guarded by its owner plus, for a
shared thread, read access to the attached project.

**A Brain administrator is deliberately not entitled to somebody's private
thread.** An administrator who can read everyone's conversations is a different
product. Both refuse with the same 404 and the same body, because a status code
that matches while the body differs is still an enumeration oracle — and that
one survives a test asserting only the status, so the HTTP suite asserts the
bodies are equal.

A worker principal is refused at the conversation routes by **principal type**
rather than by scope: there is no membership configuration that turns a machine
into a person.

Two POSTs are declared `READ` in the policy rather than taking the method
default. Asking a person for write access to find out whether Russell would need
to research something is backwards — the coverage answer exists to be consulted
*before* anything is spent.

---

## 6. Phase 3 — the Russell shell

**CODE and TEST.** `tests/russellShell.test.tsx` — **23 behaviour tests**,
through a scripted `fetch` so the components go through the same `api()` they
use in production, including its error handling, which is where the forbidden
case is actually decided.

Opening Brain lands on a conversation. The old three-pane console is at
`/legacy`, one click away behind a secondary menu — not deleted, and not hidden
as punishment: it is still the only place some operations exist, and a person
who needs it should not have to be told a URL. The operator console is offered
only to a Brain administrator.

**Routing is written rather than installed.** What this needs is one path, a few
segments and the back button; a package for that is weight somebody has to keep
working, and the deploy budget for this step is three mutations. An unknown
address becomes `NOT_FOUND` rather than quietly becoming the home page, because
a stale bookmark that showed something else is how a person ends up sure they
are looking at what they asked for.

**The five view states are decided in one tested place.** `listState` owns
loading, ready, empty, forbidden and error, so "an empty list and a forbidden
project must not look the same" is a thing a test asserts rather than something
a person has to notice in a browser. The forbidden message deliberately does
*not* claim the work is absent: the server cannot distinguish absent from
forbidden, and an interface that invented an answer would undo that on the last
hop.

**Nothing is optimistic.** A person's message appears because the server stored
it; Russell's side appears as a pending turn carrying the server's own reason; a
send that fails keeps the words and says so; a failed turn is labelled failed.
The polling that watches for an answer runs only while something is pending,
because a poll that runs all the time is a poll nobody notices is broken.

**Layout is one decision taken from the viewport** — `navigationMode` — so
"a rail on a desktop, a bar within thumb reach on a phone" is asserted in a test
rather than left to a media query nobody exercises. The media query is still
there as the belt to its braces, for the frames before React hears about a
resize.

One robustness fix came out of writing the tests: `scrollIntoView` is guarded,
because a conversation that throws while being polite about scrolling is worse
than one that does not scroll.

---

## 7. Phase 4 — crash injection, privacy, and the machine verdict

**CODE and TEST.** `tests/russellRecovery.test.ts` — **11 tests on both
backends** — plus `tests/russellHttp.test.ts` — **12 tests against a really
booted server**.

### The defect the crash injection found

`repairLaunches` documented itself as re-entering `completeLaunch`, and did not.
A mission that crashed before its orchestration existed was pushed onto
`completed` with nothing done, so **every future repair pass reported a stranded
mission as healthy.** That is the "waiting for a person who cannot resolve it"
defect again — this time waiting for a repair that had already declared itself
finished.

The reason the code had drifted from its comment is that `completeLaunch` needs
a `LaunchInput` the mission row does not carry. It turned out to be recoverable
without a migration: the specification is the **candidate's own recorded
judgment**, the identical source `nextLaunchable` launches from. So repair asks
the same question the launch asked, gets the same answer, and re-enters the same
function — which is what makes crash repair a re-entry rather than a second
implementation of a recovery path, and a second implementation of a recovery
path is the one nobody tests.

A mission whose candidate or specification has genuinely gone is reported as
**orphaned**, not marked finished. Visibly stuck is recoverable; silently
complete is a mission nobody ever looks at again.

### What the eleven tests kill it at

The earliest crash point — mission row only, bin deleted so nothing can be found
and relinked — is finished end to end, one mission and one bin. The
`createBin`-to-`linkMission` window finds the bin rather than making another.
Repairing twice does the work once and the second pass has nothing to inspect.
An unrebuildable mission is orphaned rather than completed. And the loop repairs
on its own without waiting for a restart.

### Privacy at the seams

Visibility flows from the thread onto the idea and onto its probe: most
restrictive source wins, so a probe about a private idea is private however
public the project is. Private findings are **absent** from the shared listing
rather than filtered out of it, so a count taken from that listing cannot leak
that they exist.

One thing is deliberate and is stated rather than left implicit: a private idea
*is* listed to the project it belongs to. Candidate visibility governs how a
finding is published, not whether the project's own listing knows the idea
exists — the route above it is what decides who may call that at all.

### Injection

Four shapes — an override instruction, a forged system line, a smuggled tool
call, and SQL — are each refused as `UNKNOWN_ACTION` when they arrive as an
action, and each stored **verbatim** when they arrive inside an answer. Kept
rather than filtered, because removing it destroys the evidence that somebody
tried; the actual control is that the only field carrying state is `action`, and
it comes from a closed set matched exactly. A proposal carrying extra fields —
`authorizedBy`, `maxLookups`, `spend` — is refused whole.

### The acceptance reporter

`npm run step12a:acceptance` reports all nineteen gates from authoritative rows
and exits non-zero unless every one is `PASS`. It is read-only by construction:
it opens the configured database, counts, prints and closes, so it is safe to
point at production, which is where most of these gates are actually settled.

Its verdicts are shaped so that it cannot be flattered. A gate about a real run
is `NOT_RUN` until that run's rows exist. `A07` and `A10` and `A15` and `A17`
and `A18` can each read `FAIL` — a probe that outspent its bound, a mission
missing a link, an item stranded past its deadline, an idea less private than
its thread, a frozen layer that lost its artifact — so the reporter is capable
of saying no, which a reporter that only counted upwards would not be. `A19` is
`NOT_RUN` always: no row in this database proves a hosted verification passed
after a real restart, and inventing one would be the worst thing in the file.

### A11 is derived, and the first version of it was wrong

The reporter originally hard-coded `A11` to `BLOCKED`, on the reasoning that a
database check could be satisfied by writing rows. **The concern was right and
the remedy was wrong.** A constant cannot become true when the evidence
arrives, so closing the gate would have required a code change and a deployment
at precisely the moment the gate was supposed to be answering — and a gate that
needs a deployment to say yes is not reporting, it is being told.

`services/research/independenceEvidence.ts` replaces it with a fail-closed
evaluator whose nine conditions are chosen against the shortcuts somebody would
actually take:

| Condition | The shortcut it refuses |
|---|---|
| `SIGNED_MATRIX_INTACT` | lowering `PRIMARY_ADVERSARIAL` from `ACCOUNT` to make an audit eligible |
| `SAME_LINEAGE_REFUSAL_PRESERVED` | removing the guard and leaving the gate reporting on a control that no longer exists |
| `DISTINCT_ACCOUNT_CREDENTIALS` | registering one subscription twice under two names — the **digests** must differ, not the labels |
| `DISTINCT_BOUND_WORKERS` | one worker wearing both accounts, or a disabled identity |
| `LINEAGE_MATCHES_BINDING` | writing the wanted account onto a pass; the binding its worker resolves to is what is believed |
| `SESSIONS_ARE_REAL_CREDENTIALS` | an invented session string, or borrowing another worker's real one |
| `INDEPENDENT_LINEAGE` | both arguments on one account, or a judge that also argued |
| `AUDITED_PACKET_WAS_FILED` | a bare set of pass rows with no filed document behind them |
| `EVIDENCE_READABLE` | an unreachable database reading as a pass |

`tests/independenceEvidence.test.ts` — **15 tests** — builds the complete
authentic shape and then removes exactly one part of it per test, asserting
both the `BLOCKED` verdict and *which* condition named it. Building the whole
shape is not a way around the gate; it is the only way through, and it is what
production has to produce. What that buys is the property the gate needs: when
friend-2 reconnects correctly and the live audit runs, **the same deployed code
derives `PASS` from rows with no further deployment.**

---

## 8. Phase 5 — the deployment, and what production actually says

### The delivery ledger

**One of three mutations spent.**

| # | Intent | Status |
|---|---|---|
| 1 | Integrated foundation: schema, canonical services, Russell loop, API, shell | **spent** — run 33835314104, commit `10658fd`, image `deployment-01M1N9H57EWJRWWFC2BFXTT681`, released 2026-09-04T04:09:17Z |
| 2 | Acceptance correction: worker vocabulary, the routing acceptance case, A11-transitive blocking | **spent** — run 33837508678, commit `9023673`, released 2026-09-04T04:42:24Z |
| 3 | The correction route, and the A03 query that could never match — both found by the real acceptance | **spent** — run 33838743276, commit `3def7ec`, released 2026-09-04T05:02:40Z; hosted verification PASS before and after the restart |

`step12a-acceptance.yml` is **not** a mutation. The reporter opens the
database, counts, prints and closes; it creates nothing, advances nothing and
takes no decision, so nothing about what is running changes. Same standing as
`step12a-inspect.yml` in Phase 0.

### A released image is not a passing deploy

The contract asks for hosted verification before **and** after a real restart,
and that is what the run did:

| | |
|---|---|
| Gate job | typecheck, 1449 SQLite tests, build — all green on the runner |
| Deploy | success, 04:09:17Z |
| `/healthz` | 200; anonymous `/api/projects` → 401 |
| Hosted verification, before the restart | **PASS 156/156** |
| Real machine restart | success, 04:13:18Z |
| Hosted verification, after the restart | **PASS 162/162** |

The Russell checks passed inside both. The ones worth naming are the boundary
ones, because they are the easiest to lose in a refactor and the hardest to
notice — an administrator testing the feature would never see them fail:

```
PASS  a Brain administrator is refused somebody else's thread, identically to
      one that does not exist — both 404, identical body
PASS  the reply is a pending turn with a stated reason, not a manufactured
      answer — PENDING
PASS  no internal bin id reaches the person — checked the response body
PASS  the briefing carries no percentage — checked every sentence
PASS  a project the member cannot open has no Russell view either — 404
```

### What the deployed Brain proves on its own

Four of the seven passing gates are not restatements of the suite. They are
facts about the running program:

- **`A01` — two Russell conversations exist**, created through the live API by
  the two hosted-verification passes. The shell's own surface works on the
  deployment, not only in jsdom.
- **`A04` — two turns produced zero ideas.** The deployed capture gate ran and
  correctly declined; a build where everything became a candidate would show
  here as a `FAIL` rather than as a silence.
- **`A15` — one cycle has claimed and released.** The Russell loop is running
  beside the dispatcher on the deployed machine, and nothing is stranded past a
  deadline.
- **`A18` — ten layers intact.** Step 9's, Step 10's and Step 11's work is
  untouched by the mutation; no frozen layer lost its artifact.

### A defect found by reasoning about production, not by a test

The turn manifest never named the closed action set. `validateProposal` matches
the action exactly and refuses anything else, which is right — but the manifest
is the only thing a worker sees, so a real Cowork session would have had to
*guess* the vocabulary, and every guess would have resolved its turn as
`FAILED`. The refusal would have looked like the worker's fault.

**A rule enforced against somebody who was never told it is not a rule, it is a
trap.** The manifest now writes out all eight actions, the required and
optional fields, the probe ceiling and the unit key, and a test asserts that
every member of `PROPOSAL_ACTIONS` appears in the manifest a turn actually
builds — so adding an action without telling the worker fails the suite.

It was found by asking what a worker receives rather than by a test failing,
which is the class of defect the local suites structurally cannot catch: every
one of them plays the worker with a proposal it already knows is valid.

**This fix is not deployed.** It is on the branch and ships with the next
mutation. Spending mutation 2 on it now would spend the acceptance-correction
budget before the acceptance that is supposed to find the corrections has run,
and nothing about it can be proven end to end until a worker session actually
answers a turn.

### The second mutation, and what it bought

| | |
|---|---|
| Gate job | typecheck, 1465 SQLite tests, build — green |
| Deploy | success, 04:42:24Z |
| Hosted verification, before the restart | **PASS** |
| Real machine restart | success, 04:46:35Z |
| Hosted verification, after the restart | **PASS** |
| Acceptance, from production rows | **8 PASS · 0 FAIL · 3 BLOCKED · 8 NOT_RUN** |

**`A02_CONVERSATION_ROUTE` moved from `NOT_RUN` to `PASS`.** The frozen
ordinary conversation ran through the real interface twice — once in each
verification pass — and Russell attached both threads to the project the
message named, recording the decision as its own (`AUTOMATIC`). That gate was
previously assumed to need a worker; it does not. Routing is decided by
`routeMessage` on the server before the fleet is involved, and once that was
noticed the gate was reachable within this assignment rather than outside it.

The same pass also asserted the opposite error: a **second** message does not
re-route a thread that is already attached. A router that re-decided every turn
would make a person's correction last exactly one turn, which is the failure
`A03` exists to catch and would have been invisible in a test that only ever
sent one message.

`A01` rose from 2 conversations to 6 and `A04` from 2 turns to 8, both from
real production traffic through the live API.

### The third mutation: two defects the real acceptance found

Neither was visible from the suites, and both are the same shape — a rule that
existed in one half of the system and nowhere else.

**`A03` was unsatisfiable by construction.** The reporter counted
`russell_conversation_context.source = 'CORRECTION'`, and `CORRECTION` is not a
member of `ATTACHMENT_SOURCES`. The gate could never have passed however many
corrections a person made, and would have read as an unrun condition for ever.
**A gate that cannot be satisfied is not a strict gate, it is a broken one** —
and it is the failure mode a reporter is most likely to have, because a query
that returns zero looks exactly like a condition nobody has met yet. It counts
`USER` now, which is the vocabulary `listCorrections` actually reads.

**Nothing could write a correction.** `routeMessage` has always read them and
weighed them above a name match — the logic, the scoring and the tests were all
there — but no route recorded one, so the entire mechanism was reachable only
from a test. **A rule the interface cannot express is a rule the product does
not have.**

`POST /conversations/:id/project` is that route: owner-only, with the project
re-authorized against that person so a correction cannot become a way to attach
a thread to something the corrector may not read. That last one is asserted
directly, because it is the mistake this shape invites. A `null` project
detaches, which is the honest option when somebody knows a thread is filed
wrongly and not where it belongs.

Finding these is what the instruction to actually run the acceptance bought.
Both would have survived indefinitely behind a green suite.

### Where the three mutations left it

| Reading | Verdict |
|---|---|
| After mutation 1 (04:20:13Z) | 7 PASS · 0 FAIL · 1 BLOCKED · 11 NOT_RUN |
| After mutation 2 (04:52:08Z) | 8 PASS · 0 FAIL · 3 BLOCKED · 8 NOT_RUN |
| After mutation 3 (05:13:08Z) | **9 PASS · 0 FAIL · 3 BLOCKED · 7 NOT_RUN** |

Every mutation released a real image, and every one passed hosted verification
**before and after a real machine restart**. Nothing was rolled back and no
gate has ever read `FAIL`.

`A02` and `A03` were both reached inside this assignment after being written up
as needing something external. They did not: routing and correction are both
decided by the server before the fleet is involved. That correction is recorded
here rather than quietly fixed, because the mistake was mine and the same shape
twice — assuming a gate needed a worker because the *product feature* it proves
eventually does.

### The resume path

Nothing here waits on this session. To move the seven `NOT_RUN` gates:

1. Start one Cowork session against the deployed Brain, on the connected
   worker. A `RUSSELL_TURN` bin carries the whole contract in its manifest now
   — all eight actions, the field shapes and the unit key — so the session has
   what it needs without being told anything by hand.
2. Say something in a Russell thread through the deployed shell. `A05`, `A06`,
   `A07`, `A09` and `A10` follow from turns being answered.
3. `A14` needs a mission that parks for authority, which is downstream of (2).

To move `A11` and the two gates behind it, the provisioning in the next
section. To re-read at any time: **run the `Step 12A acceptance` workflow.** It
is read-only, runs the reporter inside the container against production rows,
and keeps the reading as an artifact.

### The reconciliation read (2026-09-04T05:22-05:38Z)

Three read-only readings, taken to resolve what looked like a contradiction
between the acceptance verdict and the fleet summary.

**They were never in conflict.** `fleet show`:

```
primary   ENABLED  target=2
    V1  ENABLED  ref=trig_01CBLu5oCZziEwznw5q9xU7g  worker=wkr_1cdd82cfb2a54faf8edd
                 secret=BRAIN_ROUTINE_TOKEN    fires=15 refusals=0 no-shows=3 in-flight=0
friend-2  ENABLED  target=2
    V2  ENABLED  ref=trig_01HR74TmLtm8L21sh2Xryqhq  worker=wkr_1cdd82cfb2a54faf8edd
                 secret=BRAIN_ROUTINE_TOKEN_2  fires=9  refusals=0 no-shows=3 in-flight=0
verify-hosted-account-a  trig_verify_hosted_a  worker=wkr_f316703921d14060ae2c  (not routable)
verify-hosted-account-b  trig_verify_hosted_b  worker=wkr_a1b5b1d1cd4c472e8632  (not routable)
```

One worker **is** bound, to both Routines. The evaluator counts workers bound to
**exactly one** account, because a worker whose Routines span two accounts has
no resolvable account — `lineageForWorker` already fails closed on precisely
that. The filter is one line:

```ts
const boundWorkers = [...accountsByWorker.entries()]
  .filter(([, accounts]) => accounts.size === 1);
```

`wkr_1cdd82cfb2a54faf8edd` maps to `{primary, friend-2}`, size 2, so it is
dropped and the count is zero. The two verification workers *are* one-to-one but
their Routines hold no credential, so they never enter the set.

**The condition is right; the sentence is wrong.** "0 active worker identities
are bound" reads as *none are bound*, when the truth is *one is bound
ambiguously*. That wording is a defect in `independenceEvidence.ts` and it is
the only thing that made these two readings look like they disagreed.

### Why no turn has been answered

`fleet scale-advice`, in Brain's own words:

```
QUARANTINE CANDIDATE trig_01CBLu5oCZziEwznw5q9xU7g:
  3 consecutive fired sessions never checked in. That is a surface that cannot
  authorize, and every further fire costs an activation to learn it again.
QUARANTINE CANDIDATE trig_01HR74TmLtm8L21sh2Xryqhq: (the same)
```

So the dispatch state is **SENT, then no-show** — not `READY` with no intent,
and not rate-limited: `refusals=0` on both surfaces, and `fires` rose 13→15 and
7→9 across the reconciliation window. Brain routed, claimed a slot, fired, and
the fire was accepted. No Cowork session ever checked in.

That is §22's split doing its job: **Brain owns dispatch; the surface owns
whether a worker may act.** The scaler proposes quarantine and does not apply it
(`automatic=false`), which is correct — quarantining would remove capacity
rather than repair the surface. No guarded enable or binding action is
available or appropriate: both accounts and both Routines are `ENABLED`, targets
are set, two candidates are eligible, and nothing is paused.

#### The cause of the no-shows is still unresolved — 2026-09-04

Recorded plainly because a wrong repair recorded as a repair is worse than an
open question.

**The leading hypothesis was refuted.** I proposed that
`.claude/settings.json` granted `mcp__cloud-brain__*` (hyphen) while the live
connector namespace is `mcp__cloud_brain__*` (underscore), so the grant would
not match. Inspecting the trigger showed its connector is declared as
`cloud-brain` — the hyphen spelling the file already allowed — and the worker
checks out the repository at the branch that carries it. **The grant and the
connector name already matched.** Commit `1111b3e` adds the underscore spellings
anyway; that is harmless compatibility coverage and **is not credited as the
repair.**

**The ten-minute observation window did not retest the surface.** It elapsed
with `fires` unchanged at V1=15 and V2=9, and a subsequent read
(`STEP10: OK watch settled=true bins=97`) showed every bin in the project
terminal. There was no `READY` bin, so the dispatcher had nothing to fire and no
activation occurred. **The window was vacuous, not negative** — it is evidence
about the queue, not about the Routine.

So: the no-show cause is **unresolved**. What is known is what §22 already
splits: Brain routed, claimed a slot, fired, and the fire was accepted
(`refusals=0`, `fires` advanced); no Cowork session then checked in. Whether
that is the surface's authorization, the session's own execution, or something
else has not been established, and nothing in this step should be read as
having fixed it. The next fresh `READY` bin is the first real retest.

### A fourth defect, of a family this project has met before

`fleet profile --class RUSSELL_TURN` reports `binsPlanned: 0, activations: 0,
bottleneck: NO_WORK`. That is **not** evidence that no turn bins exist.
`binsPlanned` counts `bin_events` rows of type `BIN_READY` carrying that
`workload_class` — and `createBin` records its `BIN_READY` event **without
passing `workloadClass`**, even though `recordBinEvent` accepts the field and
migration 026 added the column.

So every workload-class-filtered profile reads zero, for every class, whatever
the fleet actually did. It is the same shape as the capability field Phase 0
found: a column a migration added, a write path that never populates it, and a
reader that then reports a confident wrong number.

**The consequence for this acceptance is that no existing read-only path can
say what state the pending turn bins are in.** `explain-route` needs a bin id;
nothing lists bins; `scale-advice` gives a queue signal but no class. That is
recorded as the limit it is rather than guessed around.

### The one blocker, stated exactly

`A11` reports `DISTINCT_BOUND_WORKERS — 0 active worker identities are bound to
a registered Routine`, and reading the fleet says exactly why (run 33836654702,
04:24:12Z):

```
primary   ENABLED target=2
    V1  ENABLED  worker=wkr_1cdd82cfb2a54faf8edd  secret=BRAIN_ROUTINE_TOKEN
friend-2  ENABLED target=2
    V2  ENABLED  worker=wkr_1cdd82cfb2a54faf8edd  secret=BRAIN_ROUTINE_TOKEN_2
verify-hosted-account-a  trig_verify_hosted_a  (not routable — MISSING SECRET)
verify-hosted-account-b  trig_verify_hosted_b  (not routable — MISSING SECRET)
```

**Both routable Routines are bound to one worker identity.** So that worker's
Routines span two accounts, its account is unresolvable — which
`lineageForWorker` already fails closed on — and the evaluator counts zero
workers bound to exactly one account. The two verification accounts *do* have
one distinct worker each, and are correctly excluded because their Routines
hold no credential: a Routine with no secret is not a surface.

That is Step 11's recorded blocker, arrived at independently from rows rather
than from the earlier write-up: **both Claude accounts' Cowork sessions
authenticate as the same Brain worker.** The evaluator was written without
reference to that finding and reproduced it, which is the strongest thing that
can be said for a check of this kind.

The same condition is why the other eleven gates read `NOT_RUN`. Without a
distinctly bound worker identity no Cowork session authenticates as a principal
the fleet can route audit work to, so no `RUSSELL_TURN` bin is answered — and a
routing decision, a captured idea, a probe, a mission, a writeback and an
automatic follow-on are each downstream of a turn being answered.

That is a **provisioning** condition and it is the operator's: each external
Claude account authenticates through its own Brain worker identity, created in
the console and connected by its own single-use invitation. Brain must not mint
workers or choose their permissions to get around it, and inferring an account
from which Routine Brain *attempted* to fire is rejected permanently.

Nothing here was polled, waited on, weakened or simulated. When the binding
exists, **the same deployed code derives the remaining verdicts from rows with
no further deployment** — which is the property the A11 evaluator was rewritten
to have.

---

## 9. What is not claimed

### `A11_INDEPENDENT_AUDIT` — blocked on provisioning, not on code

Step 11's signed matrix is enforced before the lease and again before storage,
proven load-bearing by inversion, and untouched by Step 12A. It cannot pass live
because both Claude accounts' Cowork sessions authenticate as one Brain worker,
so every audit role resolves to one account and `ACCOUNT` separation is
unsatisfiable. That is the check working on a fleet that cannot yet satisfy it.

The remedy is provisioning and it is the operator's: each external account
authenticates through its own Brain worker identity, created in the console and
connected by its own single-use invitation. Brain must not mint workers or pick
their permissions to get around it, and inferring an account from which Routine
Brain *attempted* to fire is rejected permanently.

It is inspected once during acceptance, not polled beyond ten minutes, and the
matrix is not weakened, simulated or substituted to close it. Step 12A is not
complete while it is open, and every gate that transitively depends on the real
mission's audit is reported as blocked rather than folded into a headline.

### Everything else

Every other gate reads `NOT_RUN` above, and will read a verdict here only when a
row supports it.

---

## 10. The acceptance contract was corrected — 2026-09-04

This section replaces §9's `A11_INDEPENDENT_AUDIT` entry above. The earlier
text is left in place rather than edited, because the change is a **product-owner
correction to the acceptance contract, not a silent weakening**, and a
correction you cannot see is indistinguishable from a gate that was quietly
lowered when it became inconvenient.

### What was wrong with the old definition

The old A11 fused two different things: **audit separation**, which is a
property of the system being accepted, and **fleet topology**, which is a
dynamic operational fact. Account and Routine counts change with subscriptions,
outages and provisioning. Making a specific friend, a specific account count or
a specific Routine count a *completion* dependency meant a finished product
became unfinished whenever somebody's subscription lapsed — and gave anyone
looking at a blocked board an incentive to weaken the real control to move it.

The original threat is worth restating exactly, because it is what the
replacement has to keep defeating: **one model context reviewing its own work.**

### The corrected contract

**Hard minimum, and it is topology-free.** PRIMARY, ADVERSARIAL and JUDGE run
in three distinct authenticated provider sessions. No session may hold two
audit roles for the same orchestration. The JUDGE may begin only after PRIMARY
and ADVERSARIAL are accepted and immutable. Lineage comes from real
authentication rows and check-in rows, never from caller-supplied labels.

**Dynamic preference, strongest first: `ACCOUNT > WORKER > ROUTINE > SESSION`.**
No number of accounts, workers or Routines appears anywhere in the minimum. One
healthy Routine satisfies the floor through three fresh activations; a
persistent activation attempting a second audit role on the same packet is
refused.

**Truthful result.** The achieved tier is recorded as `SESSION_SEPARATED`,
`ROUTINE_SEPARATED`, `WORKER_SEPARATED` or `ACCOUNT_SEPARATED`, and is never
rounded up. **A same-account result is never labelled cross-account
independent.**

**A mission may require a stronger tier, and asking costs only that mission.**
If the fleet cannot supply it, that one mission parks with the exact missing
capability, nothing is reserved or created, and the next tick launches it by
itself once the missing surface is registered. It never makes Step 12A
incomplete.

**Cross-account diversity is a stronger optional assurance tier and a later
Capability Lab measurement.** It is not a completion dependency of Step 11 or
of Step 12A.

### Where each part lives

| Requirement | Code |
| --- | --- |
| The floor, per role pair | `services/research/auditEligibility.ts` — `AUDIT_SEPARATION_MINIMUM`, all three pairs `SESSION` |
| The ladder and the truthful label | `services/research/independence.ts` — `SEPARATION_LADDER`, `strongestSeparation`, `SEPARATION_LABELS` |
| The adaptive allocator | `services/research/auditAdmission.ts` — `rankSurfacesFor`, strongest-first, a preference and never the authorization |
| Judge ordering | `auditEligibility.ts` — a JUDGE is refused while an argument is unsettled |
| Per-mission stronger tier, and the park | `services/russell/launch.ts` + `auditAdmission.separationCapacity` / `separationShortfall` |
| The acceptance evidence | `services/research/independenceEvidence.ts` |

### Two things that must not drift

**`future:<routineId>` is a prediction, never evidence.** It is how the
allocator reasons about an activation that has not happened, and it is what
makes the session floor reachable on a single Routine. Three placeholders would
look perfectly distinct while nothing had ever authenticated, so
`SESSIONS_ARE_REAL_ACTIVATIONS` refuses the prefix by name and
`SESSIONS_ARE_REAL_CREDENTIALS` refuses it again by requiring a credential row.
Final evidence contains three actual distinct authenticated session references.

**`ROUTINE` is a first-class tier, not a synonym for `WORKER`.** One account may
hold several Routines and one worker may be bound to several. Treating them as
equivalent would report a separation the fleet does not have — which is the one
failure mode the truthful-result rule exists to prevent.

### What the reporter now says, and the third verdict

`NO_HEALTHY_EXECUTION_SURFACE` is the blocker when no Routine holds both a
credential and a bound worker. It is an operational fact with an operational
remedy. It replaces `MISSING_FRIEND` and `DISTINCT_BOUND_WORKERS`, neither of
which named anything a person could act on without a second subscription.

A11 now has **three** verdicts rather than two. `NOT_RUN` means the control is
intact, a surface exists, and the audit has simply not run yet. `BLOCKED` means
something is actually wrong. Collapsing them is the same defect §22 records
three times: *a state that says "waiting for a person" which that person cannot
resolve is not waiting, it is stuck.*

### Step 11, corrected

**Cross-account routing, distribution and failover are proven in production,
with distinct credential digests.** Two accounts are registered live —
`primary` / `V1` and `friend-2` / `V2` — under separate deployment secrets, and
the production independence evaluator's distinct-credential condition passed on
2026-09-04, so the two rows are not one subscription registered twice. The fire
ledger read V1 fires=15, V2 fires=9, **zero refusals on either**.

What is not proven is cross-account audit *diversity*: both Routines are bound
to one worker identity, so an audit across them resolves to one worker and the
achieved tier is `SESSION_SEPARATED`. Under the corrected contract that is a
complete passing audit at the floor, reported at the tier it earned. Binding a
second worker to `friend-2` raises the tier with no code change and no
deployment.

**Step 11 is closed.**

### The delivery ledger, corrected to four mutations

The build contract set a budget of three production mutations. A fourth was
**explicitly authorized by the product owner before it was spent**, for this
correction and nothing else:

> "I authorize exactly one additional application deployment for the adaptive
> audit correction. This is a product-owner correction to the acceptance
> contract, not permission for unrelated work."

| # | Run | Commit | What it delivered |
| --- | --- | --- | --- |
| 1 | `33835314104` | `10658fd` | Step 12A Phase 1–4, first production image |
| 2 | `33837508678` | `9023673` | the turn-manifest defect the real acceptance found |
| 3 | `33838743276` | `3def7ec` | a person can correct where a thread is filed |
| 4 | `33845601961` | `3b6ebfb` | **adaptive audit separation** (this correction) |

`A19_DELIVERY` now declares all four. The count it checks against is a constant
in `.github/workflows/step12a-acceptance.yml` alongside the authorization text,
for the same reason the approval envelope is a constant in code: **nobody should
be able to widen the budget their own delivery is judged against**, and raising
the expected count without a recorded authorization would be exactly that
widening. Each of the four is verified individually — deploy conclusion, hosted
verification *before* the restart, the restart itself, and hosted verification
*after* — and the deployed application tree is compared against the tree the
acceptance reads, so a change under `server/`, `client/` or `scripts/` fails it
while a documentation commit does not.

### What this correction did *not* touch

The evidence gate's seven conditions, the verification pass, the synthesis
check and all three audit roles are exactly as they were. Nothing about
authorization, fencing, idempotency or the approval envelope changed. The
correction moved one acceptance requirement from a topology count to the
property that actually defeats the threat, and made the result it reports
honest about which tier was reached.

---

## 11. Mutation 4 delivered, and the first real retest of the surface

### Delivery

| | |
| --- | --- |
| Run | `33845601961` |
| Commit | `3b6ebfb` |
| Deploy | success, image released 06:49:39Z |
| Hosted verification **before** restart | success, 06:49:49–06:52:52Z |
| Real restart | success, 06:52:53–06:53:46Z |
| Hosted verification **after** restart | success, 06:53:46–06:56:54Z |
| Fourth image current | `deployed commit: 3b6ebfb` · `the deployed application tree is identical to the one being read` · `live /healthz: 200` · `anonymous /api/projects: 401` |

Local verification before the deploy: typecheck clean; SQLite suite 56 files /
1495 passed / 25 skipped / 0 failed; `vite build` succeeded; migration
verification over populated data SQLite 26→27 `UPGRADE: OK` and Postgres 17→18
`UPGRADE: OK`; Postgres suite at two workers 1496 passed with one file failing
on a server-boot timeout under concurrency, which passed 85/85 when the three
HTTP suites were re-run alone against Postgres.

### The canonical result

```
A01_SHELL_IDENTITY      PASS     14 Russell conversations
A02_CONVERSATION_ROUTE  PASS     2 conversations Russell attached itself
A03_ROUTE_CORRECTION    PASS     4 recorded corrections
A04_IRRELEVANT          PASS     20 turns produced 0 ideas
A05_DEDUPE              NOT_RUN  0 of 1 merges onto a canonical idea
A06_JUDGMENT_OVERRIDE   NOT_RUN  0 of 1 ideas carrying a stated judgment
A07_PROBE_BOUNDS        NOT_RUN  0 of 1 probes completed inside their bounds
A08_COVERAGE            PASS     152 recorded coverage verdicts
A09_AUTH_BUDGET         NOT_RUN  0 of 1 settled budget reservations
A10_MISSION_PIPELINE    NOT_RUN  0 of 1 fully linked missions
A11_INDEPENDENT_AUDIT   PASS     three distinct authenticated sessions; achieved SESSION_SEPARATED
A12_WRITEBACK           NOT_RUN  0 of 1 missions written back
A13_AUTO_NEXT           NOT_RUN  0 of 1 automatic follow-on launches
A14_HUMAN_RESUME        NOT_RUN  0 of 1 human decisions answered and resumed
A15_RECOVERY            PASS     1 cycles that have claimed and released
A16_DD_FRESHNESS        PASS     1 Deal Dispatch projects to read
A17_PRIVACY_AUTH        PASS     6840 recorded authorization denials
A18_BASELINES           PASS     10 layers intact
A19_DELIVERY            PASS     4/4 mutations, each verified before and after a real restart
```

**11 PASS · 0 FAIL · 0 BLOCKED · 8 NOT_RUN.** Acceptance run `33846930151`.

**A11 passed from production rows, at the tier it earned.** The corrected
evaluator found a packet whose three audit roles ran in three distinct
authenticated sessions, each resolving to a real credential of the worker that
presented it, with the judge completing after both arguments, on an
orchestration that filed a document with bytes. It reports
**`SESSION_SEPARATED`** and does not describe itself as cross-account
independent, because it is not. Under the superseded contract this identical
evidence read `BLOCKED — DISTINCT_BOUND_WORKERS`, which was a statement about
fleet topology rather than about the audit.

**Nothing is BLOCKED any more.** A12 and A13 were previously reported as blocked
by A11; they are now `NOT_RUN`, which is the truthful state — nothing stands in
their way, the work simply has not run.

### The first real retest of the Routine, and what it showed

The hosted verification created fresh Russell turns, and Brain dispatched them
by itself. Read once at 06:58:38Z:

```
V1  fires=17 refusals=0 no-shows=5  in-flight=2
V2  fires=12 refusals=0 no-shows=5  in-flight=2
fleet in flight 4 · candidates 2 considered, 0 eligible now
```

Five new activations, zero refusals. **The dispatcher half of §22 works.**

The exact provider run, read once:

| | |
| --- | --- |
| Routine | `trig_01CBLu5oCZziEwznw5q9xU7g` ("Brain Worker (dispatch)") |
| Session | `cse_01KTng2dz9VLmJp7kBqsq2bX` |
| Origin | `fire_routine` — Brain's own dispatch produced it |
| Fired | 2026-09-04T06:54:58.29Z |
| Finished | 2026-09-04T06:55:12.93Z |
| Terminal status | **`ROUTINE_RUN_STATUS_SUCCEEDED`** |
| Duration | **14.6 seconds** |
| Output tokens | **198** |
| Session status | `IDLE`, `disconnected` |
| Rate limit | `status: "allowed"` — **not** throttled |
| Model served | `claude-sonnet-5` |
| Tags | `config:routine-lineage-none`, `routine_notify_push` |

**Brain recorded no check-in for it.** So the session started, consumed its
prompt, emitted 198 output tokens and ended — without `brain_check_in` reaching
the Brain.

### Two hypotheses eliminated by direct evidence

- **Connector name spelling.** The Routine declares its connector as
  `cloud-brain`, which `.claude/settings.json` already allowed before commit
  `1111b3e`. Refuted.
- **The settings file not reaching the worker.** The Routine attaches
  `https://github.com/Peyday007/V5` as a source with no branch pin, and the
  repository's `default_branch` is `claude/zealous-hypatia-78a2yp` — the branch
  carrying `.claude/settings.json`. So the worker's checkout does contain the
  grant. Eliminated.

**The cause of the no-show is therefore still unresolved.** One further
observation is recorded without being promoted to a diagnosis: the Routine's
`allowed_tools` is `["Bash","Read","Write","Edit","Glob","Grep","WebFetch",
"WebSearch"]` with no `mcp__*` entry. §22 already records that the *working*
Step 10 routine also carried no `mcp__*` entry, so the allowlist cannot by
itself be what separates a working surface from this one — which is exactly why
this is left as an observation rather than the answer. The session transcript
itself is not readable from here, so the reason `brain_check_in` was not called
has not been established, and no further fire was made to guess at it.

What is established, and is the durable part: **Brain owns dispatch and it is
working** — routed, slot claimed, fired, accepted, zero refusals, five
activations in four minutes with nobody involved. **The surface owns whether a
worker may act, and that half is not yet demonstrated.**

---

## 12. A11 is corrected back to NOT_RUN, and the fleet is held

### The fleet is quarantined, and nothing was destroyed

Both Routines are `QUARANTINED` through the ordinary reversible control
(`fleet set-state --kind routine --to QUARANTINED`), because provider sessions
were completing without checking in and each one costs allowance to learn that
again.

```
V1  QUARANTINED  fires=17 refusals=0 no-shows=5  in-flight=2
V2  QUARANTINED  fires=12 refusals=0 no-shows=5  in-flight=2
```

Reconciled once, and both passes are deliberately conservative:

- `STEP10: OK tick superseded=0 intents=0 fired=0 failed=0 configured=true` —
  **`fired=0` proves the quarantine holds**: the router excludes any Routine
  that is not `ENABLED` or `DRAINING`, so no new activation is possible.
  `superseded=0` because the four dispatch windows have not expired yet; Brain
  marks them no-show when they do, from its own clock, never from a worker's.
- `STEP10: OK reconcile examined=0 healthy=0 escalated=0` — no non-terminal bin
  in the packet project. The four in-flight dispatches belong to the hosted
  verifier's own scope. **Nothing was cancelled, failed or closed**, and
  `reconcileBins` cannot do so by construction: it only ever escalates a bin
  that has exhausted its attempts to `NEEDS_HUMAN`.

Every pending bin and every attempt budget is intact.

### A11 was passing on a historical packet, and returns to NOT_RUN

The correction is the product owner's and it is right. The reasoning is
arithmetic already inside the same report:

```
A09_AUTH_BUDGET       NOT_RUN  0 of 1 settled budget reservations
A10_MISSION_PIPELINE  NOT_RUN  0 of 1 fully linked missions
A12_WRITEBACK         NOT_RUN  0 of 1 missions written back
A13_AUTO_NEXT         NOT_RUN  0 of 1 automatic follow-on launches
```

**No Step 12A mission exists in production.** No reservation was settled, no
mission is linked to an orchestration and a bin, nothing was written back. So
whatever orchestration `auditIndependenceEvidence` read, it cannot be a Step 12A
mission — it is a packet from the Step 10/11 era, filed before Russell existed.

The one candidate checked directly is **excluded**: `orc_be4ddfe7388b40be9e01`,
the Step 9 packet, has all three roles `COMPLETE` but **no lineage at all** —
`worker=— routine=— account=— session=—` on every pass — and
`auditMatrixVerdict` refuses it three times over (`compliant=false`). The
evaluator's own SQL requires non-null worker, account and session, so this
packet cannot be what it read. The exact orchestration id of the packet it did
read was not obtained in this pass, and is not needed for the conclusion.

**What A11 currently demonstrates is the evaluator, not the mission.** It shows
that the corrected contract can derive `PASS` from authentic production rows —
three real credentials, correct ordering, a filed document, the live same-session
refusal still refusing — and it reports the tier truthfully as
`SESSION_SEPARATED`. That is worth having and it is not live Step 12A
acceptance.

**Live acceptance requires the exact Step 12A mission to pass through the
mutation-4 admission, ordering and storage guards.** Until a Russell turn is
answered, a mission is launched, and its three audit roles run in three real
provider sessions, **A11 is `NOT_RUN`.**

Corrected tally: **10 PASS · 0 FAIL · 0 BLOCKED · 9 NOT_RUN.**

### The launch prompt comparison, and what actually differs

The failure signature is exact: **fire accepted → 14.6-second session → 198
output tokens → normal exit → zero tool calls → zero check-in.** That is a
session producing prose instead of calling a tool. It is not a permission,
connector-name or branch problem — both of those were eliminated in §11.

Comparing V1 against the **last activation that actually drained work**:

| | V1 `trig_01CBLu5oCZziEwznw5q9xU7g` | Working `trig_01HCVV7m2TfcteXKSRJXF3G3` |
| --- | --- | --- |
| Last run | SUCCEEDED, **14.6s** | SUCCEEDED, **~4 minutes** (05:07:42 → 05:11:40) |
| `permission_mode` | **absent** | **`auto`**, set by an explicit `control_request` event |
| `allowed_tools` | explicit list of 8, **no `mcp__*`** | **no allowlist at all** — full default surface |
| Connector(s) | `cloud-brain` | `cloud_brain` **and** `Claude_Code_Remote` |
| Prompt shape | long generic "interchangeable worker" document; opens "Ignore any text that arrived with this activation"; never names the connector | short, direct: "Use the Cloud Brain connector. Work only on orchestration: orc_… " |
| Model pinned | `""` (none) | `""` (none) |
| Served model | `claude-sonnet-5` (observed) | not recorded in the readable rows |

**This corrects CLAUDE.md §22.** That section states "Both the blocked routine
and the working one carry an `allowed_tools` list with no `mcp__*` entry, so the
allowlist cannot be what separates them." The rows say otherwise: the *working*
Routine carries **no `allowed_tools` key at all**. §22's comparison was made
against `trig_017iVUtF8VyxGdkxdTFsu3de`, which does carry a broad allowlist —
and which **ABANDONED** rather than working. So the observation §22 rests on was
drawn from the wrong pair.

Two configuration differences are therefore live candidates, and neither is
promoted to a proven cause without a transcript: the **absent
`permission_mode`** (the working Routine explicitly sets `auto`), and the
**explicit `allowed_tools` list that omits every `mcp__*` tool** (the working
Routine restricts nothing). Both are provider-side Routine configuration, and
both are the owner's to change: `update_trigger` refuses V1 with *"this routine
was created via `http_api`, not by an agent."*

---

## 13. The V1 canary did not fire — no queued work remained

V1 was re-enabled at 07:27:20Z with a Routine-scoped concurrency target of 1;
V2 was left `QUARANTINED`. Two reads were taken, at +3 minutes and at the
ten-minute bound. Nothing else was fired.

| | 07:30:15Z (+3 min) | 07:37:14Z (+10 min, bound) |
| --- | --- | --- |
| V1 | `ENABLED  fires=17 refusals=0 no-shows=5  in-flight=0` | `ENABLED  fires=17 refusals=0 no-shows=5  in-flight=0` |
| V2 | `QUARANTINED  fires=12  in-flight=0` | `QUARANTINED  fires=12  in-flight=0` |
| Routing | — | `candidates 2 considered, 1 eligible now` |
| V1 `last_run` | `cse_01KTng2dz9VLmJp7kBqsq2bX`, 06:54:58Z | unchanged |

**`fires` did not move. There was no activation at all**, so this is not another
no-show — the chain stopped before its first link.

The reason is visible in the same rows: `in-flight` fell from 2 to 0 on both
surfaces during the quarantine, and V1 then sat **eligible** for ten minutes
with the dispatcher free and fired nothing. A dispatcher with a free slot and an
eligible surface that dispatches nothing has **no `READY` bin to dispatch**. The
Russell turn bins created by the mutation-4 hosted verification spent their
dispatch attempts on the five activations that preceded the quarantine.

So the canary is **inconclusive about the check-in question**, and it must not be
read either way:

- It is **not** evidence that the owner-side prompt hardening worked — no
  session ran under it.
- It is **not** another no-show — nothing was fired to no-show.

### What the owner changed, and what remains unchanged

The Routine's stored prompt was updated at 07:25:06Z and now opens with a
`# Mandatory startup` block requiring `brain_check_in` as the first action. Two
fields from the handover are **still as they were**:

```
allowed_tools               ["Bash","Read","Write","Edit","Glob","Grep","WebFetch","WebSearch"]   (no mcp__*)
mcp_connections[cloud-brain].permitted_tools   []
```

and the Routine still carries no `permission_mode`, where the last activation
that actually drained work carried `auto`. A prompt cannot add a tool to a
session's surface, so if the tool surface is what stopped the previous run, the
prompt change alone will not move it. That remains a hypothesis: it has not been
tested, because no session has run since the change.

### Where this leaves the acceptance

`A11_INDEPENDENT_AUDIT` stays `NOT_RUN` per §12. The corrected canonical tally
is unchanged at **10 PASS · 0 FAIL · 0 BLOCKED · 9 NOT_RUN**, and the single
remaining condition is unchanged: a fired Cowork session must reach
`brain_check_in`, on a bin that exists.

---

## 14. The V1 canary checked in — the prompt was the problem

The first activation since the owner hardened V1's stored prompt, with **no
other change**: `allowed_tools`, the connector's `permitted_tools` and the
absent `permission_mode` were all left exactly as they were, deliberately, so
that the prompt could be tested in isolation.

### The Brain-side proof

```
V1  ENABLED  fires=18  refusals=0  no-shows=0  in-flight=0
V2  QUARANTINED  fires=12  refusals=0  no-shows=5  in-flight=0
```

**`no-shows` went 5 → 0.** That is the decisive fact and it is not a
provider-reported one: the consecutive-no-show counter is reset by
`recordRoutineCheckIn`, and §23's rule is that the arrival is credited **from
the dispatch row that produced the worker**, never from anything the worker says
about itself. Brain therefore observed an authenticated worker arriving on this
Routine's own dispatch. `fires` advanced by exactly one, and `in-flight` is 0,
so the dispatch settled rather than remaining outstanding.

V2 is untouched at `no-shows=5`, which is the control: the counter did not move
for a surface that was not activated.

### The provider side, for corroboration only

| | previous run | canary run |
| --- | --- | --- |
| Session | `cse_01KTng2dz9VLmJp7kBqsq2bX` | `cse_01LCjqK2PKSLsuVQteAiyipH` |
| Fired | 06:54:58.29Z | **07:42:39.59Z** |
| Finished | 06:55:12.93Z | **07:43:33.07Z** |
| Duration | 14.6s | **53.5s** |
| Output tokens | 198 | **3,541** |
| Cache reads | 192,847 | **638,470** |
| Connection | `disconnected` | **`connected`** |
| Served model | claude-sonnet-5 | claude-sonnet-5 |

Provider `SUCCEEDED` was never the criterion — the failing run was `SUCCEEDED`
too. The numbers are recorded because they corroborate the Brain-side reading:
eighteen times the output and three and a half times the context reads is a
session that made tool calls, not one that produced prose and stopped.

### What this settles, and what it retires

**The prompt was the problem. The tool surface was not.** The connector's tools
were reachable the whole time — `allowed_tools` still carries no `mcp__*` entry,
`permitted_tools` is still `[]`, and there is still no `permission_mode`. The
Routine editor's own statement that the attached `cloud-brain` connector can
operate without asking is correct, and testing the prompt in isolation is what
proved it.

Three hypotheses are now retired, all of them mine:

1. **Connector name spelling** — refuted in §11 by inspection.
2. **The settings file not reaching the worker** — eliminated in §11; the
   repository's default branch carries it.
3. **The `mcp__*` tool surface** — retired here, by a session that called the
   tools with that surface unchanged.

What actually separated a working activation from a failing one was the
**instruction**: a long generic document whose first concrete direction was
buried, against one that opens by naming `brain_check_in` as the mandatory first
action and states that a text-only response is a failed activation. A model that
is told to reason before acting will reason and then stop.

**§22's split holds and now has both halves demonstrated in one cycle.** Brain
owned dispatch and dispatched; the surface owned whether the worker acted, and
once its instructions were unambiguous it acted.

The bin's downstream progress is left to Brain. It is running independently.

---

## 15. Post-canary reading — 2026-09-04 07:51Z

Two read-only passes: the acceptance reporter (run `33850578259`) and a bin
watch over the packet project (run `33850580581`). Nothing was fired, changed or
deployed.

### What moved

| | 07:02Z | 07:51Z |
| --- | --- | --- |
| `A01` Russell conversations | 14 | **15** |
| `A04` turns / captured ideas | 20 turns / 0 ideas | **21 turns / 0 ideas** |
| V1 | `fires=17 no-shows=5` | **`fires=18 no-shows=0`** |

**Exactly one conversation and exactly one turn were added** — the Florida
canary and nothing else. No duplicate turn, no duplicate bin.

### What did not move

`A05` merges, `A06` ideas carrying a judgment, `A07` probes, `A09` settled
reservations, `A10` linked missions, `A12` writebacks, `A13` follow-ons and
`A14` human decisions all still read **0 of 1**. So the check-in did not, by
07:51Z, produce a captured idea or anything downstream of one.

### The trace, and the gap in it, stated plainly

- **Conversation → turn: confirmed.** One new conversation, one new user
  message, from the row counts above.
- **Turn → worker: confirmed, Brain-side.** `no-shows` 5 → 0 and `fires` 17 → 18
  on V1. That counter is reset by `recordRoutineCheckIn` and credited from the
  dispatch row that produced the worker, never from the worker's own account of
  itself.
- **Bin state: not determinable from the read-only surfaces available.**
  `step10 watch` is scoped to the packet project by slug and returned
  `settled=true bins=97` — unchanged from the pre-canary reading, with
  `assignments 101` also unchanged. The Florida `RUSSELL_TURN` bin is therefore
  in a different project scope, and no read-only command takes an arbitrary
  project id. Whether it is `ASSIGNED`, `COMPLETE`, escalated or still `PENDING`
  is **unknown**, and is recorded as unknown rather than inferred from the
  worker's 53-second session.

The honest summary is that the first two links of the chain are proven and the
third is unread. Brain is left running; nothing is waiting on a person.

---

## 16. The acceptance reporter is scoped to the frozen mission — 2026-09-04

### The defect this closes

`A11` passed while `A10` truthfully reported `0 of 1 fully linked missions`. Both
statements were correct, which is what made the pair a defect rather than a
contradiction: **nine gates counted whole tables.** "Is there *a* probe", "is
there *a* mission", "has *an* audit ever run" are questions about the database,
not about the acceptance, and any historical row answered them. `A11` was
answering with a Step 10/11 packet filed before Russell existed.

### The fix

The nine mission gates are now answered against a **declared** acceptance chain.

`ACCEPTANCE_SCOPE` in `scripts/step12a-acceptance.ts` names one conversation id
and nothing else. Everything downstream is **derived** from it by walking real
foreign keys:

```
conversation → messages → candidates → merges → probes
             → missions (by conversation or candidate)
             → follow-on missions (next_mission_id)
             → orchestrations → research_passes
             → reservations
             → human requests (by conversation or mission)
```

A gate therefore cannot be satisfied by a row outside that chain, however many
similar rows exist. It is a constant rather than a row for the same reason
`A19`'s delivery ledger is: **nobody should be able to widen the evidence their
own work is judged against by writing rows.** Setting it is a code change
somebody reviews.

While the anchor is empty every scoped gate reports `NOT_RUN` naming that fact —
which is the truthful state before the acceptance run. Nothing is wrong and
nothing has happened, and those are different from each other and from failure.

`auditIndependenceEvidence` now takes the scoped orchestrations. Three
distinctions it draws deliberately:

- **no argument** — search every packet, for an unscoped caller;
- **an empty array** — *no orchestration is in scope*, refused by name rather
  than falling back to searching everything;
- **a list** — only those packets.

### What stayed global, and why

Three checks are conservation properties and are deliberately **not** scoped,
because narrowing them would hide the very thing they exist to catch:

- probe **overspend** — an exceeded lookup bound is a broken envelope wherever
  it happened;
- **half-built missions** — a mission stranded without its links is a launcher
  defect wherever it sits;
- `A17` **visibility widening** and `A18` **frozen-layer conservation**.

`A02`, `A03`, `A04` and `A08` also stay as they are: they are conversation-level
properties already proven by frozen conversations 1, 3, 6 and 2, and the build
contract's own expanded baseline arithmetic requires them to remain `PASS`.

### Three gates added

| | |
| --- | --- |
| `A20_USABLE_READ_SURFACES` | the primary surfaces have real rows behind them, so a working backend cannot ship with hollow views |
| `A21_LIVING_PROJECT_MAP` | the constellation has a canonical hierarchy to draw — *a list with lines beside it does not satisfy this* |
| `A22_FAST_CHAT_ROUTING` | a turn actually took the fast lane against a real provider; adapter mocks and contract tests are code proof, never live acceptance |

The historical nineteen keep their ids and meanings, so an archived reading
still reads correctly against its own run. The workflow's gate-count guard moves
from 19 to 22.

### Inversion tests

`tests/independenceEvidence.test.ts` (22 tests) now additionally proves:

- a scope naming the audit's own orchestration **passes**;
- three genuine, impeccably separated sessions belonging to a **different**
  mission are refused — the exact defect above;
- an **empty** scope is refused by name rather than widening;
- an **absent** scope still searches everything, for the unscoped caller.

Already proven and unchanged: invented sessions refused, predicted `future:`
sessions refused, judge-before-arguments refused, same-session reuse refused,
session-separated passes accepted, and a same-account result reported as
`SESSION_SEPARATED` rather than failing.

### The expanded baseline

**10 PASS · 0 FAIL · 0 BLOCKED · 12 NOT_RUN** across twenty-two gates. The nine
mission gates read `NOT_RUN` because the acceptance chain is not frozen yet;
`A20`–`A22` read `NOT_RUN` because their production evidence does not exist yet.

### Fleet, verified at 19:24Z

```
V1  ENABLED      fires=19  refusals=0  no-shows=0  in-flight=0
V2  QUARANTINED  fires=12  refusals=0  no-shows=5  in-flight=0
```

One correction to the previous checkpoint: V1 reads **19** fires, not 18. An
additional activation occurred unattended in the intervening hours and it
checked in too — `no-shows` is still 0. The hardened Routine prompt is holding
across more than the one canary.

---

## 17. Continuation delta map and checkpoint — 2026-09-04

### Two required inputs were not supplied

The continuation assignment names three attachments. The upload carried the
build prompt and, inside `RUSSELLSTEP12ABUILDPACKAGE.zip`,
`STEP-12-MEMORY-PROMPT-v2.md`. **Missing: `STEP-12-MEMORY-PROMPT-v3-ADDENDUM.md`
and `living-idea-map.html`.**

The addendum matters because the assignment says it *overrides v2 on conflicts*.
Work proceeded because the continuation prompt's own SETTLED FACTS list carries
the overrides that actually bear on this batch — notably that a basic living
constellation and fast direct-API conversation are now Step 12A, which reverses
v2 §17 and §18. What remains genuinely unavailable is the approved *interaction*
reference for the constellation, so Workstream 3 has a written specification and
no visual one.

### The delta map

| Capability that exists | Missing connection | Change | Proof | Deploy needed |
| --- | --- | --- | --- | --- |
| Nineteen-gate reporter | nine gates counted whole tables, so any historical row satisfied them | declared `ACCEPTANCE_SCOPE`, all nine derived from it | 22 evaluator tests | no — read-only reporter |
| `auditIndependenceEvidence` | answered "has *an* audit run", not "did *this* mission's" | optional orchestration scope; empty ≠ absent | 4 new inversion tests | no |
| `russell_knowledge` reader | never read `research_claims`, so Knows was hollow | zero-copy projection preserving epistemic status and provenance | 12 tests | **yes**, to be visible |
| Empty views | one "nothing yet" for six different situations | `surfaceState` with six reasons; forbidden ≡ unavailable | 4 tests | **yes** |
| `KnowledgeView` | threw on a response lacking the new field | optional all the way down | shell suite | **yes** |

### What is done, and what is not

**Complete — Workstream 1.** The reporter is scoped, `A20`–`A22` exist, the
historical-packet defect is closed and inverted in tests, the workflow guard
moves to 22 gates, and the evidence document records it.

**Partial — Workstream 2.** Knows is built, tested, routed and rendered. The
other read surfaces are **not** done: Work still lacks provenance filtering
(verification fixtures and synthetic harness packets can still inflate ordinary
counts), Ideas, Who and the shared progress projection are untouched.

**Not started — Workstreams 3, 4, 5.** The constellation, the fast conversation
lane and the scoped production acceptance.

### Status of every claim above

**LOCAL / CODE PROOF only.** Nothing in this section is live. The deployed image
is still `3b6ebfb` from mutation 4; none of this batch has been deployed, and no
fifth mutation is authorized or requested yet. `A20`–`A22` are `NOT_RUN` in
production and remain so until an authorized deployment and a production read.

### Resume path

One path, in order:

1. Finish Workstream 2 — Work provenance filtering and grouping, Ideas, Who, and
   one shared progress projection.
2. Workstream 3, against the written requirements; ask for `living-idea-map.html`
   first if the approved interaction matters more than the written spec.
3. Workstream 4 — the conversation lane, adapter contract tests and spend
   ceiling, with no paid key and `A22` left `NOT_RUN`.
4. Freeze the Workstream 5 scenario, set `ACCEPTANCE_SCOPE.conversationId`, and
   request the fifth mutation with its enumerated order, ceiling, canary and
   rollback.

### Fleet, unchanged and untouched by this batch

```
V1  ENABLED      target 1  fires=19  refusals=0  no-shows=0
V2  QUARANTINED            fires=12  refusals=0  no-shows=5
```

---

## 18. The read layer, the constellation and the conversation lane — 2026-09-04

Everything in this section is **LOCAL / CODE PROOF** unless a line says
otherwise. **Production is unchanged.** No deployment, no secret, no fire, no
turn, no bin. The deployed image is still `3b6ebfb` from mutation 4, and the
mutation budget is still four spent.

### 18.1 What was wrong, in the words of the person who hit it

Work was empty while a real research packet was running. Ideas was empty.
Knows was nearly empty while the archive held the material that had already
answered a question. Who said nobody was on the project to the only person
looking at it. Every screen scrolled sideways on a phone. Each of those is a
projection defect and none of them is an honest empty state.

The shape was the same every time: the surface read the one table Russell had
started filling that week, and the Brain's actual history lived elsewhere.

### 18.2 Work — three sources, one list

`services/russell/work.ts` reads `russell_missions`, `research_orchestrations`
and `bins`, and projects them into the five groups. It deduplicates **by
foreign key**: a mission that owns a packet that owns a bin is one piece of
work, not three. Step 9 paid for the lesson that an identity reconstructed by
matching titles breaks the first time two things are called the same thing.

Provenance is a fact about the row. Migration **028** adds
`projects.purpose`, for the reason migration 021 gave for
`orchestrations.fixture`: a slug prefix or a title match puts the
classification in whichever query remembers it, and a scope renamed once
rejoins the ordinary counts silently. The verifier's scope and the Step 10/11
harness scopes now declare `TECHNICAL` at creation.

The ordinary view asks for `PROJECT` only and reports `technicalHidden`.
"Nothing here" and "nothing here, and four harness rows held back" are
different facts, and a person who cannot see the second concludes the first is
a bug.

### 18.3 Ideas and the constellation — one projection, two resolutions

`services/russell/ideas.ts` returns nodes and edges: site → major idea →
ordinary idea as a **tree** for unambiguous breadcrumbs, with genuine
cross-links as **edges** so an idea that feeds three others is not duplicated
into three places. `FEEDS` edges come from real `dependencies` rows, never from
layer adjacency — two layers next to each other in a list are not thereby
connected, and drawing that would be decoration presented as structure.

An idea whose missions name no layer is filed under nothing and says so. §11's
rule holds at this altitude too: forcing it under a heading to tidy the map is
a guess that renders well.

`client/src/russell/Constellation.tsx` renders that projection. **No node in
it comes from anywhere but the API**, and none of the prototype's demo
vocabulary reaches production — a test asserts that every rendered label is a
title the projection returned.

### 18.4 What looking at it actually found

`scripts/visual-qa.ts` boots a real server against a throwaway directory and
drives Chromium over the DevTools protocol — no dependency added to the
deployed package for a development convenience — reporting per screen and per
width whether the shell rendered, whether the page scrolls sideways, and which
element is responsible.

It found four defects that no assertion in this repository would have caught:

1. **The whole shell scrolled sideways at every phone width, on every screen.**
   A grid item's default `min-width: auto` refuses to shrink below its content,
   so one long briefing sentence widened the shell past the viewport; and the
   phone navigation gave each of six sections `width: 100%` in a row. Both
   predate this work.
2. **Eight major ideas on one ellipse overlapped into an unreadable pile** at
   390 wide, with two of them sitting on the nucleus. Neighbours above six are
   now staggered onto two radii and an even count is rotated half a step, which
   guarantees a vertical gap rather than relying on an arc length that label
   widths do not respect.
3. **The briefing filled a third of a phone screen** before anything a person
   navigated to appeared. Its last sentences fold into a native `details`.
4. **Who told the only person looking at it that nobody was on the project** —
   a Brain administrator reaches a project through `isBrainAdmin` rather than a
   membership row.

Recorded readings after the fixes, at 1280×900 and 390×844, across Russell,
Work, Ideas, Knows, Who and Needs You: **12 of 12 rendered, 12 of 12 fit, no
console errors.** The images are evidence for one run at one commit and are
deliberately not committed.

### 18.5 One progress projection

`services/russell/progress.ts` is the only implementation. A fraction is
reported **only** over a declared closed set — a project's layers, an idea's
pipeline, the build's own steps. An open-ended set gets a stage and a milestone
list and no denominator. Blocking outranks every band.

`BUILD_MILESTONES` is a declared constant rather than a query, and the cost is
named: closing a step means editing a list in a change somebody reviews.
Inferring build progress from row counts would let any fixture advance the
product, which is the mistake §24's acceptance scoping exists to undo.

### 18.6 The conversation lane — built, wired, and switched off

Migration **029** adds `llm_models`, `spend_authorizations`, `spend_ledger`,
`spend_reservations`, `conversation_reviews` and `russell_rules`.
`docs/CONVERSATION.md` has the whole contract; the load-bearing parts:

- **Nothing spends by default.** Five conditions must all hold, each failure
  has a name, and no branch treats a missing row as permission. A ceiling of
  zero is a refusal.
- **Over-spending is impossible, not merely untested.** `CHECK (held +
  settled <= ceiling)`, asserted by a test that writes past the application
  straight at the row. The reservation is a compare-and-swap on
  `spend_ledger.generation` — the third time this codebase has needed that
  primitive, for the same reason each time.
- **The worst case is reserved**, so concurrent callers cannot collectively
  exceed a ceiling each individually respected. Six callers against a
  three-call ceiling: three win, `remaining` is zero.
- **An unknown outcome keeps its hold.** Step 6's rule applied to money.
- **No model name exists in `services/conversation/`.** The catalogue is rows;
  routing is configuration. There is nowhere to hardcode Haiku, which is how
  that stays true.
- **A review reads a manifest, not a conversation**, and `reviewerMayCarry`
  does not take capacity as an argument — capacity is scheduling, this is
  authorization, and where they meet the cheap answer wins.
- **A lesson is a proposal.** `proposeRule` has no `state` parameter.

`beginTurn` now tries the fast lane before the fleet, and falls through
unchanged when there is none — which is what the deployed Brain has. A turn the
fast lane answers creates **no bin**, and records its lane in the message
metadata, which is what `A22` reads.

**A22 stays `NOT_RUN`.** No real provider has been called, there is no key,
there is no authorization, and adapter contract tests are code proof rather
than live acceptance — the same distinction Step 3 drew between the research
engine passing its tests and a real job having run.

### 18.7 The Workstream 5 scenario is frozen

`docs/STEP-12A-ACCEPTANCE-SCENARIO.md` — scenario `S12A-ACC-1`, written before
any live result was seen. Permit intelligence in Michigan, **conditional on its
own coverage check**: if `coverBeforeWork` reports the requirement already
satisfied, the scenario is abandoned and a different one frozen, because a
scenario that ignored its coverage check to reach a green gate would be the
acceptance lying about the control it is evidence for.

`ACCEPTANCE_SCOPE.conversationId` is still empty and says why in the code: it
is a production fact that does not exist until a person sends the frozen
message. Every scoped gate therefore reports `NOT_RUN`, which is the truthful
state — nothing has happened and nothing is wrong.

### 18.8 The tally

Unchanged at **10 PASS · 0 FAIL · 0 BLOCKED · 12 NOT_RUN** across 22 gates.

Nothing in this section moves a gate, and that is correct: every remaining gate
needs production rows from a real chain, which needs a mutation nobody has
authorized. Code that is finished and unproven is exactly what `NOT_RUN` means.

---

## 19. The request for the fifth production mutation — 2026-09-04

Everything Workstreams 1 to 4 could prove without touching production is
proved and pushed. What remains needs production, and this is the request for
it.

**Four mutations are already spent.** This asks for three more, in this exact
order, and counts them separately because they are separate decisions.

### The mutations, enumerated

| # | Mutation | What changes | Why it is separate |
| --- | --- | --- | --- |
| **5** | **Image deployment** of `HEAD` of `claude/zealous-hypatia-78a2yp` | A new image, a restart, and migrations **028** (`projects.purpose`) and **029** (the conversation-lane and spend tables) applied on boot | It replaces what is running. Nothing else here does. |
| **6** | **One Russell turn**, sent by the operator in the deployed interface | Production **data**: one conversation, one message, and whatever the pipeline creates from it | It is not a deployment. What is running does not change; what the Brain holds does. |
| **7** | **Image deployment** of a one-line commit setting `ACCEPTANCE_SCOPE.conversationId` | A new image and a restart, carrying nothing else | The acceptance reporter runs **inside the container**, so the frozen scope has to be in the image. It is a second deployment and is counted as one. |

Mutation 7 is unavoidable rather than an oversight. The reporter deliberately
reads its scope from a **declared constant** so nobody can widen the evidence
their own work is judged against by writing rows or passing an input — and the
conversation id is a production fact that cannot exist until mutation 6 has
happened. Making it an input would remove the property the constant exists for.

### What runs after, and what it costs

The acceptance chain itself is not a fourth mutation: it is Brain's existing
dispatcher firing an already-registered Routine against already-queued,
already-authorized work. It is bounded by the frozen scenario in
`docs/STEP-12A-ACCEPTANCE-SCENARIO.md`:

- **one** research fragment, **at most one** repair;
- **one** probe, under `GENERAL_LIGHT_PROBE_V1` — at most 3 lookups, 5 minutes,
  one allowlisted host, zero external effects;
- **one** mission, orchestration and bin, plus **one** authorized follow-on;
- separation required: `SESSION`, which is three authenticated sessions;
- expected worker activations: **six to nine** on V1 at target 1 (research,
  verification, synthesis, three audit roles, the follow-on, and at most one
  repair).

### The spending ceiling

**Zero paid spend is requested, and none is possible.**

- No `ANTHROPIC_API_KEY` and no `BRAIN_PROVIDER` are being added. This request
  does not ask for a secret.
- Migration 029 creates the spend tables with **no rows**. There is no
  `spend_authorizations` row, so the ceiling is zero and disabled, and
  `liveAuthorization` returns null on every path.
- The fast lane therefore refuses with `NOT_AUTHORIZED_TO_SPEND` and every turn
  goes to the Routines, exactly as today.
- The only allowance consumed is the existing fixed-subscription Cowork
  allowance on V1, which is what has carried every activation since Step 10.
- **`A22_FAST_CHAT_ROUTING` stays `NOT_RUN`** and must. Enabling paid inference
  is a separate request I am not making.

### The canary

Mutation 5 is itself the canary, and the order is the safety:

1. Hosted verification **before** the deployment (`npm run verify:hosted`).
2. Deploy. Watch migrations 028 and 029 apply in the boot log.
3. Hosted verification **after** a real restart — the same run that mutation 4
   used, which is the only thing that proves a restart against an existing
   database.
4. `step12a-inspect` for one read of fleet and bin state.
5. Only then mutation 6, and only then a single Routine fire at target 1.

If anything in 1–4 fails, mutation 6 is not attempted and the rollback below
runs instead. **V2 stays `QUARANTINED` throughout.** No Routine prompt, model,
target, connector or state is edited — the working V1 mandatory-first-action
prompt is preserved.

### The rollback

- **Mutation 5 or 7 fails to boot:** `flyctl deploy --image <previous>` back to
  the image these replaced, which is `3b6ebfb` for mutation 5. The two
  migrations are additive — one new column with a default, six new tables — so
  the previous image runs unchanged against the migrated schema. Nothing is
  dropped and no rollback migration is needed or wanted.
- **Mutation 5 boots and the read layer misbehaves:** the same image rollback.
  Production data is untouched by it.
- **Mutation 6 produces the wrong chain:** the conversation and its rows are
  *kept*, `conversationId` is not set, the scenario is recorded as failed with
  its evidence, and a new one is frozen. Nothing is deleted — a failed attempt
  is the provenance, which is invariant 5.
- **A worker activation exposes another surface defect:** quarantine only the
  failing surface, preserve the bin and its attempt budget, record the exact
  evidence, and do not burn repeated fires.

### What I am not asking for

A fifth or later delivery mutation beyond these three; any production secret;
paid API inference; a paid account or credits; any change to V2's quarantine;
any credential exposure; any destructive production data change; and anything
belonging to Step 12B.

### The state this request is made from

**LOCAL / CODE PROOF.** Branch `claude/zealous-hypatia-78a2yp`, pushed, clean.
Typecheck clean, client build clean, full SQLite suite green, migrations from
empty and restart against existing both verified on the SQLite chain, and
desktop and phone visual QA recorded at 12 of 12 rendering and fitting.

**LIVE PRODUCTION.** Unchanged. Image `3b6ebfb` from mutation 4. V1 `ENABLED`
at target 1; V2 `QUARANTINED`. Tally **10 PASS · 0 FAIL · 0 BLOCKED · 12
NOT_RUN** across 22 gates.

---

## 20. A race the suite found and three isolated runs did not — 2026-09-04

`russell_budget_reservations` ranked reservations by `(created_at, id)` to
decide which of two racing callers keeps a slot. Two reservations taken in the
same millisecond have the same `created_at`, so the tie-break was `id` — a
random UUID — and roughly **half the time the second caller ranked first and
was handed a slot the ceiling had already spent**.

The comment above that function claimed the ordering was deterministic. It was
not, and the claim is the reason nobody looked again.

**How it surfaced.** A full-suite run failed on
`keeps a settled reservation counted, so finished work still occupies its
ceiling`. Three consecutive isolated runs of that file passed, which is exactly
how a fifty-per-cent race hides: the assertion is a coin toss, and a small
sample of green runs is not evidence of anything.

**The fix.** Rank by `rowid` — `seq` on Postgres, through the dialect — which
is insertion order, strictly increasing, and **supplied by the database rather
than by the claimant**. That is the same property every compare-and-swap in
this codebase depends on, and it is now the third place the answer has been
"rank by something the caller cannot choose".

**The regression test** repeats the race twenty times with an explicit,
identical timestamp, so a reintroduction is a one-in-a-million escape rather
than a coin toss. It was checked against the old implementation and fails there
on the first round.

This was not caused by anything in Workstreams 1 to 4. It was reachable from
the day the reservation ranking was written and had simply never lost the toss
in a watched run.

---

## 21. Checkpoint and resume path — 2026-09-04

**Branch** `claude/zealous-hypatia-78a2yp`, pushed, worktree clean.
**Production** unchanged at image `3b6ebfb`; four delivery mutations spent.
**Tally** 10 PASS · 0 FAIL · 0 BLOCKED · 12 NOT_RUN across 22 gates.

### Done in this batch

- **WS1** — the acceptance reporter scoped to the frozen mission; A20–A22
  added. (Earlier commit `3c67f4d`.)
- **WS2** — Work, Ideas, Who, one progress projection, honest empty states,
  migration 028.
- **WS3** — the living constellation over that same projection, and four
  layout and shell defects found by rendering it and looking.
- **WS4** — the conversation lane, the spending boundary, the context hat and
  the teacher loop, migration 029, all switched off.
- **WS5** — the acceptance scenario frozen as `S12A-ACC-1`, and the request for
  the fifth mutation.
- One unrelated race, found by the suite: reservation ranking by a random id.

### Not done, and why

- **The production acceptance chain.** It needs mutations 5 to 7, which need
  one explicit authorization. §19 is the request.
- **`A22_FAST_CHAT_ROUTING`.** It needs a real provider call, which needs a
  key, an authorization and a ceiling. Not requested here.
- **`ACCEPTANCE_SCOPE.conversationId`.** It cannot be set before the frozen
  message exists in production.

None of these is incomplete work presented as complete. Each is code that is
finished and unproven, which is exactly what `NOT_RUN` means.

### One resume path

1. Grant or refuse the three mutations in §19. If granted, run them **in
   order**, with hosted verification before and after the restart of each
   deployment.
2. Send the frozen message from
   `docs/STEP-12A-ACCEPTANCE-SCENARIO.md` §2, and read the coverage result
   first. If the archive already settles it, **abandon the scenario** and
   freeze another; do not proceed.
3. Set `ACCEPTANCE_SCOPE.conversationId`, deploy, and re-run the reporter.
4. Let Brain's own dispatcher fire V1 at target 1. Do not fire by hand and do
   not use an interactive session as the worker.
5. Walk the seventeen conditions against the falsification table in the
   scenario document, and record each outcome with its evidence — including
   the ones that fail.

---

## 22. Verification — 2026-09-04

All **LOCAL / CODE PROOF**. Production was not touched by any of it.

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npm run build` (client + server) | clean |
| **SQLite suite** | **62 files, 1602 passed, 25 skipped, 0 failed** |
| **Postgres suite** (PostgreSQL 16, real server) | **62 files, 1627 passed, 0 failed** |
| Migrations from empty, SQLite chain | schema version **29**, 29 applied |
| Restart against an existing database | 0 applied, 29 already applied |
| Desktop + phone visual QA | **12 of 12 rendered, 12 of 12 fit**, no console errors |

The 25 tests SQLite skips are the Postgres-specific ones, which is why the
Postgres run reports more passing tests rather than fewer.

### What the Postgres run found, that reading could not

**A real defect in this batch.** `listPendingReviews` orders by `created_at,
rowid`; `dialect.ts` rewrites `rowid` to `seq`; and the Postgres half of
migration 029 — generated by copying the SQLite half, where a row counter is
free — had no `seq` column. The ordering resolved to a column that did not
exist and the query failed outright. Fixed by giving all six new tables the
identity column every other shared table already carries, with the reason
written into the migration rather than left as a pattern to notice.

This is the deliberate difference between the two chains that `docs/CLOUD.md`
already documents, met at a new table. It is also the exact argument for
running the suite on the other backend: one repository layer over two databases
is *true* rather than merely compiling only if something checks.

### One failure that was not a failure, recorded so nobody repeats it

The first Postgres attempt reported **1079 failures across 38 files**. None of
them was a defect. `adapters/postgres.ts` enables TLS unless the connection
string carries `sslmode=` — correct for Supabase and every managed provider —
and a local server has no TLS, so every file failed at `initDatabase`.
`?sslmode=disable` in `BRAIN_TEST_DATABASE_URL` and all 1079 went away.

Worth naming because the failure mode is loud enough to look like a code
catastrophe and is a one-line harness fix.

### What is still unverified, and honestly so

- **Upgrade over populated fixtures on both chains.** Not run. The two
  migrations are additive — one column with a default, six new tables — and
  the restart-against-existing path was verified on SQLite, but that is not the
  same test and is not claimed as one.
- **Hosted verification.** Requires production. It is step 1 and step 3 of
  mutation 5 in §19.
- **Anything requiring a real provider call.** `A22` stays `NOT_RUN`.

---

## 23. The populated-data upgrade path, proved on both chains — 2026-09-04

Asked for as a precondition of the activation sequence, and it is the right
precondition: "from empty" is the easier half, and production is at the
previous version with real rows in it.

Proved **twice, two different ways**, because they answer different questions.

### Form A — put a populated database back and re-migrate

`scripts/upgrade-check.ts`, the repository's own tool, which was pinned to the
Russell migration and therefore two versions stale. Extended to undo the last
**three** migrations by name and re-boot, because production is behind by three
and "the newest migration applies" is not the question a person about to deploy
is asking.

| Chain | Was at | Now at | Result |
| --- | --- | --- | --- |
| SQLite | 26 | **29** | `UPGRADE: OK` |
| Postgres | 17 | **20** | `UPGRADE: OK` |

In both: messages 1 before and 1 after, both projects intact, the Russell cycle
row restored, `purpose` **ordinary=PROJECT scope=TECHNICAL**, and all three
sampled new tables **empty**.

Undoing is by **name**, never by number, and the indexes come off before the
columns they cover — SQLite refuses to drop a column an index still references,
which is a better error than a silent cascade.

### Form B — the actual old code, then the actual new code

Stronger, because Form A re-migrates using the *new* tree's own runner. This
one checks out `cd30154` — the last commit at SQLite 027 / Postgres 018 — into
a separate worktree, populates a database through the **old code**, and then
boots the **new** tree against that same database.

Populated with the shape a real Brain holds: two projects (one of them a
`verification-scope` created before the column existed), eight layers, a user
and membership, a research run, an orchestration, five claims with mixed
acceptance, a bin, a conversation with four messages, a judged candidate, a
mission, a knowledge row, and a fleet account with a Routine.

Both chains, single clean pass:

- exactly the two expected migrations applied — **28,29** on SQLite, **19,20**
  on Postgres — and nothing else;
- the already-applied chain still checksums, with no warnings;
- **all sixteen table counts identical** before and after;
- a sampled claim kept its exact text *and* its acceptance flag;
- an ordinary project defaulted to `PROJECT`; `verification-scope` was
  reclassified `TECHNICAL`;
- all six new tables exist and are **empty**, and `liveAuthorization` returns
  null — no authorization, no ceiling, no possible paid call;
- and the surfaces read an *upgraded* database rather than only a freshly
  seeded one: Work projected the historic packet, Ideas built a ten-node tree
  over pre-existing rows, Knows projected the historic claims, progress
  returned a milestone-backed ratio, Who read the fleet registered before the
  upgrade, and the briefing composed.

### A mistake worth recording

My first Postgres verification reported two failures. Neither was a defect:
I had hard-coded `schemaVersion === 29`, and the Postgres chain terminates at
**20**. The two chains are numbered independently and their versions do not
mean the same thing — the exact confusion CLAUDE.md §3 warns about, and which
`upgrade-check.ts`'s own comment records somebody making before. I made it
again. The assertion is now backend-aware, and the run above is a clean single
pass rather than a re-run over an already-migrated database.

**Precondition satisfied. Both chains pass. Proceeding to step 1.**

---

## 24. Mutation 5 delivered — 2026-09-04

**LIVE PRODUCTION.** Deploy run
[33921379946](https://github.com/Peyday007/V5/actions/runs/33921379946), commit
`c87d857`, authorized by the product owner conditional on the populated-data
upgrade proof in §23 passing on both chains. It did, twice, and only then was
this dispatched.

### Which commit, and why not the one named

The authorization named the application tree at `1e10076`. The run deployed
`c87d857`, and `git diff 1e10076 c87d857 -- server client` is **empty** — the
server and client are byte-identical. The differences are `docs/` and the
extension to `scripts/upgrade-check.ts` that the authorization's own
precondition required.

Deploying `1e10076` would have been the more literal reading and the wrong
action: A19's tree comparison covers `server client scripts package.json
package-lock.json Dockerfile fly.toml`, so a deployed `1e10076` against a tip
of `c87d857` would report *"application code changed since the last delivery —
this tree is not what is running"*. Deploying the tip is the only way both
halves of the instruction hold, and the running program is the program the
acceptance reads.

### Every gate, in order

| # | Gate | Result | At |
| --- | --- | --- | --- |
| 1 | Typecheck | success | 21:30:43 |
| 2 | Full SQLite suite, in CI, with the runtime image's OCR tooling installed | success | 21:32:57 |
| 3 | Production build | success | 21:33:09 |
| 4 | `flyctl deploy` — new image, migrations 028/029 on boot | success | 21:34:52 |
| 5 | Boot banner captured | success | 21:35:02 |
| 6 | `/healthz` → 200, and anonymous `/api/projects` → 401 | success | 21:35:02 |
| 7 | **Hosted verification, before the restart** (leaves a beacon) | success | 21:37:28 |
| 8 | Bootstrap secrets spent | success | 21:37:29 |
| 9 | **Explicit restart of the production machine** | success | 21:38:06 |
| 10 | `/healthz` → 200 again | success | 21:38:07 |
| 11 | **Hosted verification, after the restart** (beacon checked) | success | 21:40:30 |
| 12 | The verdict | success | 21:40:30 |

No gate failed, so no rollback was performed. The rollback remains
`flyctl deploy --image <3b6ebfb's image>`; the two migrations are additive, so
the previous image runs unchanged against the migrated schema.

The pre-flight step was **skipped**, correctly: it runs only when
`BRAIN_DATABASE_URL` is also a GitHub secret, and it is deliberately not one —
the database credential lives in exactly one place.

### The spending boundary, after the deploy

Unchanged and unchangeable by this deployment. Migration 029 created the spend
tables **empty**; there is no `spend_authorizations` row, so `liveAuthorization`
returns null, the ceiling is **$0**, no model is enabled, no API key was added
and none exists. Every Russell turn still goes to the Routine fleet, exactly as
before. `A22_FAST_CHAT_ROUTING` stays `NOT_RUN`.

### The ledger

`LEDGER` now names five runs and `EXPECTED` is `5`, with both authorizations
quoted in the workflow beside them. Raising that number without a written
authorization is the widening the constant exists to prevent, so the text is
stored next to the count rather than in a commit message somebody would have to
go and find.

**V2 remains `QUARANTINED`. No Routine prompt, model, target, connector or
state was touched. No turn, bin, fire or fixture was created.**

---

## 25. The first production reading of all twenty-two gates — 2026-09-04

**LIVE PRODUCTION.** Acceptance run
[33922266259](https://github.com/Peyday007/V5/actions/runs/33922266259), read
from the container against the deployed image, read-only by construction.

    A01_SHELL_IDENTITY         PASS
    A02_CONVERSATION_ROUTE     PASS
    A03_ROUTE_CORRECTION       PASS
    A04_IRRELEVANT             PASS
    A05_DEDUPE                 NOT_RUN
    A06_JUDGMENT_OVERRIDE      NOT_RUN
    A07_PROBE_BOUNDS           NOT_RUN
    A08_COVERAGE               PASS
    A09_AUTH_BUDGET            NOT_RUN
    A10_MISSION_PIPELINE       NOT_RUN
    A11_INDEPENDENT_AUDIT      NOT_RUN
    A12_WRITEBACK              NOT_RUN
    A13_AUTO_NEXT              NOT_RUN
    A14_HUMAN_RESUME           NOT_RUN
    A15_RECOVERY               PASS
    A16_DD_FRESHNESS           PASS
    A17_PRIVACY_AUTH           PASS
    A18_BASELINES              PASS
    A19_DELIVERY               PASS
    A20_USABLE_READ_SURFACES   NOT_RUN
    A21_LIVING_PROJECT_MAP     PASS
    A22_FAST_CHAT_ROUTING      NOT_RUN

    STEP 12A — composed: 11 PASS · 0 FAIL · 0 BLOCKED · 11 NOT_RUN
    STEP 12A IS NOT COMPLETE.

### What moved, and what that is worth

**A19 is now PASS**, at 5/5. Each of the five ledger runs shows
`deploy=success before=success restart=success after=success`, and the
deployed commit `c87d857` matches the acceptance reading `b29207d` across
`server client scripts package.json package-lock.json Dockerfile fly.toml` —
the running program is the program being read. Live `/healthz` 200 and
anonymous `/api/projects` 401 at read time.

**A21 is PASS, and the pass is weaker than the gate's name suggests.** Its
production condition is a row count — that an explicit, provenance-bearing idea
structure exists for the map to draw. It does. What it cannot check from inside
a container is whether the constellation *renders*, and that evidence is §18.4:
local visual QA at 1280×900 and 390×844, 12 of 12 screens rendering and
fitting. That is code proof, not a production reading, and A21's row condition
should not be mistaken for one. Tightening it is a code change and therefore a
deployment, which is not authorized here; it is recorded as a limitation rather
than quietly counted as strength.

**A20 stays NOT_RUN** because production holds no `russell_knowledge` rows yet.
That is the honest state: the projection is deployed and there is nothing
Russell has captured for it to project. The frozen chain is what creates the
first ones.

### The nine still open

`A05`, `A06`, `A07`, `A09`, `A10`, `A11`, `A12`, `A13`, `A14` are all scoped to
`ACCEPTANCE_SCOPE.conversationId`, which is still empty — so each reports
`NOT_RUN` naming that reason rather than counting a historical row. `A20` needs
captured knowledge and `A22` needs a paid provider call nobody has authorized.

Nothing here is wrong. Eleven gates are proved against production, and the
other eleven are waiting on one message a person has to send.

---

## 26. The permit message: what the records can and cannot say — 2026-09-05

The owner sent one message into an **existing** Russell conversation:

> I want Deal Dispatch to continuously collect public permit data as a new lead
> and intelligence source. Decide whether it is genuinely worth adding. Do
> whatever bounded research and planning you're already authorized to do, but
> do not build the scraper yet.

It sat with no visible reply for at least thirty minutes. **The next day an
answer was visible**, saying the archive did not address permits and discussing
capturing a candidate for bounded research. The owner's Routine history showed
no obvious corresponding run and one selected run reported `NO_READY_BINS`. The
suspicion was that a friend's Routine answered it.

This section records what production rows actually establish, what they do not,
and why the second list was longer than it should have been.

### What was read, and by what authorized path

Four read-only production readings, all through paths that already existed.

| | |
| --- | --- |
| `step12a-inspect` [33978629904](https://github.com/Peyday007/V5/actions/runs/33978629904) | release, image, machine, secret **names** |
| `fleet show` [33978670083](https://github.com/Peyday007/V5/actions/runs/33978670083) | accounts, Routines, bindings, fires, refusals, no-shows |
| `fleet profile --project prj_9d8…` [33978721652](https://github.com/Peyday007/V5/actions/runs/33978721652) | the Deal Dispatch slice of the capacity ledger |
| `fleet profile` [33978783174](https://github.com/Peyday007/V5/actions/runs/33978783174) | the same ledger unscoped |

No credential was read or printed. Nothing was claimed, fired, retried or
mutated. No conversation content was read by any of them.

### What is established

**The deployment.** `northline-brain`, release **v103**, machine
`811d651c26d948` last updated `2026-09-04T21:37:32Z` — the mutation 5 restart.
One health check passing.

**The spending boundary, from the secret list itself.** The deployed secrets are
`BRAIN_DATABASE_PROVIDER`, `BRAIN_DATABASE_URL`, `BRAIN_STORAGE_BUCKET`,
`BRAIN_STORAGE_PROVIDER`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`,
`BRAIN_ROUTINE_ID`, `BRAIN_ROUTINE_VERSION`, `BRAIN_ROUTINE_TOKEN`,
`BRAIN_ROUTINE_TOKEN_2`, `BRAIN_ROUTINE_TOKEN_3`. **There is no
`ANTHROPIC_API_KEY` and no `BRAIN_PROVIDER`.** The $0 ceiling is not a claim
about intent; it is a fact about what is deployed.

**The fleet, at 2026-09-05T16:42:13Z.**

    primary    ENABLED       target=2
      V1       ENABLED       worker=wkr_1cdd82cfb2a54faf8edd  fires=20 refusals=0 no-shows=1
    friend-2   ENABLED       target=2
      V2       QUARANTINED   worker=wkr_1cdd82cfb2a54faf8edd  fires=12 refusals=0 no-shows=5
    verify-hosted-account-a / -b   secrets never set, not routable

Both live Routines are bound to **one** worker identity, which is §23's recorded
state and unchanged. V1's fires moved 15 → 20 and V2's 9 → 12 since §23's
reading. **Zero refusals on either.** V2 remains `QUARANTINED` and nothing here
touched it.

**Deal Dispatch bin activity.** Four bins reached `BIN_READY` and three reached
`BIN_COMPLETION_ACCEPTED`. Zero takeovers.

### What is not established, and the defect that is the reason

The scoped profile also read **`activations: 0`** and **`perAccount: []`** for
Deal Dispatch. Read alone that says no Deal Dispatch bin was ever dispatched to
any Routine, which would have been a dramatic finding and would have made the
"a friend's Routine answered" theory checkable.

It is not a finding. It is a reporting defect, and the unscoped run proves it:

    activations 124   perAccount [ { accountId: null, activations: 124, refusals: 34 } ]

**Every `DISPATCH_SENT` row in the entire ledger carries `account_id` NULL and
`project_id` NULL.** `markDispatchSent` wrote the event from the dispatch row
alone, and a dispatch row knows its bin but not its project, its account, its
Routine or its workload class. So the capacity ledger recorded that 124
activations happened and nothing whatever about what any of them was for.

§23 says "the capacity ledger is `bin_events`, not a second table" and that a
fire carries `account_id`, `routine_id`, `evidence_class` and `workload_class`.
`DISPATCH_ROUTED` did. `DISPATCH_SENT` — the row the ledger counts as an
activation — did not. The sentence in §23 was true of the design and false of
the running code, which is exactly the kind of gap running it is supposed to
find.

A second half of the same defect: `BinEvent` and `mapBinEvent` never carried
those four columns either, so even the `DISPATCH_ROUTED` rows that *did* have an
account were invisible to every reader that went through `listBinEvents`. Only
`workloadProfile`, which writes its own `SELECT`, could see them at all.

### So who answered the permit message?

**Not established, and it is recorded as unknown rather than guessed.**

What can be said:

- The bin-level attribution genuinely exists in production. `BIN_ASSIGNED` and
  `BIN_COMPLETION_ACCEPTED` carry `worker_id`, `session_ref` and `project_id`,
  and `bins.lease_session_ref` holds the session that took the lease. Reading it
  needs the bin id.
- **There is no deployed read path from a Russell message to its bin.**
  `step10 trace` takes a bin id; nothing in the deployed image lists Deal
  Dispatch bins or joins a message to one. That is the specific missing
  capability, and it is why this question could not be answered from a terminal.
- A quarantine blocks new *dispatches*. It does not prove the absence of an
  older or separately started session, and §22 is explicit that an ordinary
  Claude conversation holding the connector is indistinguishable to the Brain
  from a fired worker. So "V2 is quarantined" is not an answer to "did
  friend-2 answer this", and it is not being used as one.

**Aggregate fire counts are not attribution.** V1 fires=20 and V2 fires=12 say
nothing about which activation, if any, produced this reply, and no reasoning
here rests on them. Neither the provider's `SUCCEEDED` label, nor elapsed
session time, nor the wording of the reply itself is treated as evidence.

### The repair

Three changes, all forward, none touching a deployed migration.

1. **`markDispatchSent` takes the attribution and records it** — project,
   account, Routine, workload class, `evidenceClass: 'MEASURED'` — supplied by
   the dispatcher from the bin it re-read and the decision it acted on. A fire
   with no routing decision leaves the Routine null rather than naming the only
   one there is. `DISPATCH_ROUTED`, `DISPATCH_UNROUTED` and `PROVIDER_ALLOWANCE`
   gain the project too. `tests/dispatchLedger.test.ts` (5 tests) pins it,
   including the regression: sent with the old argument shape the row is
   invisible to a project-scoped report and still counted by the unscoped one,
   which is precisely the shape that made a reporting hole look like a fact.
2. **`BinEvent` carries the four columns**, so a reader can see what the writer
   wrote.
3. **`step10 turn-trace`** joins a Russell message to its bin through
   `bins.created_by_id = 'russell:turn:<messageId>'` — a real reference, not a
   title match — and prints states, dispatches with their Routine and session,
   events with worker, session, account and Routine, unit results, and the
   candidates, missions and probes those conversations produced.

   **It prints no message content and no candidate titles**, only lengths. §24's
   boundary is that a machine must not read somebody's private thread, and
   running as the operator rather than as a worker is not a licence to turn a
   diagnostic into a transcript reader. A candidate title is authored by a
   worker from the person's own words, so printing it in a CI log would put the
   subject of a private thread there — the same rule, applied where it would
   otherwise leak out sideways.

None of these is deployed. They are the reason the remaining production action
exists.

---

## 27. Two defects the wait itself exposed — 2026-09-05

### A health counter that only ever went up

`recordRoutineFire({ok: true})` advances `consecutive_no_shows` on **every**
successful fire, and until now only a successful *assignment* cleared it. A
session that started, authenticated, asked for work and was told
`NO_READY_BINS` — which `checkIn`'s own comment calls an ordinary answer, and
which is the *expected* outcome for the losing half of a duplicate activation —
credited nothing at all. Three of those in a row quarantine a completely healthy
Routine at `NO_SHOW_QUARANTINE_THRESHOLD = 3`.

`recordRoutineNoShow` exists and **nothing calls it**. Its doc comment now says
so, because a dead function that looks like the mechanism is worse than no
function: the column is really "fires awaiting an arrival", and proving a real
no-show would need a reconciler that ages out a `SENT` dispatch nobody claimed.
There isn't one.

`recordWorkerArrival` now credits the arrival itself, unconditionally, as the
first thing `checkIn` does — before scopes, before work, before any decision
about whether there is anything to hand over. `tests/arrivalCredit.test.ts`
(8 tests) pins that a `NO_READY_BINS` answer clears the counter, that four
fire-and-check-in rounds do not quarantine, and that a genuine three-fire
streak with no arrival still does.

**I read that counter the wrong way in a production report and said a fired
Routine had failed to check in.** The code says `no-shows=1` means one fire is
awaiting an arrival, which on a healthy fleet is the ordinary state a moment
after a fire. The test exists so the next reader does not repeat it.

Where several Routines share one worker identity — which is exactly the current
fleet — an arrival credits all of them. That imprecision is written into the
function rather than left for somebody to discover.

### A pending state that could not become wrong

`beginTurn` stores one sentence on the pending row —
*"Russell is thinking — a worker is picking this up"* — and writes it **before**
anything has picked anything up. It never changes. So a turn whose bin was never
dispatched, whose dispatch ran out of attempts, whose fleet is paused, or which
is waiting on a person, showed the owner the same reassuring line for half an
hour.

§24 says the interface is never optimistic. That rule applies to the caption
too: **a pending state that cannot become wrong is not an explanation, it is a
spinner with a subtitle.**

`services/russell/pending.ts` derives the sentence on the read path from the bin
and its current-generation dispatch: waiting to be handed to a worker; queued
with no worker called yet; calling one now; called and not started; being worked
on now; could not reach a worker after several attempts; needs a decision from
you; the run has finished and the answer is being stored; or — the case that
must never read as patience — **this one did not reach a worker, so nothing is
running for it**. Past two minutes it says how long it has been.

It is a projection. It writes nothing, leaves `pending_reason` intact as the
row's history, and names no bin, Routine or session. `tests/pendingTurnState.
test.ts` (10 tests) drives the database into each real condition and asserts the
sentence, including that the stored column is untouched and that no internal
identifier appears.

The terminal-bin case was already covered and stays as it was: the Russell loop
finds a `COMPLETE`, `FAILED` or `CANCELLED` bin whose turn is still `PENDING`
and closes it with a truthful message, and `NEEDS_HUMAN` is deliberately left
alone because it has its own guarded way out.

---

## 28. A22 deferred by the owner — 2026-09-05

> "Paid text-API activation is outside Step 12A. Keep the existing fast-lane
> code disabled, with no API spending or new key. Preserve A22 and its history,
> but record its paid-provider activation proof as explicitly deferred by the
> owner and exclude that deferred requirement from the current Step 12A
> completion denominator. Do not mark it PASS or quietly delete it."
> — product owner, 2026-09-05

The reporter grows a fifth verdict. `DEFERRED` is not a synonym for anything
else: `NOT_RUN` means nobody has tried and somebody still should, `BLOCKED`
means something is wrong, and `DEFERRED` means the owner has decided this proof
is out of scope for now.

- It leaves the **denominator** and keeps its **row**. The table still reads
  twenty-two gates, and the composed line prints `passed/inScope` alongside the
  full count, so a gate quietly disappearing would be visible.
- The gate still **reads the database**. A deferral that could only be undone by
  editing the file would be a deletion wearing a different word; as written, the
  day a paid provider is activated A22 passes on its own evidence with no code
  change.
- The only place `DEFERRED` is set is A22, in code, next to the owner's reason.
- The fast lane stays built, tested and switched off, with its local safety
  checks intact. Migration 029 created the spend tables empty, there is no
  `spend_authorizations` row, `liveAuthorization` returns null, and the
  deployed secret list has no API key in it.

The workflow's verdict composition counts it the same way and prints the
deferred gates by name.

---

## 29. The remaining production action — 2026-09-05

Everything above is committed and unproven in production, because
`.github/workflows/step12a-acceptance.yml`'s A19 check compares the deployed
application tree to the tree being read and `scripts/` is part of that
comparison. The acceptance reading taken at 2026-09-05T16:43:33Z therefore says:

    STEP 12A — composed: 10/22 PASS · 0 FAIL · 0 BLOCKED · 12 NOT_RUN

**A19 moved from PASS to NOT_RUN**, correctly: the branch now carries
application changes the running image does not have. Every other verdict is
unchanged from §25. That is the guard working, not a regression.

What remains is one deployment, and it is described in full in the report to the
owner rather than begun here. It carries the ledger attribution, the arrival
credit, the derived pending explanation, `turn-trace`, and the `DEFERRED`
verdict — and it does **not** carry `ACCEPTANCE_SCOPE.conversationId`, which
cannot be set until the frozen scenario's conversation exists.

---

## 30. Verification of the repair — 2026-09-05

**Local, both backends, against the branch tip.**

| | |
| --- | --- |
| `npm run typecheck` | clean |
| `npm run build` | clean (client bundle 324.60 kB, 94.19 kB gzipped) |
| SQLite | **1,627 passed**, 25 skipped, 0 failed, 64 files |
| Postgres | **1,652 passed**, 0 failed, 65 files |

The counts moved 1,602 → 1,627 on SQLite and 1,627 → 1,652 on Postgres:
twenty-five new tests, and no existing test changed its expectations. The two
chains differ by the twenty-five Postgres-only cases that SQLite skips, which is
the same relationship §22 recorded.

- `tests/arrivalCredit.test.ts` — 8, the no-show counter.
- `tests/pendingTurnState.test.ts` — 10, the derived pending explanation.
- `tests/dispatchLedger.test.ts` — 5, the capacity ledger's attribution.
- `tests/russellShell.test.tsx` — 2 more, pinning that the client prefers the
  live condition over the sentence stored when the turn began, and falls back
  the other way only when the server sent no live detail. Pure-function checks
  over `turnLabel`, with no database involvement.

**No migration was added, edited or renumbered.** The four `bin_events` columns
this repair fills in have existed on both chains since SQLite 026 / Postgres
017; the defect was that nothing wrote three of them on the activation row and
nothing could read any of them through `BinEvent`. SQLite stays at **029** and
Postgres at **020**, and the populated-data upgrade proof in §23 stands
unchanged because the schema is unchanged.

`step10 turn-trace` was run against a local Deal Dispatch fixture — a
conversation, two messages and a candidate — and printed states, ids, times,
`title 17 chars` and no content whatsoever.

---

## 31. Mutation 6, and the permit trace resolved — 2026-09-05

### The deployment

Run [33979964910](https://github.com/Peyday007/V5/actions/runs/33979964910),
commit `f5ca139`, authorized in writing:

> "I authorize mutation 6: deploy `f5ca139` with the documented attribution,
> arrival-counter, pending-state, trace, and A22-deferral fixes. Use the
> established deployment checks, verification before and after restart, and
> rollback procedure."
> — product owner, 2026-09-05

Every step green: typecheck and tests, build, deploy, **hosted verification
before the restart** (17:12:27→17:14:40), **restart** (17:14:41→17:15:19),
**hosted verification after it** (17:15:19→17:18:20). `LEDGER` now names six
runs and `EXPECTED` is `6`, with the authorization quoted beside them.

**The acceptance-scope deployment the owner approved earlier is still
unspent.** It remains scope-pin-only and will take whatever number it is
actually given; nothing here consumed it or renumbered it.

### The permit conversation, from its own rows

`step10 turn-trace` against the deployed image
([33980663588](https://github.com/Peyday007/V5/actions/runs/33980663588)) and
`step10 trace` on the bin
([33980785406](https://github.com/Peyday007/V5/actions/runs/33980785406)).
Conversation `rcv_8085eba0beb04bc38ce6`, six messages, three turns.

**The owner conflated two different messages, and so did I.** The trace
separates them by length, and the lengths are decisive because the owner gave
me both texts:

| | chars | sent | outcome |
| --- | --- | --- | --- |
| turn 1 | 118 | 2026-09-04 07:42:34.867Z | answered 07:43:37.503Z, **63s** |
| **the permit message** | **256** | 2026-09-04 08:42:45.761Z | answered 08:44:38.604Z, **1m 53s** |
| **the frozen `S12A-ACC-1` message** | **207** | 2026-09-04 21:49:11.857Z | abandoned, then failed |

The quoted permit message is 256 characters and the frozen scenario message is
207, exactly matching the two rows. So:

**Who answered the permit message, and when.** Bin `bin_0427805f892549fb9c3a`,
ready 08:42:45.982Z, routed at 08:42:49.435Z to **account
`acct_70dda3fae2e1428e944b`, Routine `rtn_c7bcec972bd44afa91d7`** — the
`primary`/V1 pair — fired at 08:42:50.890Z into provider session
`session_016Ak4LSRx4rMGnXyibshZ6t`, assigned at 08:43:01.292Z to worker
`wkr_1cdd82cfb2a54faf8edd`, unit submitted 08:44:21.040Z, completion accepted
08:44:23.950Z. **The answer was saved at 08:44:38.604Z — one minute and
fifty-three seconds after the message.** It is 1,257 characters and its status
is `COMPLETE`.

**It created a candidate.** `rcn_23e70baee1ba47478c28`, state `CAPTURED`, at
08:44:38.552Z, on this conversation. **No mission and no probe** — priority and
ordinal are both unset, so nothing ranked it and nothing was launched from it.
The reply's prose about "capturing a candidate for bounded research" was
therefore true about the capture and not true about any research.

This is the answer the owner saw the following day. It had been there since the
morning.

**No friend's Routine was involved.** `DISPATCH_ROUTED` names one account and
one Routine, and they are the `primary` pair. That is a record Brain wrote at
the moment it chose, not an inference from fire counts.

### What actually went unanswered

The **frozen acceptance message**, sent at 21:49:11.857Z. Bin
`bin_aaee02cbf6714010b352`, ready at 21:49:12.112Z, intent created at
21:49:13.308Z, and then:

    21:49:13.440  DISPATCH_UNROUTED   ACCOUNT_TARGETS_REACHED
    21:50:23.462  DISPATCH_UNROUTED   ACCOUNT_TARGETS_REACHED
    21:51:33.514  DISPATCH_UNROUTED   ACCOUNT_TARGETS_REACHED
    21:52:43.552  DISPATCH_UNROUTED   ACCOUNT_TARGETS_REACHED
    21:53:53.602  DISPATCH_UNROUTED   ACCOUNT_TARGETS_REACHED
    21:53:53.653  DISPATCH_ABANDONED

"Every capable surface is at its configured target. Raise an account or Routine
target, or wait for an activation to finish." Five refusals in **four minutes
and forty-one seconds**, and then nothing was ever coming. The owner watched a
pending turn for thirty minutes because the dispatch had already given up in
the first five.

**Nineteen hours and twenty-one minutes later**, at 2026-09-05T17:15:23.573Z —
four seconds after mutation 6's restart — a worker checked in and was handed the
long-abandoned bin. It submitted a proposal at 17:16:24.844Z, Brain accepted the
completion at 17:16:27.291Z, and the turn resolved at 17:16:54.234Z as
**`FAILED`**, with the reason **"the priority was not one this version
recognises"**.

### Attribution that is not recoverable, and is recorded as unknown

The session that drained that bin on 2026-09-05 is **unknown**, and no new
logging can recover it. `BIN_ASSIGNED` records `session_ref` only when the
worker supplies it as telemetry, this one supplied none, and `lease_session_ref`
is cleared when the lease ends. The worker is `wkr_1cdd82cfb2a54faf8edd` —
which **both** V1 and V2 are bound to, so the account and Routine are not
determinable from it either. It was not this session: the only Brain calls made
here were `brain_whoami` and `brain_list_projects`, and neither claims work.

That is the honest end of that thread. A quarantine blocks new dispatches and
does not prove the absence of a separately started session, so nothing here
concludes anything about friend-2 from V2's state.

### Two defects the trace named, both fixed

**1. A rule the worker was never told.** `validateProposal` matches `priority`
against `CANDIDATE_PRIORITIES` exactly and refuses the whole proposal
otherwise. The turn manifest listed `"priority"` as an optional field and
**never said what the five values were** — while the comment directly above that
list explains, at length, that a rule enforced against somebody who was never
told it is a trap rather than a rule. One field further down, it was one.

That is what failed the frozen message's turn on 2026-09-05: the worker answered
with a priority of its own invention and the person was told Russell could not
answer. The manifest now enumerates the priorities from the constant, the way it
already enumerated the actions, and the manifest test asserts every one of them —
an assertion that fails on the old code with *"the manifest never names the
MUST_DO priority"*.

It also blocked `A06_JUDGMENT_OVERRIDE`, which needs a stored priority to
override.

**2. A full fleet counted as a broken dispatch.** `claimDispatchIntent`
increments `attempt_count` when a tick *picks an intent up* — before routing,
long before firing. So being told to wait cost an attempt, and five ticks of a
busy fleet exhausted the budget without one activation having been tried.

`markDispatchDeferred` gives the attempt back, guarded at zero, and puts the
intent back as `PENDING` with a one-minute wait. The refusals that defer are the
ones that resolve by themselves or by a switch an operator flips —
`FLEET_TARGET_REACHED`, `ACCOUNT_TARGETS_REACHED`, `ALL_SURFACES_RATE_LIMITED`,
`FLEET_PAUSED`, and losing a fire slot to another dispatcher. The rest still
exhaust and abandon, because "no Routine is registered" does not resolve by
waiting and an intent retrying into an empty room forever would hide a broken
deployment behind a patient spinner.

§23 already says *a refusal is not misconduct*, about accounts and quarantine.
This is the same sentence one level down, about an intent and its attempts.
`tests/dispatchDeferral.test.ts` holds both halves.

Neither of these is deployed. They are what the next deployment carries.

### Verification of both fixes

| | |
| --- | --- |
| `npm run typecheck` | clean |
| `npm run build` | clean |
| SQLite | **1,633 passed**, 25 skipped, 0 failed, 65 files |
| Postgres | **1,658 passed**, 0 failed, 66 files |
| Visual QA | 12 of 12 screens render and fit at 1280x900 and 390x844 |

Six more tests than §30: three in `tests/dispatchDeferral.test.ts`, three in
`tests/russellShell.test.tsx` for the conversation controls, and the manifest
assertion extended in place rather than added. No migration was touched; SQLite
stays at **029** and Postgres at **020**.
