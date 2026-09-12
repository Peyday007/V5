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
| P1 | Brain-first shell is the default product | HOLDS |
| P2 | Navigation exposes Russell, Work, project/idea, Knowledge, Fleet/people, Needs You coherently; Build and Connected sites accessible | PARTIAL — eight flat items today |
| P3 | Home is briefing-first with a persistent command surface | PARTIAL |
| P4 | Conversation collections auto-route and stay correctable | OPEN |
| P5 | Work is mission-first and priority-aware | PARTIAL |
| P6 | Projects are living models | OPEN |
| P7 | Knowledge is organized understanding, not a file dump | OPEN |
| P8 | Needs You contains only real human decisions | PARTIAL |
| P9 | Fleet is understandable and dynamically scalable | PARTIAL |
| P10 | Capability Lab is functional | OPEN |
| P11 | Discovery Frontier v1 is functional | OPEN |
| P12 | Interactive maps functional — constellation plus all six specialized types | OPEN |
| P13 | Mobile fully functional | PARTIAL |
| P14 | Collaboration foundation functional | OPEN |
| P15 | Account preference foundation, no survey | OPEN |
| P16 | Personality and motivational Easter egg present | OPEN |
| P17 | Connected sites show honest live/stale/unavailable state | PARTIAL |
| P18 | Legacy normal-user interfaces retired | OPEN |
| P19 | Shared progress, historical knowledge, honest memory, provenance-filtered views verified | PARTIAL |
| P20 | Visual/mobile/interaction approval recorded; rejected-screenshot cases addressed | OPEN |

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
| T1 | Health Check passes | OPEN |
| T2 | Calibration produces measured recommendations | OPEN |
| T3 | Push-to-failure finds or honestly bounds a limit | OPEN |
| T4 | Work-layout comparison produces a defensible recommendation | OPEN |
| T5 | Quality degradation measured separately from throughput | OPEN |
| T6 | Recommendations canaried, promoted, retested, compared, rolled back | OPEN |
| T7 | Workload profiles support backlog forecasting | OPEN |
| T8 | Capacity elastic; no fixed fleet-size assumption | PARTIAL |

### Reliability and governance
| # | Condition | Status |
| --- | --- | --- |
| R1 | Private/shared boundaries hold | HOLDS |
| R2 | Permissions propagate correctly | HOLDS |
| R3 | Needs You resolutions resume work | HOLDS |
| R4 | No silent empty waits | HOLDS |
| R5 | Experiments cannot contaminate production knowledge | OPEN |
| R6 | Steps 9–11 and 12A invariants and regressions preserved; deferred gates stay labelled | HOLDS |
| R7 | Restart/redeploy preserves state | HOLDS |
| R8 | No duplicate work or stale writes | HOLDS |
| R9 | Technical detail inspectable without dominating | PARTIAL |
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
