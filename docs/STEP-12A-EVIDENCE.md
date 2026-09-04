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

| Gate | Verdict | Proof kind | Evidence |
|---|---|---|---|
| `A01_SHELL_IDENTITY` | NOT_RUN | | |
| `A02_CONVERSATION_ROUTE` | NOT_RUN | | |
| `A03_ROUTE_CORRECTION` | NOT_RUN | | |
| `A04_IRRELEVANT` | NOT_RUN | | |
| `A05_DEDUPE` | NOT_RUN | | |
| `A06_JUDGMENT_OVERRIDE` | NOT_RUN | | |
| `A07_PROBE_BOUNDS` | NOT_RUN | | |
| `A08_COVERAGE` | NOT_RUN | | |
| `A09_AUTH_BUDGET` | NOT_RUN | | |
| `A10_MISSION_PIPELINE` | NOT_RUN | | |
| `A11_INDEPENDENT_AUDIT` | BLOCKED | — | provisioning, outside this repository — §4 |
| `A12_WRITEBACK` | NOT_RUN | | |
| `A13_AUTO_NEXT` | NOT_RUN | | |
| `A14_HUMAN_RESUME` | NOT_RUN | | |
| `A15_RECOVERY` | NOT_RUN | | |
| `A16_DD_FRESHNESS` | NOT_RUN | | |
| `A17_PRIVACY_AUTH` | NOT_RUN | | |
| `A18_BASELINES` | NOT_RUN | | |
| `A19_DELIVERY` | NOT_RUN | | |

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

**CODE and TEST**, partial. `tests/russellNervousSystem.test.ts` — **33 tests,
passing on SQLite.**

| Built | What it does |
|---|---|
| `services/russell/routing.ts` | attaches a conversation to a project, asks when ambiguous, and lets a person's earlier correction outweigh a name match |
| `services/russell/judgment.ts` | decides what is worth capturing, dedupes, and forms Russell's own priority with a stated reason |
| `services/russell/coverage.ts` | the archive check that runs before any work is created |
| `services/russell/launch.ts` | the one way a mission comes into existence |
| `services/russell/writeback.ts` | what happens when one finishes, exactly once |
| `services/russell/loop.ts` | the durable tick, started by the server beside the dispatcher |

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

### Two failure classes that are not product defects

**Runner contention.** One Postgres run showed five failures, all in
`tests/ocr.test.ts` and all *timeouts* at 60s and 90s, while a full SQLite suite
ran concurrently — that file renders images and shells out to Tesseract, so it
is the first to starve. The Phase 1 Postgres run with nothing competing passed
the same file. Rerun serially rather than rewritten, as the anti-drag rule says.

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

**SQLite: 1361 passed / 25 skipped, exit 0**, running alone.

---

## 5. What is not claimed

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
