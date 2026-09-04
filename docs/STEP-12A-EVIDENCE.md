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

| Gate | Verdict | Proof so far | Evidence |
|---|---|---|---|
| `A01_SHELL_IDENTITY` | NOT_RUN | CODE, TEST | default route is Russell; Legacy behind a secondary menu, Admin only for an administrator; 23 behaviour tests |
| `A02_CONVERSATION_ROUTE` | NOT_RUN | CODE, TEST | `routing.ts`; attaches on a named project, asks otherwise |
| `A03_ROUTE_CORRECTION` | NOT_RUN | CODE, TEST | append-only context history; a correction outweighs a name match |
| `A04_IRRELEVANT` | NOT_RUN | CODE, TEST | `shouldCapture`; social and short remarks stay conversation |
| `A05_DEDUPE` | NOT_RUN | CODE, TEST | insertion-order dedupe, concurrent captures, guarded split |
| `A06_JUDGMENT_OVERRIDE` | NOT_RUN | CODE, TEST | stored priority and reason; override supersedes without erasing |
| `A07_PROBE_BOUNDS` | NOT_RUN | CODE, TEST | envelope in code, destinations chosen by Brain; lookups counted from observations; a redirect off the allowlist refused |
| `A08_COVERAGE` | NOT_RUN | CODE, TEST | only `SATISFIED` closes a requirement; the constant is pinned |
| `A09_AUTH_BUDGET` | NOT_RUN | CODE, TEST | atomic reservation, idempotent replay, server-clock expiry |
| `A10_MISSION_PIPELINE` | NOT_RUN | CODE, TEST | one mission, orchestration and bin under retries; capabilities routed; crash injection at each step |
| `A11_INDEPENDENT_AUDIT` | BLOCKED | — | provisioning, outside this repository — §5 |
| `A12_WRITEBACK` | NOT_RUN | CODE, TEST | exactly-once under three concurrent observers and a replay |
| `A13_AUTO_NEXT` | NOT_RUN | CODE, TEST | one launch per cycle, the rest preserved for the next |
| `A14_HUMAN_RESUME` | NOT_RUN | CODE, TEST | the exact parked mission resumes, once |
| `A15_RECOVERY` | NOT_RUN | CODE, TEST | boot repair re-enters the launcher; fenced late writer; expired probe ended honestly; an unrebuildable mission reported, not marked done |
| `A16_DD_FRESHNESS` | NOT_RUN | CODE, TEST | `CURRENT` / `STALE` / `UNAVAILABLE`; memory never returned as live |
| `A17_PRIVACY_AUTH` | NOT_RUN | CODE, TEST | scope-first routing and dedupe; a model's reference re-resolved against the principal; HTTP IDOR against a booted server; four injection shapes refused |
| `A18_BASELINES` | NOT_RUN | — | nothing deployed, so nothing to compare |
| `A19_DELIVERY` | NOT_RUN | TEST | typecheck clean, client builds; **SQLite 1449 passed / 25 skipped, exit 0**; upgrade path proven on both chains. No deploy, no hosted verification. |

**No gate is `PASS`, and none can be**: every one requires production-row proof
against a deployed commit after a real restart, and **zero of the three delivery
mutations have been spent**. The middle column says what is true today, which is
that the mechanisms exist and are proven by tests on both backends.

`npm run step12a:acceptance` is now the machine verdict, and against the local
database it reports **2 PASS · 0 FAIL · 1 BLOCKED · 16 NOT_RUN** and exits 1.
Two rules shape it and are worth stating because they are what stop it becoming
a rubber stamp. **"Implemented" is never a production verdict** — a gate whose
condition is about a real run reports `NOT_RUN` until that run's rows exist,
however complete the code is, and there is no flag that turns a test into
evidence. And **`A11` is hard-coded `BLOCKED` rather than derived from rows**,
because a check that read the database could be made to pass by writing rows,
and a gate satisfiable by the thing it constrains is not a gate.

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
| SQLite | **1449 passed / 25 skipped, exit 0** |
| Postgres | see the Phase 4 run below |
| Migrations from empty | both chains |
| Migration over existing data | both chains, `scripts/upgrade-check.ts` |

Both full runs were taken with nothing else competing for the machine. That is
not a detail: the one run that showed failures had a full SQLite suite running
beside it, and every failure was a timeout in the file that renders images and
shells out to Tesseract.

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

---

## 8. What is not claimed

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
