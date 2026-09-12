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
| A | Conversation routing and continuity | NOT_RUN | A turn is a bin and a bin needs a surface; a run holding no fleet rows can say nothing either way. |
| B | Independent judgment | NOT_RUN | Same condition. The judgment pass itself is carried from 12A and unchanged. |
| C | Priority and backlog | PARTIAL | 100 candidates classified from the domain's own vocabulary in an isolated scope. **Not established:** the semantic merge of duplicates, which needs a worker to name the repeat. |
| D | Discovery Frontier v1 | PARTIAL | Five lenses answered from rows; five asked with a governed path; a derived lens refused as an inquiry; a finding citing a row the project does not hold discarded. **Not established:** the six discovery classes against a real project snapshot, which needs a worker for the asked half. |
| E | Connected-site intelligence | NOT_RUN | The six-answer projection including `NEEDS_PERSON` is present and derived on the read path. No live site was read in this run. |
| F | Needs You | PARTIAL | The rule the park rests on — §24's *park only where more than one thing can be chosen between* — is driven against the three packet shapes that separate it, including the production one that produced the correction: one refused fragment, nothing accepted, one answer, nothing parked. **Not established:** a real packet parking on a production boundary, a person answering it, and the packet moving. |
| G | Capability Lab | **PASS** | 8/8 modes ran to COMPLETE in an isolated `TECHNICAL` scope, spending nothing, and every result names what it did not test. `npm run step12b:lab` additionally runs the canary apply → retest → compare → rollback cycle against real `fleet_policy` rows. |
| H | Visual maps | PARTIAL | Six map types over the authoritative graph, each with a synchronized outline; the money-flow map returns a reason for being empty rather than inventing edges. **Not established:** interaction on a real project at phone width. |
| I | Collaboration | PARTIAL | Two real identities driven through the boundary every route uses: a non-member refused, a MEMBER that reads and is not an ADMIN, a role change read from rows, a project ADMIN that cannot read the owner's private thread but can read the shared one, and a revocation that lands on the next read rather than the next sign-in. Eight conditions, all held. A worker principal is refused at these routes by type. **Not established:** an invitation anybody received, and the same journey on the deployed product. |
| J | Mobile | NOT_RUN | Rendered evidence at 390px is produced by `scripts/visual-qa.ts`, with driven interactions. A complete end-to-end mobile flow through a mission was not driven here. |
| K | Legacy removal | **PASS** | `tests/operatorConsoleRemoved.test.ts` refuses the route for every principal, fails on any link to it, and fails on any instruction to go there. |
| L | Always-on loop | NOT_RUN | Same surface condition as A and B. |
| M | Product truth and named denominators | PARTIAL | Driven against one project with four foundations in four different states: home's briefing and the project's own reading return the identical progress at one instant — headline, stage, ratio and every milestone state — the denominator is named, the ratio is whole, and the sentence a person reads carries no percentage. **Not established:** the same comparison across constellation and Work against a versioned production state. |
| N | Routing and latency explanation | PARTIAL | One routing decision is read by the candidate query, the admission hook and the fire router, and a refusal costs no claim state. **Not established:** a traced real dispatch, which needs a surface. |
| O | Visual and interaction approval | PARTIAL | `scripts/visual-qa.ts` captures desktop, intermediate and phone, sweeps the 822–953 band, and drives three real interactions. It found and the build fixed one real clipping (the depth toggle at 822 and 860). **Not established:** your review of the images against the approved direction — that is yours to give. |
| P | Migrations, restart and preserved integrations | PARTIAL | `npm run upgrade:populated` proves the upgrade over populated data on both chains with a per-table sha-256 census, and a second restart applying nothing. **Not established by the script:** the hosted pre/post-restart checks, which the Deploy workflow runs. |
| Q | Shared access and safe experiments | PARTIAL | A preference outside its declared set is refused; an unauthenticated search is scoped to nothing; every preference key is presentational and has a default; every search kind is scoped before the query. **Not established:** an invitation anybody received, and a canary rollback in production. Role change with two real identities is exercised in I. |

**2 PASS · 10 PARTIAL · 0 BLOCKED · 5 NOT_RUN (of 17). Step 12B is not complete.**

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
