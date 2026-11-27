# Run 4: focused corrections, regression set and fresh unfamiliar objectives (2026-11-27)

The process is the same as in run 3:
- the author works only through Brain's real MCP router (`scripts/planningMcpHost.ts`, one isolated world per case);
- Brain's checks run on every revision;
- an independent reviewer judges under its own credential;
- the plan is published only after the reviewer passes that exact revision;
- **the published plan is graded.**

Agents in this run:
- 4 author agents (`AUTHOR-BRIEF.md`);
- 5 reviewer agents (`REVIEWER-BRIEF.md`), all different identities from the authors.

The briefs name no case answers. Every world published; none graded as `NOT_PUBLISHED`.

## Corrections made in this round (each has tests)

| owner item | correction | tests |
|---|---|---|
| ho-11, mv-04 (conditions added where evidence supported execution) | Root cause: the context showed bare facts ("22 paid pre-orders from 200 visitors") without Brain's per-link judgement and basis ("measured on this offer's own inbound page"). Reviewers read that as a transfer. The context now carries `links[]` per opening (link, ok, basis). A chain judgement that differs from Brain's, in either direction, needs a stated `disagreements` reason (`CHAIN_DISAGREEMENT_UNSTATED`). | `tests/sessionPlanningChecks.test.ts`, `tests/sessionPlanningPath.test.ts` |
| mv-01 (resolution named no OFFER_AND_PRICE measurement) | A NO_PLAN without constraints must list `decisiveLinks`. Each must be missing in the chain and named in `resolves`. A CONDITIONAL plan's `resolves` must cover every missing link of its members (`RESOLUTION_UNNAMED`). | `tests/sessionPlanningChecks.test.ts` |
| Geography rule | For a question that names no market (`ANY_NAMED_MARKET`), UNSTATED geography alone no longer rejects a claim. The verdict stays UNSTATED, never relabelled MATCH, and every other condition still decides. A named market still fails UNSTATED. | `tests/evidenceLanes.test.ts` matched controls: unrestricted + UNSTATED accepted; "United States" + UNSTATED rejected, + MATCH accepted; unrestricted + UNSTATED with a population MISMATCH rejected |
| Found in this run: f10 | The cash ledger had no way to book an owner's float. The author had to book $60 as a customer RECEIPT plus a REFUND, so Brain showed $4,860 collected against $4,800, a refund no buyer received, and $0 exposure. New cash kind `FUNDING` raises the cash available and stays out of collected and net. Exposure still counts the owner's money at risk. | `tests/sessionPlanningChecks.test.ts` (shortfall without funding; float covers it with collected and net unchanged; a float does not lift an exposure cap) |
| Found in this run: grader adapter | `observeSession` counted a supplier payment only for a separate ORDER step. A costed DELIVER step paid by a linked SPEND is the supplier payment. It now counts. A control shows the same step with no linked outflow still fails. This changed two grades, r01 and f07, from not-usable to usable; both readings are given below. | `tests/sessionPlanningChecks.test.ts` |

## Discovery claims reprocessed (owner item 3): `discovery/`

World d01 is the owner's own $10,000 objective, run with no supplied openings. Its price claims were resubmitted through the corrected gate and checked by an independent verifier.

**Claims:**
- **3 accepted:**
  - small-site accessibility audit, $1,500–$4,000;
  - remediation, about $2,000–$10,000;
  - freelancer audit, $2,000–$8,000.
- **1 rejected on its definition:** its total includes the owner's staff hours. That legitimate rejection is preserved.

**Planning:**
- The card's revenue range moved to EVIDENCE.
- The planner reran and is still NOT_VIABLE, with the missing links unchanged. A general price benchmark is not taken as proof that buyers will purchase.

**Review and publication:**
- The reviewer returned the first revision for changes.
- The second revision is NO_PLAN: the accepted costs exceed the $1,500 price. It passed review and was published.

## Results, reported separately

### Regression set: 8 of the original 22 cases, re-run on fresh worlds

These cases informed earlier changes. They include the three run-3 failures: ho-11, mv-04 and mv-01.

| level | result | Wilson 95% |
|---|---|---|
| published after independent PASS | 8/8 | — |
| verdict correct | **7/8** | 52.9–97.8% |
| owner-usable | 7/8 (6/8 before the adapter fix) | 52.9–97.8% |
| end to end | 7/8 (6/8 before the adapter fix) | 52.9–97.8% |
| critical failures | **0** | — |

- **ho-11 (r01): fixed.** It was published EXECUTABLE.
  - The reviewer first challenged the volume and conversion link, and the author accepted and went CONDITIONAL.
  - On re-review, the reviewer read Brain's link basis and withdrew its own finding: "the 22-of-200 rate was measured on this offer's own page, the one the email links to". It asked for EXECUTABLE to be restored at Brain's 18 deals.
  - The disagreement mechanism resolved it on the evidence.
- **mv-01 (r03): fixed.** Its no-plan's `decisiveLinks` now name OFFER_AND_PRICE, MARKET_VOLUME and REACHABLE_BUYER, and its resolution names the research needed. The reviewer first rejected a TARGET/DEADLINE constraint that presented missing evidence as a limit; that was corrected.
- **mv-04 (r02): still fails** (`UNJUSTIFIED_REFUSAL`, not critical).
  - The author published CONDITIONAL with a sales-pace test. The 192 sales a month are the whole category's sales split across 40 sellers, so how many this one new listing gets is unknown.
  - The reviewer judged that condition genuine twice.
  - The rubric expects EXECUTABLE. The run-3 cause was different: receipts booked net of an assumed 20% fee.
  - The plan is not hardcoded to the rubric. This remains open.

### Fresh unfamiliar objectives: 14 cases (`fresh-cases.json`, fx-01…fx-14)

A separate agent wrote these cases in the bench's case format. It did not see the author or reviewer briefs. None had been run before this round.

| level | result | Wilson 95% |
|---|---|---|
| published after independent PASS | 14/14 | — |
| verdict correct | **12/14** | 60.1–96.0% |
| owner-usable | 12/14 (11/14 before the adapter fix) | 60.1–96.0% |
| end to end | 12/14 (11/14 before the adapter fix) | 60.1–96.0% |
| critical failures | **0** | — |

- **fx-02 (f02): fails** (`UNJUSTIFIED_REFUSAL`).
  - It was first submitted EXECUTABLE. The reviewer asked whether the 60 contacts behind the 15% rate were drawn from the same 85-house list.
  - The author accepted, and the plan was published CONDITIONAL. The rubric expects EXECUTABLE.
  - A reviewer-introduced condition again, as ho-11 showed in run 3.
- **fx-04 (f04): fails** (`UNJUSTIFIED_REFUSAL`).
  - The right stance (NO_PLAN) and the right decisive links (a contradicted price) were published.
  - But it also listed a TARGET constraint, which presents missing evidence as an arithmetic limit. The reviewer noted it only as minor.
- **f05:** passes as CONDITIONAL where the rubric's verdict is NO_PLAN. The grader's verdict level accepts this because the only unknown is buyer volume, which a free live test measures.
- **f10:** passed only after three review rounds:
  1. a cash shortfall;
  2. a CONDITIONAL the goal did not need, settled from the stored term `capitalCeilingCents: null`;
  3. a float booked as revenue, which led to the `FUNDING` fix.
- **f11:** graded after its objective change ($25,000 with no up-front capital). The new contract superseded the old revision.

### Combined (for comparison with run 3 only)

- Verdict 19/22 (66.7–95.3%).
- Usable 19/22.
- End to end 19/22.
- Critical failures 0.

These are not the same 22 cases as run 3. **None of these figures is complete planning reliability**: 22 cases cannot establish the 90% of `docs/COMPLETION-SPEC.md`, and the fresh set's lower bound is 60%.

## What the run shows about the process

- **The remaining failure mode is a condition introduced in review.**
  - Reviewers challenged an EXECUTABLE plan in r01, f02 and f10.
  - r01 was resolved on Brain's link basis. f10 was resolved from the stored goal term.
  - f02 was not resolved: the author accepted the reviewer's condition without testing it against the card.
  - mv-04 is the author's own condition, endorsed by the reviewer.
  - The disagreement check makes a difference from Brain explicit. It does not make the reviewer's challenge yield to the evidence.
- **Defects the checks missed and review caught:** f10's figures (fixed in the schema) and f04's TARGET constraint (not caught, because the reviewer passed it as minor).
- **Caveats:**
  - **Who ran it:** the fresh cases were written independently, but this session ran them. It also changed the checker (FUNDING) and the grader adapter during the run; both are disclosed above with before and after figures.
  - **The briefs:** written by the session that built the grader. They contain no case answers.
  - **Transport:** this is Brain's real MCP router and authorization on isolated worlds, not the claude.ai app connected to production (see `docs/planning-session-release.md`).
  - **Regression coverage:** the regression set is 8 of the 22 original cases.

## Files

- `worlds.txt`: world → case → set.
- `grades/`: the grade of each published plan, plus `summary-regression.json` and `summary-fresh.json`.
- `published/`: each world's published plan, revision and digest.
- `reviews/`: every review submission.
- `discovery/`: d01 reprocessing.
- `fresh-cases.json`, `AUTHOR-BRIEF.md`, `REVIEWER-BRIEF.md`.
