# Step 12B — inspection, reconciliation, and the frozen completion matrix

Frozen 2026-09-12, before any Step 12B implementation, from the reconciled
master prompt (§30) held against the repository at `e40c43a` and production
readings taken the same day. It is frozen in the sense §26 means: the contract
does not move once building starts. Status columns move; rows do not.

## 1. What the inspection found

**Repository.** `Peyday007/V5`, canonical branch `production` at `e40c43a`.
Development for this step is on the non-deploying feature branch
`claude/zealous-hypatia-78a2yp`, cut fresh from that tip. Deployment remains
`production` only (§28, invariant 36).

The client is already Brain-first: `client/src/Root.tsx` chooses the shell,
`client/src/russell/` holds the whole product (2,895 lines across seven
modules), and `client/src/App.tsx` is the legacy console at `/legacy`.
`/operator` is gone and `tests/operatorConsoleRemoved.test.ts` keeps it gone.

**The data layer Step 12B designs against already exists.** `RussellApi`
exposes conversations and threads, `briefing`, `work` (grouped, with a
`technical` flag that excludes verification fixtures by provenance), `ideas`
(the map), `sites`, `who`, `progress` (project / work / build as three named
denominators), `candidates`, `knowledge`, `needsYou` and `answer`, `authority`
with grant and withdraw, `probes`, and `overrideJudgment`. §6's "one
deterministic, permission-aware product projection" is therefore mostly a
matter of using what is there rather than building a new read layer.

**Production, read 2026-09-12.** The durable loop is `RUNNING`, cursor
`02:45:09.130Z`, generation 22673, `last error none`, `launches 1 · events 50`
per tick. `orc_08b94f87a71a4b588829` is `COMPLETE_WITH_GAPS` with its report
filed (42,621 bytes, 30/30 citations resolving). Its judge-authored follow-on
`rms_683d8907fcb94e94bb63` has already researched and filed
`doc_6dc71795f8f8443bb4a7`; packet `orc_abab7d7130d545eaa1a1` is `AUDITING`.
Needs You holds one row and it is `RESUMED` — nothing is outstanding.

## 2. Settings verified, not changed

Per the owner's instruction these were read and left exactly as they are.

| Setting | Value found | Action |
| --- | --- | --- |
| Standing research authority | `RUSSELL_PUBLIC_RECORDS_V1`, authorized by `usr_14439966398243339341` 2026-09-11T05:06:14.285Z | unchanged |
| Concurrent work limit | 1 | unchanged |
| Paid-API ceiling | `$0`; no `ANTHROPIC_API_KEY`, no `BRAIN_PROVIDER` | unchanged |
| Work policy | `UNCAPPED` missions / fragments / probes | unchanged |
| A22 fast chat | DEFERRED, disabled, zero ceiling | unchanged, excluded from the 12B denominator |

## 3. Reconciliation — what 12A already satisfies

These matrix rows are **already true** and Step 12B must preserve rather than
rebuild them. Listing them here is the §0.3 instruction to verify rather than
reset.

- Brain-first shell is the default product; the legacy console is at `/legacy`.
- Brain captures candidates, runs bounded probes inside `probeEnvelope`, ranks,
  recommends, can be overridden with a recorded reason, launches missions
  through the existing contracts, writes back exactly once, and starts the next
  authorized priority by itself.
- No ordinary work requires a manual packet, prompt, import, audit or queue
  operation. The last human action in the pipeline was a `RECORD_GAPS`
  decision, which is a §4.7 decision rather than an operation.
- Needs You resolutions resume work, proven on `rhr_36a4f59793274ac08598`.
- Canonical production ownership, permanent `/operator` removal, routing
  isolation, Website Connection and the Factory's dormant authorized state all
  hold.
- Migrations work from empty and over production-shaped data on both chains;
  hosted verification passes either side of a real restart.

## 4. The frozen matrix

`OPEN` is work Step 12B must do. `HOLDS` is satisfied by 12A and must survive.
`PARTIAL` exists but does not yet meet the §30 wording.

### Product
| # | Condition | Status |
| --- | --- | --- |
| P1 | Brain-first shell is the default product | HOLDS — unchanged; Russell is still the default and `/legacy` still one click away |
| P2 | Navigation exposes Russell, Work, project/idea, Knowledge, Fleet/people, Needs You coherently; Build and Connected sites accessible | HOLDS — six primary rail items, Build and Connected sites below a rule, both keeping their own addresses (approved 2026-09-12) |
| P3 | Home is briefing-first with a persistent command surface | HOLDS — `home.ts` composes §6's eight parts in order; the command bar is docked on every screen |
| P4 | Conversation collections auto-route and stay correctable | HOLDS — `russell_collections`, deterministic organization, a person's filing never overwritten, ranking derived |
| P5 | Work is mission-first and priority-aware | HOLDS — five groups, five priority classes from the candidate Russell ranked, seven answers per card |
| P6 | Projects are living models | HOLDS — map front door plus five subviews over the one projection |
| P7 | Knowledge is organized understanding, not a file dump | HOLDS — grouped by the six kinds with confidence and what each is short of |
| P8 | Needs You contains only real human decisions | HOLDS — empty inbox reads as settled, authority folded but reachable, urgency ranked |
| P9 | Fleet is understandable and dynamically scalable | HOLDS — three capacity numbers kept apart, causal slowness explanation, policy as rows |
| P10 | Capability Lab is functional | PARTIAL — health check and ledger calibration run for real; the five pressure modes are declared, enveloped and refused. See "What is declared and refused" below. |
| P11 | Discovery Frontier v1 is functional | HOLDS — five regions from rows, five derived lenses, four asked, resolve-never-delete, dismissal with a reason |
| P12 | Interactive maps functional — constellation plus all six specialized types | HOLDS — constellation plus all six types with a synchronized outline; an empty map says why |
| P13 | Mobile fully functional | HOLDS — container reflow at 980/720, thumb bar, 44px targets, pinned by `tests/step12bResponsive.test.tsx` |
| P14 | Collaboration foundation functional | HOLDS — Owner/Member/Viewer/machine matrix tested; a machine can never administer |
| P15 | Account preference foundation, no survey | HOLDS — `user_preferences`, closed presentational key set, no survey |
| P16 | Personality and motivational Easter egg present | HOLDS — Why this matters, grounded in real milestones, absent by default, no gamification |
| P17 | Connected sites show honest live/stale/unavailable state | HOLDS — unchanged from 12C |
| P18 | Legacy normal-user interfaces retired | PARTIAL — every ordinary workflow is in Russell; `/legacy` keeps seven archive operations. See `docs/STEP-12B-LEGACY-MIGRATION.md`. |
| P19 | Shared progress, historical knowledge, honest memory, provenance-filtered views verified | HOLDS — one projection everywhere, provenance filtering unchanged, milestone states added |
| P20 | Visual/mobile/interaction approval recorded; rejected-screenshot cases addressed | HOLDS — direction approved 2026-09-12; every named rejected case addressed and pinned by tests |

### Autonomy
| # | Condition | Status |
| --- | --- | --- |
| A1 | Captures meaningful candidates | HOLDS |
| A2 | Runs bounded probes | HOLDS |
| A3 | Own rankings and recommendations | HOLDS |
| A4 | Can reject unnecessary work | HOLDS |
| A5 | Can be overridden | HOLDS |
| A6 | Creates and dispatches missions through existing contracts | HOLDS |
| A7 | Updates project/knowledge state from results | HOLDS |
| A8 | Begins the next authorized priority automatically | HOLDS |
| A9 | No ordinary work needs manual packet/prompt/import/audit/queue operation | HOLDS |

### Testing and capacity
| # | Condition | Status |
| --- | --- | --- |
| T1 | Health Check passes | HOLDS — `runHealthCheck` answers every §15.1 question from rows, spends nothing, and reports BROKEN/ATTENTION/UNKNOWN separately because their remedies differ |
| T2 | Calibration produces measured recommendations | HOLDS — reads `bin_events` and carries the ledger's own evidence class; with nothing dispatched it says so rather than reporting a zero |
| T3 | Push-to-failure finds or honestly bounds a limit | **DECLARED AND REFUSED** — enveloped, isolation-checked and refused without a person's authorization. It spends real capacity on real surfaces, which this version will not do unattended. Nothing is simulated in its place. |
| T4 | Work-layout comparison produces a defensible recommendation | **DECLARED AND REFUSED** — same envelope, same reason |
| T5 | Quality degradation measured separately from throughput | **DECLARED AND REFUSED** — same envelope, same reason. `highestTested` keeps the two facts apart in every result that does run. |
| T6 | Recommendations canaried, promoted, retested, compared, rolled back | HOLDS — `applyFinding` writes a new `fleet_policy` version, `rollbackFinding` writes the previous value forward, and `stalenessOf` says when a conclusion no longer describes the configuration |
| T7 | Workload profiles support backlog forecasting | HOLDS — `workloadProfile` per project and packet; `fleetView.fits` is null rather than a guess when nothing has been measured |
| T8 | Capacity elastic; no fixed fleet-size assumption | HOLDS — the target is a row, changed without a deployment; nothing multiplies an account count into a capacity |

### Reliability and governance
| # | Condition | Status |
| --- | --- | --- |
| R1 | Private/shared boundaries hold | HOLDS |
| R2 | Permissions propagate correctly | HOLDS |
| R3 | Needs You resolutions resume work | HOLDS |
| R4 | No silent empty waits | HOLDS |
| R5 | Experiments cannot contaminate production knowledge | HOLDS — a pressure test outside a TECHNICAL scope is refused by name, and no path in `lab.ts` writes a claim, a document or a knowledge row |
| R6 | Steps 9–11 and 12A invariants and regressions preserved; deferred gates stay labelled | HOLDS |
| R7 | Restart/redeploy preserves state | HOLDS |
| R8 | No duplicate work or stale writes | HOLDS |
| R9 | Technical detail inspectable without dominating | HOLDS — one depth control in the shell, `data-depth` on the root, identifiers kept and folded; raw fleet identifiers withheld by entitlement rather than by a query parameter |
| R10 | Migrations work from empty and over production-shaped data | HOLDS |
| R11 | Canonical production, `/operator` removal, routing isolation, Website Connection, Factory state preserved | HOLDS |
| R12 | A22 and the person connector reported separately without reopening 12A | OPEN — reporting obligation |
| R13 | Hosted verification passes before and after restart | HOLDS |
| R14 | Final production version verified | OPEN |
| R15 | In-scope changes committed and pushed through the authorized workflow; unrelated user work preserved | OPEN |

## 5. Separate workstreams, carried not merged

- **Website Connection** — reported complete on its 24-check golden loop.
  Preserved and extended through the generic contract; not rebuilt.
- **Person-authenticated ChatGPT-first connector** — inspected: no route,
  service or table for it exists in this repository. It has not shipped. It is
  reported as separately prioritised work, not folded into 12B and not a 12B
  completion prerequisite.
- **A22 paid direct-model chat** — owner-DEFERRED, code and safety tests
  preserved, disabled at a zero ceiling. §7.3's contract is retained verbatim in
  the master prompt. Not a 12B activation gate.
- **Software Factory** — capability preserved, dormant, empty repository
  envelope. Not rebuilt, not restarted, no repository re-attached.

## 6. Design gate

§0.1 and §24 require a recorded visual, mobile and interaction approval before
broad UI implementation or production rollout. The preview covering Russell
home, project and living constellation detail, and both empty and populated
Needs You was prepared on 2026-09-12. Approval is recorded below when given.

| Date | Decision | Recorded by |
| --- | --- | --- |
| — | pending | — |

---

## Design preview (§24 gate)

The proposed direction is versioned at `docs/design/step-12b-direction.html` and
published for review at:

    https://claude.ai/code/artifact/8521cb82-173d-452b-b310-b4e2731a7882

It shows four screens — Russell home, project with the living constellation,
Needs You empty, Needs You populated — at three widths (1180 / 953 / 390) driven
by container queries rather than a media query on the preview's own viewport, so
the reflow shown is the reflow the product gets. It carries a depth control
(Normal / Interested / Technical) because §12's progressive disclosure is an
interaction rather than a layout, and a static picture cannot show it.

Nothing in it is implemented. It is a proposal to approve, and the four
decisions below are the only ones that are genuinely a person's.

| Decision | Proposed | Approved |
| --- | --- | --- |
| Where Build and Connected sites sit in the rail | Six primary items; those two below a rule | APPROVED 2026-09-12 |
| What replaces "0 of 8 settled" | Maturity word plus a per-foundation strip | APPROVED 2026-09-12 |
| How present Russell's voice is | One live line, on home only | APPROVED 2026-09-12 |
| Whether the constellation is the project's front door | Map first, written summary beneath | APPROVED 2026-09-12 |

---

## Design handoff — the built product, rendered (2026-09-13)

The preview above is a proposal drawn by hand. **This is the product itself**,
captured by `scripts/visual-qa.ts` from the built client served by a real server
with real rows, at the same four screens and the same three widths the direction
was reviewed at.

    npx tsx scripts/visual-qa.ts <dir> --renders=docs/evidence/step12b-renders

| | |
| --- | --- |
| Renders | `docs/evidence/step12b-renders/`, declared by its own `index.json` |
| Screens | `russell-home`, `project-constellation`, `needs-you-populated`, `needs-you-empty` |
| Widths | 1180, 953, 390 |
| Published for review | see the artifact link recorded with this handoff |

`needs-you-populated` and `needs-you-empty` are one address in its two real
states. Nothing is faked to produce either: a Brain with no standing grant has
exactly one decision outstanding — the approval nothing can proceed without — and
the harness presses that page's own **Approve** button to reach the settled
state. No request row is invented, and the grant lands in a throwaway database
the run deletes afterwards. **That is a state of a disposable Brain, not a
decision about this design.**

### The constellation, measured

The rejection named an obstructed diagram. The number behind it, and what it is
now:

| Viewport | Canvas | Before | After |
| --- | --- | --- | --- |
| 1180 | 866×541 | ring — 0 overlapping pairs | ring — 0 |
| 953 | 647×404 → 647×256 | ring — **1 pair**, 214px² | spine — 0 |
| 390 | 316×316 → 316×341 | ring — **8 pairs**, worst 1703px² | spine — 0 |
| 360 | 286×286 → 286×358 | ring — **12 pairs**, worst 2316px² | spine — 0 |

Taken in the product's own typefaces. The pass that ran before the harness served
them read **9 pairs / 2385px² at 390 and 13 at 360** — the figure this work was
given — because a fallback face sets different label widths, and a label width is
what an overlap is made of. Both readings are kept in
`docs/evidence/step12b-constellation/README.md`; what they agree on is the claim.

The 953 pair had never been measured. Nothing looked at the constellation
anywhere but 390px, which is why it sat in the product unreported.

### The one decision this handoff asks for

| Decision | Proposed | Approved |
| --- | --- | --- |
| Where the ring stops, and what replaces it below that | Ring at desktop; a two-column **spine** — same nucleus, same edges, same node count — at 953 and on a phone | *(not recorded — the owner's)* |

The phone half of that is not really a choice: the ring is arithmetically
impossible at 316px, and `docs/evidence/step12b-constellation/` shows what it
does there. **The genuine question is 953**, where the ring overlaps by one small
pair rather than eight: keeping it there means one covered label at the
intermediate width and one visual idea at every width; taking the spine there
means no overlap anywhere and a front door that looks like a ring only on a
desktop. Both are rendered, adjacently, in the published handoff.

Nothing in this section records an approval, and nothing in `scripts/` can.

---

## 6. What is declared and refused, and why that is the answer

Three of §15's eight Capability Lab modes can run in this version, and five
cannot. The distinction is not a shortfall to be worked around — it is the
control §15.1 asks for, and recording it plainly is the alternative to the two
dishonest options.

**What runs.** `HEALTH_CHECK` answers every question §15.1 lists from rows: is
an account registered, does a Routine have a secret, is a worker bound, can an
audit run at all, what capacity is usable, is anything stranded. It costs
nothing, because a health check that fired a worker to discover whether it works
would spend the allowance to learn what the rows already say. `CALIBRATION` and
`FLEET_PROVIDER` read `bin_events` — the only measurement Brain has that it did
not manufacture — and carry the ledger's own evidence class.

**What does not.** `PUSH_TO_FAILURE`, `LAYOUT_TOURNAMENT`, `ONE_ROUTINE_FIT`,
`QUALITY_UNDER_PRESSURE` and `RECOVERY_DRILL` put real pressure on real
surfaces. Each is declared with its full envelope — ceiling, duration, stop
conditions, cleanup, rollback, workload class, work kind — validated by
`checkEnvelope`, refused outside an isolated `TECHNICAL` scope, and refused
without a person authorizing the pressure in the request. Running one settles it
as `REFUSED` with the exact reason and nothing spent.

**The two alternatives, and why neither was taken.** Simulating them would
produce numbers a reader could not tell from measurements, which is the one
thing `services/dispatch/simulate.ts` exists to make structurally impossible —
and a capacity claim from a projection is exactly the "sizing a fleet on a
fiction" §23 already corrected once. Running them unattended would spend the
subscription's capacity against a ceiling nobody set, on a fleet that is
currently serving real research, and §15.1 is explicit that pressure increases
only inside a predeclared safe envelope.

So the honest report is: **the mechanism is complete and the measurements are
not taken.** An operator with an isolated scope and a moment to authorize a
ceiling can take them without a code change or a deployment, which is the
property that matters.

## 7. What is deferred, and where it is recorded

§31's list is unchanged and none of it was attempted: the customization survey,
behavioural personalization, the final motivational system, advanced
quantitative organs, the quant engine, a causal-discovery platform, recursive
self-improvement, unrestricted self-modification, autonomous external
execution, 3D and CAD, final enterprise governance, the final Discovery
Frontier, every possible site connector, and a perfect UI.

The extension points left for them are real rather than aspirational:

- `user_preferences` is the versioned seam a survey's answers would land in.
- `russell_frontier` counts what discovery produced, so a later version can
  measure whether the discoveries were any good.
- `capability_experiments` holds an applicability manifest and a staleness
  rule, so a later measurement is comparable to this one or is labelled
  non-comparable rather than pooled.
- `LAB_MODES` and `PRESSURE_MODES` are constants: implementing a mode is a code
  change that a reviewer sees, which is the property that keeps the refusal
  meaningful.
