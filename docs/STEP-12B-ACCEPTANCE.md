# Step 12B — production acceptance

§29 lists seventeen scenarios, A to Q. This records each one against what can
actually be verified, and — where a scenario cannot be run in this version —
says so with the reason rather than reporting a result nobody took.

Three kinds of evidence appear below, and they are deliberately not each other:

- **Code/test** — a suite assertion against the service production uses. Proves
  the mechanism; proves nothing about production rows.
- **Production read** — a workflow run against the deployed Brain. Proves what
  the deployed rows say at a moment.
- **Production effect** — something that happened in production because Brain
  did it. The strongest, and the one that cannot be manufactured.

`docs/STEP-12A-EVIDENCE.md` records the same distinction for the previous step,
and §25's ledger rule is the reason: code success, provider launch and
production completion must not substitute for one another.

---

## A recorded correction: this table over-claimed

An earlier version of this file reported **fifteen PASS and two qualified
PASSes** across the seventeen scenarios. That was wrong in a specific and
avoidable way, and the correction is recorded here rather than applied quietly.

Almost every row's evidence was **Code/test** — a suite assertion against the
service production uses — and the head of this file already says in terms that
such evidence *"proves the mechanism; proves nothing about production rows"*.
Then the Status column said PASS anyway. §29's scenarios are not assertions
about modules; they are about a person doing something on the deployed Brain,
so a mechanism's test is a necessary condition and never the verdict.

`scripts/step12b-acceptance.ts` is the answer to that, and it is deliberately
harsher than a document can be: it **exercises** what it can, in a temporary
database it creates and deletes, reads the **operational** fleet from the
configured Brain before it writes anything, and has four verdicts rather than
two — `PASS`, `PARTIAL`, `BLOCKED` and `NOT_RUN`, with `PARTIAL` required to
print the named condition it did not establish. There is no verdict meaning
"probably".

**This table is now that reporter's output, not a second opinion about it.**
Run `npm run step12b:acceptance` for the current reading, or the **Step 12B
acceptance** workflow to take it against production. A row here that disagrees
with the reporter is this file being stale, and the reporter wins.

---

## The scenarios, as the reporter reads them

The reading below is from the reporter against a Brain with **no fleet rows**
(a local run). Against production the three surface-dependent rows — A, B and
L — resolve to what the deployed fleet can actually do rather than to
`NOT_RUN`; that is the difference the workflow exists to close.

| # | Scenario | Verdict | What is established, and what is not |
| --- | --- | --- | --- |
| A | Conversation routing and continuity | PARTIAL against a Brain that has run | Asked of the turns rather than of the fleet: how many a worker answered, across how many conversations, how many Brain routed to a project itself, and how many are pending or failed with their own recorded reason. The surface blocker is still reported where nothing has run, because then it is the reason. **Not established:** continuity across a restart mid-turn, driven deliberately. |
| B | Independent judgment | PARTIAL against a Brain that has run | Two facts, both rows: ideas carrying a priority Russell decided, and completed audit passes. Neither is the fleet's health, which is what this used to report. **Not established:** a judgment a person disagreed with and overrode, end to end. |
| C | Priority and backlog | PARTIAL | 100 candidates classified from the domain's own vocabulary, and the semantic merge driven end to end in a second scope: 11/11 conditions held — a rewording merged and recorded as `SEMANTIC`, four claims refused (below the overlap floor, below the shared-subject minimum, naming a candidate in another project, naming one already folded away), and the merge undone by `splitCandidate` with both the MERGE and SPLIT rows still readable. **Not established:** a worker naming the repeat from a live conversation, which is the one string the server does not supply itself. |
| D | Discovery Frontier v1 | PARTIAL | A snapshot built from real rows — three declared foundations, five knowledge rows, an audit with two classified gaps, one idea Russell had itself — reads back through `frontierFor` with all five regions populated and all five derived lenses answering something. A `FOUNDATIONAL_GAP` is now recorded as `OPEN_QUESTION`; it was `WEAK_GROUND` until this run found the comparison unreachable. A derived lens is refused as an inquiry; a finding citing a row the project does not hold is discarded. **Not established:** the five asked lenses, each of which needs a reader. |
| E | Connected-site intelligence | PARTIAL against production | Read from the live connection rather than grepped from `projection.ts`: Deal Dispatch has delivered 60 connector events and 4 accepted commands into the deployed Brain, most recently the same evening. The six-answer projection including `NEEDS_PERSON` is derived on the read path and never stored. **Not established:** a command driven from the site through to a launched mission in one observed pass, which needs the site to send one. |
| F | Needs You | PARTIAL | The rule the park rests on — §24's *park only where more than one thing can be chosen between* — is driven against the three packet shapes that separate it, including the production one that produced the correction: one refused fragment, nothing accepted, one answer, nothing parked. **Not established:** a real packet parking on a production boundary, a person answering it, and the packet moving. |
| G | Capability Lab | **PASS** | 8/8 modes ran to COMPLETE in an isolated `TECHNICAL` scope, spending nothing, and every result names what it did not test. `npm run step12b:lab` additionally runs the canary apply → retest → compare → rollback cycle against real `fleet_policy` rows. |
| H | Visual maps | PARTIAL | Six map types over the authoritative graph, each with a synchronized outline; the money-flow map returns a reason for being empty rather than inventing edges. **Not established:** interaction on a real project at phone width. |
| I | Collaboration | PARTIAL | Two real identities driven through the boundary every route uses: a non-member refused, a MEMBER that reads and is not an ADMIN, a role change read from rows, a project ADMIN that cannot read the owner's private thread but can read the shared one, and a revocation that lands on the next read rather than the next sign-in. Eight conditions, all held. A worker principal is refused at these routes by type. **Not established:** an invitation anybody received, and the same journey on the deployed product. |
| J | Mobile | NOT_RUN | Rendered evidence at 390px is produced by `scripts/visual-qa.ts`, with driven interactions. A complete end-to-end mobile flow through a mission was not driven here. |
| K | Legacy removal | **PASS** | `tests/operatorConsoleRemoved.test.ts` refuses the route for every principal, fails on any link to it, and fails on any instruction to go there. |
| L | Always-on loop | PARTIAL against a Brain that has run | The durable cycle's own row — its state, how long ago it last ran, and any recorded error. `RUNNING` with no cursor is a loop that has never run rather than a broken one, so it is `NOT_RUN`; only `PAUSED` or `STOPPED` is `BLOCKED`. **Not established:** a measured uptime window rather than one reading. |
| M | Product truth and named denominators | PARTIAL | Four readers of one projection, against one project with four foundations in four different states at one instant. Home's briefing matches field by field; the conversation hat a worker is given carries that same headline verbatim; the progress route's three readings name three different denominators (foundations, missions, steps) and Work reports no fraction at all because its milestone set is not closed; the constellation's four major nodes are those same foundations and agree on every state. **Not established:** the same comparison against a versioned production state, over HTTP with an authenticated principal. |
| N | Routing and latency explanation | PARTIAL | One real dispatch traced from the configured Brain's own `bin_events` — the recorded chain, and the largest gap named from the two events either side of it rather than inferred from the total. Against a Brain that has never fired anything the verdict is `NOT_RUN` and says so. One routing decision is read by the candidate query, the admission hook and the fire router, and a refusal costs no claim state. **Not established:** the same reading across a workload mix rather than one bin. |
| O | Visual and interaction approval | PARTIAL | `scripts/visual-qa.ts` captures desktop, intermediate and phone, sweeps the 822–953 band, and drives three real interactions. It found and the build fixed one real clipping (the depth toggle at 822 and 860). **Not established:** your review of the images against the approved direction — that is yours to give. |
| P | Migrations, restart and preserved integrations | PARTIAL | `npm run upgrade:populated` proves the upgrade over populated data on both chains with a per-table sha-256 census, and a second restart applying nothing. **Not established by the script:** the hosted pre/post-restart checks, which the Deploy workflow runs. |
| Q | Shared access and safe experiments | PARTIAL | A preference outside its declared set is refused; an unauthenticated search is scoped to nothing; every preference key is presentational and has a default; every search kind is scoped before the query. The canary cycle is driven end to end against real `fleet_policy` rows in an isolated TECHNICAL scope, both ways round: 12/12 conditions held — real work refused as a first canary, a rollback over an empty history recording that it displaced nothing rather than inventing a number, and one over a person's target of 4 recording that 4 before writing 12 and restoring it by name. Every version stays in the history, so a rollback is a write forward. Role change with two real identities is exercised in I. **Not established:** an invitation anybody received, and this cycle against the deployed fleet. |

### The reporter nearly became a mutation, and that is recorded rather than fixed quietly

`initDatabase` honours `dbPath` **only in local mode** — it reads the configured
provider first — so a script that opens a scratch database by path alone gets
the real one whenever the environment says postgres. This reporter registers a
project, four foundations, two people, a hundred candidates, a lens inquiry and
eight Capability Lab experiments, and the workflow runs it *inside the
container*, where the provider is postgres and the cloud credential is present.
Its own header says everything it exercises runs in a temporary database;
against the deployed Brain that sentence would have been false.

It was found by running it twice against a Postgres test database: the second
run collided on a candidate id the first had written. **The production workflow
had never been dispatched**, so nothing real was touched — the first dispatch
would have done it.

The remedy is to state the config rather than hint at it: a provider named in
code cannot be overridden by the environment, so the exercising half is local
whatever the Brain is configured for. The operational reading — the part that
must see the real Brain — is taken and closed before any of it.
`tests/step12bProduct.test.ts` pins both halves: every `initDatabase` that is
followed by writes names `sqlite`, and the real read happens first.

Run locally against an empty database the reading is **2 PASS · 9 PARTIAL · 0
BLOCKED · 6 NOT_RUN (of 17)**: A, B, L and N have nothing to read, which is
*nothing has happened* rather than *something is wrong*. The verdicts above are
what the same reporter returns against a Brain that has run. **Step 12B is not
complete** either way, and the `Step 12B acceptance` workflow is the reading
that counts.

---

## What is not claimed

**The five pressure modes now run.** They were declared-and-refused in the
earlier version of this file; `server/services/fleet/labRunners.ts` implements
them against Brain's own queue, and the acceptance run above is 8/8 COMPLETE.
What is still **not** claimed is a measurement of a real Cowork surface: the
pressure applied is to Brain's concurrency machinery, which costs nothing, and
every result says so in its own `untested` list rather than once in a header.

**No screenshot approves a design.** The responsive suite pins the decisions
that caused the rejected clipping, and the sweep produces the images. §24 is
explicit that a passing screenshot test protects an approved baseline and
cannot approve a bad one, so the visual confirmation remains the owner's.

**A22 stays deferred and disabled.** Paid inference is off at a `$0` ceiling,
there is no key and no grant, and nothing in Step 12B activated it.

**The person-authenticated ChatGPT-first connector does not exist in this
repository.** Inspected and reported separately, as §0.4 requires. Native chat,
site synchronization and a worker's Brain tools are not evidence of it.
