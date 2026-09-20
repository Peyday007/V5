# The self-expansion kernel

**What it is:** the minimum state and machinery that lets Brain hold a capability
definition, say honestly how far it has got with it, and tell the difference
between a sentence in a document and a mechanism that runs.

**What it is not:** a second orchestration universe. Every part of it is a new
*entrance* to machinery Steps 4 to 12C already built — bins, leases, fencing,
the dispatcher, the evidence gate, the Factory's own approve-and-start. There is
no new security model, no new work queue and no new policy module.

---

## 1. The chain, in one line

> A registered source → a reading anchored in its extracted text → an
> independent audit → a canonical definition → held against a self-model →
> gaps → a contract a person approves.

Every link is a row, and every link is checkable in the direction a reviewer
walks it: from a clause in a change request back to the gap, the requirement,
the definition, the candidate, the quote, and the block in the document.

---

## 2. The six dimensions, and why there is no seventh

`faculties` carries six independent states:

| Dimension | Values | Moved by |
|---|---|---|
| `definition_state` | MISSING / DRAFT / CANONICAL | ingesting an audited source |
| `contract_state` | MISSING / DRAFT / COMPILED | compiling a cognitive contract |
| `implementation_state` | ABSENT / PARTIAL / CONNECTED / LIVE | the Factory and the self-model |
| `evaluation_state` | UNTESTED / FAILING / PASSING / PRODUCTION_PROVEN | evaluation |
| `availability_state` | DISABLED / SHADOW / ACTIVE | a person |
| `freshness_state` | CURRENT / NEEDS_REVIEW / SUPERSEDED | a later source |

There is deliberately **no aggregate** — no percentage, no rollup, no
`isComplete`. The moment one exists every reader uses it and the six become
decoration. `describeFaculty` composes a sentence out of all six instead.

**Ingesting a document may move exactly one of them.** `assertIngestionScope`
refuses the rest and `tests/capabilityKernel.test.ts` holds it. A Brain that
read a document about Research Intelligence and then reported Research
Intelligence as implemented would be lying in the most expensive available
direction: it would stop the very work the document exists to start.

---

## 3. Seven evidence levels, three answers each

`system_components` answers, per component: DOCUMENTED, IN_SOURCE, CONNECTED,
DEPLOYED, OBSERVED_ACTIVE, EVALUATED, PRODUCTION_PROVEN — each YES, NO or
UNKNOWN.

`NO` is a reading. `UNKNOWN` is the absence of one, and the difference is §30's:
*we could not tell* must never read the same as *we checked*. The live instance
is evaluation coverage — the Dockerfile copies `server` and `client` and nothing
else, so a deployed Brain genuinely cannot see whether a component is tested.

The rule the observers are written against is: **do not infer deployment or live
behaviour from code existence.**

- A module on disk reads IN_SOURCE and **UNKNOWN**-connected, because whether
  anything imports it is a static fact a running process cannot establish about
  itself. §24's `reconcileAcceptedFragment` and §27's `reconcileRepairs` were
  both exactly that — a function with one caller that needed two — and neither
  would have been visible to a runtime check.
- A migration *file* and a migration *applied* are two facts, and they disagree
  exactly when an instance is behind its own code.
- A completion contract with no registered evaluator reads as **declared and
  unreachable**, which is the state `evaluateContract` refuses every bin in.
- An MCP tool reads UNKNOWN-active: Brain keeps no per-tool call ledger and
  saying otherwise would be inventing one.
- A suite reads as existing and says **nothing** about whether it passes.

A scan decides nothing. Nothing in `services/selfmodel/` queues work, promotes a
faculty or fires a surface, and a test holds five other tables' counts across
one. A self-model that acted on what it saw would be a control loop whose input
is its own output.

---

## 4. The gap calculus: what Brain derives and what it refuses to

`DERIVABLE` and `NEEDS_JUDGEMENT` are constants a test holds.

Brain derives: `EXISTS_AND_LIVE`, `EXISTS_BUT_DISCONNECTED`,
`REQUIRES_PERSON_AUTHORITY`, `NEEDS_A_READING`.

Brain refuses to derive: `EXISTS_BUT_INSUFFICIENT`, `MUST_BE_BUILT`,
`MUST_BE_REPLACED`, `MUST_BE_RESEARCHED`.

**"Nothing matched" never becomes "this must be built."** The matcher is one
long non-stopword token the component's own name contains, and everything it
does not match is `NEEDS_A_READING` with the reason. A matcher that tried harder
would produce confident wrong answers — §25's Westbrook defect, where every row
reads healthy and the work is filed under the wrong heading. Missing a match
costs a reading; inventing one tells somebody a thing exists.

A requirement naming permission, authority, approval, consent, a credential or
spending goes to a person **whatever machinery matched it**.

---

## 5. What actually ran

Against the real `Brain_Intelligence_Map.md`, on this branch, locally.

| Fact | Value |
|---|---|
| Blueprint sha-256 | `da524c64808d85c101394e75903696e3b66aad550ae2163cbb7c42ecf7ca3ef0` |
| Amendment sha-256 | `78d42f34ccf8649894261f497f043ba21bfeb98d5f30715dd5ca6fa24faf5fe7` |
| Blueprint bytes | 63 586 |
| Extraction | READY, 1 177 blocks |
| Sections Brain declared | 15 — fourteen faculties plus the Shared Executive |
| Sections correctly skipped | chapters 7, 9 and 10 (infrastructure, contracts, principles) |
| Units submitted | 15 of 15, through a real lease |
| Candidates validated | 15, each anchored to a named block |
| Audit verdicts | 13 FAITHFUL, 1 OVERREACHES, 1 INCOMPLETE |
| Promoted | 13 |
| Relationships recorded | 79 |
| Self-model components | 573 |

Every promoted faculty reports the same way:

> Research Intelligence is canonically defined, it has no cognitive contract, it
> has no implementation, it is not yet evaluated, and it is switched off.

That sentence is the whole point of the registry.

### The two the audit refused, and why that matters

- **Metacognitive Intelligence — OVERREACHES.** The reading listed "every
  faculty" as a *dependency*; §5.11 states that under Connections. A faculty
  this one critiques is not one it depends on, and an inverted edge there would
  make Metacognition wait for every faculty it exists to interrupt.
- **Capability-Acquisition Intelligence — INCOMPLETE.** The amendment renames it
  to *Capability Acquisition and Realization Intelligence*, and the reading kept
  the blueprint's name as the canonical name with the rename only in prose. A
  registry whose identifier disagrees with its authoritative source is the thing
  every consumer gets wrong.

An audit that passes everything has not been tested. These two are refused with
their reasons kept for ever, and the candidates stay in `faculty_candidates`
rather than being deleted — a dropped candidate makes a coverage gap look like
something nobody proposed.

### The independence guard, exercised

- The extracting session (`capability-reader-a`) asked for the audit bin and was
  refused: `NO_READY_BINS`, from `capabilityAuditLineage`.
- A different session (`capability-reader-b`) was admitted and completed it.

The session identity comes from Brain's own `bin_dispatch` row, never from what
a worker says about itself. The credential is deliberately **not** compared: it
is per-connector rather than per-session, so comparing it would make every
reviewer identical to every extractor and refuse every audit for ever.

**What this does not establish.** Both readers were driven by one Claude Code
session. Two handles are two workers and two sessions, which is what the guard
compares; whether two different *model contexts* were behind them is a fact
about the operation that no row here can establish. Reported at the tier the
rows support and not one step further.

### The Research Intelligence packet

`derivePacket` over 573 components produced 28 gaps: 1 `EXISTS_AND_LIVE`, 2
`REQUIRES_PERSON_AUTHORITY`, **25 `NEEDS_A_READING` and zero `MUST_BE_BUILT`.**
Brain refused to guess, which is the designed behaviour.

A reader then classified the 25, and authored the seven design sections Brain
composes the question for and answers none of. After that:

| Kind | Count |
|---|---|
| EXISTS_AND_LIVE | 9 |
| EXISTS_BUT_INSUFFICIENT | 2 |
| MUST_BE_BUILT | 5 |
| REQUIRES_PERSON_AUTHORITY | 2 |
| WAIVED — owned by another faculty's packet | 10 |

The five to build are: belief-update proposals, research lessons, suggested
experiments or simulations, and the faculty's two own evaluation requirements.
The two insufficient are a question that survives its packet, and a
contradiction that re-enters research rather than only being classified.

Read together they say one thing, which is in `docs/RESEARCH-INTELLIGENCE-V1.md`:
**everything this faculty is missing sits after the packet's own terminal
state**, and every input those seven requirements need is a row Brain already
writes.

**Twelve of the thirteen readiness conditions hold.** All ten sections are
written, no gap is waiting on a reading, and there is something to build. The
one that does not is *no gap is waiting on a person*, and the two are named
exactly: "Available tools, workers, budgets and time" and "Permission and
privacy boundaries". `compile` refuses on that clause alone, which is the design
working rather than a blocker in the machinery — the last thing between a
specified capability and a contract somebody approves is the person.

`prove` reads the registry and reports that nothing the evidence supports has
changed, because nothing has been built. Research Intelligence is still
`ABSENT` and `UNTESTED`, and will stay there until code runs and is evaluated.

---

## 6. Two defects running it found that reading did not

- **An amendment is not a blueprint with no faculties in it.** The Faculty 14
  clarification registered cleanly, extracted cleanly and was marked FAILED for
  "declaring no sections this kernel recognises" — a correct statement about a
  blueprint and a category error about an amendment. Amendments are now never
  extracted; they are *carried* into the reading of the blueprint they amend,
  which is what preserving both with provenance actually means.
- **`GENERAL` was expressible only as the absence of a class.**
  `classesForFamilies` gave the GENERAL family `{ prefixes: [], allowsNull: true }`,
  so a bin declaring `GENERAL_…` matched nothing and the assigner answered
  `NO_READY_BINS` with everything about the bin correct. `GENERAL` is a prefix
  now as well as the absence of one. Null still means GENERAL, because rows
  written before `workload_class` existed carry none.

And one correction to this kernel's own first design: the architecture scope was
created with **no layer**, on the strength of the blueprint document's own
layer-lessness. Those are two different facts. §30 records the same defect one
section along — a project with no layer can open work and launch nothing, for
ever, with every row reading healthy.

---

## 7. What makes a capability exist

`services/realize/prove.ts` is the answer to *a merged pull request moves no
dimension in the registry*. Every move is derived from a different source than
the build:

| Dimension reaches | On evidence from |
|---|---|
| `PARTIAL` / `CONNECTED` | the gaps' own closure, not the campaign's state |
| `LIVE` | the self-model having **observed** the components |
| `PASSING` | the faculty's own declared evaluation requirements |
| `PRODUCTION_PROVEN` | rows in a project whose purpose is somebody's work |

The gaps and the campaign come apart exactly when a campaign succeeds at
something narrower than the packet asked for — the case a reader most wants to
see, and the one a campaign-state check would hide. An `UNKNOWN` from the
self-model holds the faculty at `CONNECTED`, because unknown is not a reading
and cannot be the evidence for the strongest implementation state there is. A
faculty declaring no evaluation requirements can never reach `PASSING`: calling
that passing would be passing an exam nobody set.

`availability_state` is absent from the table and from the module. It is named
as **withheld** rather than left out, because an absent line reads as "nothing
to say about it" when the honest answer is "this is not mine to say".

Reading and applying are two functions, so somebody can look before anything
moves, and every applied move writes its reason into `faculty_state_events` in
the same breath as the column.

---

## 8. The operator surface

```
npm run capability -- register <file> --title <t> [--amends <id>]
npm run capability -- sources | advance | read <id> | candidates | faculties | history <slug>
npm run capability -- scan | model | staleness
npm run capability -- packet open <slug> | derive <id> | show <id> | research <id>
npm run capability -- packet compile <id> | prove <id> [--apply] | realize <id> [--apply]
npm run capability -- packet judge <gapId> --kind <k> --evidence "…"
npm run capability -- packet outstanding <id> | ask <id> | handoff <id>
npm run capability -- reopen <sourceId> --admin <email> --reason "…"
npm run capability -- packet awaiting <id> | answer <gapId> --grant|--refuse --admin <e> --statement "…"
npm run capability -- packets
npm run capability -- submit <binId> <file.json> --worker <handle>
npm run capability -- verdicts <binId> <file.json> --worker <handle>
```

`submit` and `verdicts` hand a file to the same service a fired Routine reaches
through MCP: a real principal, a real check-in, a real lease and the real
validator. They do **not** make the reader independent — who runs them decides
that, and the guard decides whether it counts.

A command that changes nothing exits non-zero rather than printing success.

---

## 9. What calls it

`services/russell/loop.ts` — Brain's own durable tick — advances the kernel
fleet-wide on every pass, and re-reads the self-model when the last reading has
stopped being about this system. Both are wrapped so a kernel that cannot
advance never stops Russell writing back a mission: this is a reading *about*
Brain, never a precondition of it.

That wiring is a correction rather than a design. `advanceSources` was written,
tested and reachable by nothing but the operator script — so in a running Brain
a registered blueprint would have sat at `REGISTERED` for ever with every row
healthy. It is the *mechanism nothing calls* defect this repository records five
times, committed a sixth, and the suite that proved the tick worked could not
see it because it called the tick directly. `capabilityKernel.test.ts` now
asserts the loop's own source reaches it.

**And the rest of the chain, which was six commands in the right order.**
`advanceSources` stops at the registry: a blueprint becomes a canonical
definition and then nothing happens, because deriving the gaps, asking the
world, moving the dimensions, compiling the contract and handing it off were
each an invocation somebody had to remember. A packet whose authority gap a
person answered on Tuesday sat exactly where it was. That is the same defect
the paragraph above records, one altitude up, and the remedy it had been given
four times was itself a command — **an operator's memory is not a caller.**

`services/realize/advance.ts` runs beside `advanceSources` on the same tick and
is the ordering and nothing else. Every transition it performs is the identical
function this section's commands call, and a test holds both to the same names,
because a second implementation is exactly what passes a behavioural test and
drifts a month later. There is no second orchestrator, queue, policy module or
state machine, and the commands stay as the inspectable manual recovery beside
it.

**And it opens the packet the chain has reached, which was a seventh command in
front of the six.** Nothing opened a realization packet for a faculty that had
just become canonical, so the walk above had an empty list to walk for ever —
and both functions that could have done it carry a comment naming the tick as
their caller: `openPacket`'s idempotency is *"what makes this safe to call from
a tick"*, and `facultiesWithoutPackets` exists *"so a tick can see what has not
been started"*. Each had one production caller and it was `scripts/capability.ts`.

**One per pass, which is a rate rather than a ceiling.** A concurrency bound of
one was the obvious shape and is wrong here, because nothing in `server/` moves
a realization packet's state — `advance` in `packet.ts` is a compare-and-swap
with no production caller, so every packet is `DRAFT` for ever and a ceiling of
one is a ceiling nothing can release. The order is the blueprint's own
`ordinal`; a faculty with any packet is skipped, terminal ones included; and
`openPacket` itself refuses a definition that is not canonical.

Two further properties of the pass are worth stating because they are what make
running it every thirty seconds safe:

- **It re-derives only a packet with no gaps at all.** Re-deriving on a timer
  would replace a reader's classifications with `NEEDS_A_READING` on a loop,
  which is the one thing that would make the chain permanently unfinishable.
- **It is idempotent by its own effects rather than by a cursor or a flag** — a
  flag can be set by a tick that then dies. `moveDimension` records nothing when
  a faculty is already in the state; `askHuman` is `ON CONFLICT (resume_key) DO
  NOTHING`; `handOff` claims on `change_request_id IS NULL`; `askTheWorld` moves
  the gap to `ASSIGNED` carrying its candidate. Four passes over the same rows
  produce one reading, and that is asserted on the append-only rows.

**A person-owned gap reaches the surface that already exists.** A
`REQUIRES_PERSON_AUTHORITY` gap becomes a `russell_human_requests` row: the same
Needs You card, the same route behind `requirePerson`, the same
`resumeAnsweredRequest`. No second decision framework, because §24 already built
the one this is. It offers a grant *and* a refusal, because a card with one
answer is not a decision, and a refusal is recorded as `WAIVED` rather than
`CLOSED` — the packet then correctly stays short of whatever that requirement
was load-bearing for.

The resume had to be placed **before** that function's mission check, and this
is the part worth keeping: `resumeAnsweredRequest` returns `settled: true` for
any request with no mission — *"the request was not about a mission"* — so a
capability card somebody answered would have been marked RESUMED having carried
out nothing, vanished from the surface, and been raised again identically on the
next tick. A person could have answered the same question every day and never
learned their decision was recorded and ignored.

---

## 10. What is not built, said plainly

- **No faculty is implemented.** Thirteen are canonically *defined*. Every one
  reports `implementation_state = ABSENT` and `evaluation_state = UNTESTED`, and
  nothing in this kernel can move either.
- **No research mission has been run for a capability gap.** The director
  composes questions and asks the archive first; on this packet it produced
  zero, because no gap survived as `MUST_BE_RESEARCHED`.
- **Nothing has been deployed.** Every reading above is local. The deployed
  Brain does not have this code, so no fired Routine has read a blueprint.
- **No change request has been compiled or approved.** `compile` refuses the
  Research Intelligence packet on its remaining person clause, which is correct.

---

## 9. The three ends that were built and reachable by nothing

§8 above is the honest report this kernel shipped with, and three of its
sentences named the same defect rather than three different ones. Each was a
complete, tested mechanism whose only caller printed its result or did not
exist — this repository's most-recorded failure, arriving at the layer whose
whole job is telling a sentence in a document from a mechanism that runs.

| What existed | What called it | What that cost |
|---|---|---|
| `moveDimension`, which can write all six dimensions | `promoteCandidate`, moving `DEFINITION` only | Five columns written by nothing; every faculty read `ABSENT` and `UNTESTED` off a row nobody had asked |
| `compile()`, composing a complete `ObjectiveSubmission` | `scripts/capability.ts`, which printed it | A decision-ready packet and a Factory waiting for exactly this ask, with a person retyping between them |
| `directorPass`, composing bounded questions | nothing | *"No research mission has been run for a capability gap"* — the faculty that decides what Brain should learn about itself could learn nothing |

### `realized.ts` — the five dimensions, and the one it may not touch

Three are derived: `CONTRACT` from the packet's own sections, `IMPLEMENTATION`
from its classified gaps held against the self-model, `EVALUATION` from the
faculty's declared standard held against what covers it. Three are refused by
name in a constant, each with the reason beside it, so a later change that wants
one has to delete a sentence somebody wrote.

What makes it worth having is what it will not say:

- **An unclassified packet yields no implementation reading at all** — not
  `ABSENT`. `NEEDS_A_READING` is the kernel saying somebody has to look, and
  deriving a state over it answers the question the gap exists to ask.
- **An `UNKNOWN` may raise a state and may never lower one.** The deployed image
  carries `server` and `client` and not `tests`, so a Brain scanning itself in
  production reads `EVALUATED: UNKNOWN` about everything it is made of. Without
  the guard every proven faculty walks back to untested on every pass, and the
  next reader rebuilds something that works.
- **`FAILING` is unreachable from here.** The self-model records that a suite
  *exists* and says nothing about whether it passes, so inferring failure from
  an absence would produce an alarm nobody can act on.
- **`AVAILABILITY` has no mover.** Not a check inside one — the absence of a
  function, asserted by a test that reads the file. Whether a faculty is
  switched on for real work is the one dimension whose wrong answer is a wrong
  *action*, and a Brain that could switch its own faculties on is §22's worker
  creating its own work one altitude up.

**A second hole came out of re-reading the diff rather than from a test**, which
is the discipline §34 records and the reason it is worth naming. `served`
counts a `CLOSED` or `WAIVED` gap — correctly, since those requirements are not
outstanding — while the reach count is asked only of the gaps something actually
matches. A packet whose every gap was waived therefore had nothing outstanding,
an empty matched set, every count zero, and fell through to **`LIVE`**. A waiver
means *another faculty's packet owns this*, which is the opposite of a reading
that the thing works. There is no reading at all in that case now — not
`CONNECTED`, which would be the same invention one rung lower.

Writing the fixture found the first one. `judgeGap` could not record *which*
component a reader matched, so a reader answering `EXISTS_AND_LIVE` said
something serves the requirement and could not say what — and the reach count
read an empty set of keys as *no unknowns*, which walked straight to `LIVE`. A
served requirement with no component behind it is an unknown now. Both halves
were invisible to reading and visible from one fixture.

### `handoff.ts` — the ask, and nothing after it

`compile()` unchanged, then `submitObjective`, then stop. It does not import the
approval; a test matches the import statements rather than the file, because
this module's own header names `approveAndStartCampaign` in order to say it is
somewhere else. The packet is claimed with a guarded `UPDATE` on
`change_request_id IS NULL` — the one value that means nobody holds this yet and
is never what a winner leaves behind, which is §34's correction at the probe
claim where a guard satisfied by the state it claimed *into* turned out to be no
guard at all on the second backend.

### `askTheWorld.ts` — a question becomes an idea, never a packet

The obvious shape is `startPacket` with the question in it. It is wrong for the
reason §25 settled at the connected-site boundary: **a connector may ask, and
only a person in Russell may authorise the spending.** A capability question is
in exactly that position, and it is Brain reasoning about Brain — the least
supervised thing in this codebase and therefore the last place to invent a
second way of starting research.

So a question becomes a `russell_candidates` row, which spends nothing, and
every rule that already governs an idea applies unchanged: the archive check
runs again inside the compiler, the standing authority decides whether a mission
launches, the approval envelope decides whether the plan may start unasked, and
the gate, the verification pass and three audit roles are where they were. There
is **no authorization in the module and no import that could grant one**, which
a test asserts against the import statements by name.

The gap moves to `ASSIGNED` carrying the candidate, so the next pass — which
reads only `OPEN` gaps — asks nothing twice, and the link from a gap to its work
is a join rather than a search that a merge could answer wrongly.

### The joint that made all three unreachable

`NEEDS_A_READING` is where a derivation leaves a gap whose requirement matched
nothing, and `judgeGap` is the only transition out of it. It existed, four
suites exercised it, and **no route, tool or command called it** — so in
production a packet could enter that state and never leave, and everything
guarded on it is everything: `readiness`, `decisionReadiness`, `compile`,
`handOff` and the implementation reading all refuse while one gap is open.

The three mechanisms above were therefore reachable in tests and unreachable in
practice, and §5's record of *a reader then classified the 25* was made through
something that is not a shipped surface. Every part passed its own tests
throughout. It is the same defect as the three it blocks, one joint further in.

`npm run capability -- packet judge <gapId> --kind <k> --evidence "…"` is the
reading, on a terminal because reaching the shell is the authentication. A
reader may answer **any** kind: `DERIVABLE` bounds what *Brain* derives by
itself and `NEEDS_JUDGEMENT` is precisely the set a person is here to supply.
What is not settable is who the answer is recorded as — `derivedBy` is always
`PERSON`, with no flag that changes it. And `packet show` prints gap ids now,
because a command taking one beside a listing that printed none is §24's remedy
the person cannot use, at a terminal.

### What is still not true

- **No faculty is implemented.** `realized.ts` can now *say* one is, from rows,
  and on this repository every faculty's packet still holds unread gaps.
- **Nothing has been deployed.** Every reading here is local, and the hosted
  tool list not carrying `brain_propose_plan_revision` is what says so.
- **No capability research has actually run.** `askTheWorld` captures the idea;
  whether a mission follows is the standing authority's decision, and none has
  been granted on the architecture project.
