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

## The scenarios

| # | Scenario | Evidence | Status |
| --- | --- | --- | --- |
| A | Conversation routing and continuity | Code/test — `step12bProduct`: organization is deterministic and idempotent, a person's filing is never overwritten, standing is derived from live rows, one person sees nothing of another's threads. Production read — collections render for the live account. | **PASS** |
| B | Independent judgment | Code/test — carried from 12A: `judgeCandidate`, the archive check, the probe envelope. Unchanged in 12B. | **PASS (carried)** |
| C | Priority and backlog | Code/test — the five classes come from the candidate Russell ranked; a mission nobody ranked carries no class. Work groups by the five sections. | **PASS** |
| D | Discovery Frontier v1 | Code/test — five regions classified from rows, new paths only where provenance says Russell had the idea, resolve-never-delete, dismissal attributed and reversible, refresh idempotent. Production effect — the durable tick refreshes it with nobody watching. | **PASS** |
| E | Connected-site intelligence | Carried from 12C's 24-check golden loop. Unchanged in 12B. | **PASS (carried)** |
| F | Needs You | Code/test — empty inbox reads as settled; the approval a project cannot proceed without is never folded; the folded card keeps its controls in the document. Carried from 12A: answers resume the same mission exactly once. | **PASS** |
| G | Capability Lab | Code/test — health check runs and spends nothing; the ledger mode carries the ledger's evidence class; every pressure mode is refused without an envelope, outside an isolated scope, or without a person's authorization, and an unimplemented one refuses by name rather than returning numbers. | **PASS for what runs; the five pressure modes are DECLARED AND REFUSED.** See matrix §6. |
| H | Visual maps | Code/test — six types over the authoritative graph, every edge joining nodes that exist, an outline that is the same graph, a cycle that terminates, and an empty map that says why. | **PASS** |
| I | Collaboration | Code/test — the Owner/Member/Viewer/machine matrix, including that a machine with every scope still cannot administer and an unnamed machine write is refused. | **PASS** |
| J | Mobile | Code/test — `step12bResponsive`: the navigation decision at 360/390/720/822/953/1440, container queries rather than viewport ones, no min-width wider than a phone, 44px targets, focus visibility, reduced motion, both themes from tokens. Not a screenshot: jsdom does not lay out, and a passing assertion is not a passing design. | **PASS for the decisions; visual confirmation is the owner's.** |
| K | Legacy removal | Code/test — `operatorConsoleRemoved` reads the repository and refuses any link or instruction; the route 404s for every principal. `docs/STEP-12B-LEGACY-MIGRATION.md` inventories what `/legacy` still holds and why. | **PASS for `/operator`; `/legacy` retains seven archive operations by design.** |
| L | Always-on loop | Production effect — the durable tick runs the frontier refresh alongside the existing steps, with nobody watching. Carried from 12A: dispatch, assignment, writeback. | **PASS** |
| M | Product truth, historical knowledge, memory | Code/test — one projection everywhere; "nothing settled yet" says what is under way; the denominator is named; no branch turns a feeling into a percentage. | **PASS** |
| N | Routing and latency explanation | Code/test — `explainSlowness` joins recorded events and names the largest gap from the two events either side; an unknown gap is said to be unattributed; a bin with no events reports what could not be determined. | **PASS** |
| O | Visual and interaction approval | Owner approval recorded 2026-09-12 on all four open decisions. The preview is versioned at `docs/design/step-12b-direction.html`. | **PASS** |
| P | Preserved integrations, migrations, restart | Code/test — full suite on SQLite and Postgres; both migration chains extended in step; `deploymentOwnership` walks both chains for a gap or collision. | **PASS** |
| Q | Shared-product access and safe experiments | Code/test — search scopes before it queries; a pressure test outside an isolated scope is refused; no lab path writes a claim, a document or a knowledge row. | **PASS** |

---

## What is not claimed

**No pressure measurement was taken.** Five Capability Lab modes are built,
enveloped and refused. Nothing was simulated in their place, so there is no
number anywhere in this build that describes a capacity Brain has not observed.

**No screenshot approves a design.** The responsive suite pins the decisions
that caused the rejected clipping. §24 is explicit that a passing screenshot
test protects an approved baseline and cannot approve a bad one, so the visual
confirmation remains the owner's, against the approved direction.

**A22 stays deferred and disabled.** Paid inference is off at a `$0` ceiling,
there is no key and no grant, and nothing in Step 12B activated it. Reporting
anything else would be the "fast chat complete" §7.3 forbids by name.

**The person-authenticated ChatGPT-first connector does not exist in this
repository.** Inspected and reported separately, as §0.4 requires. Native chat,
site synchronization and a worker's Brain tools are not evidence of it.
