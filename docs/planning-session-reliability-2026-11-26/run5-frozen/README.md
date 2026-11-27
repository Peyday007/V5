# Run 5: fixes, focused regression, frozen build, fresh evaluation (2026-11-27)

The fresh evaluation ran on the frozen build `465ec4c`. Every world was graded on what it **published**. A plan
publishes only after Brain's checks are clean and an independent reviewer, under a different credential, passes that
exact revision.

Agents in this run:
- authors: 3 agents (`AUTHOR-BRIEF.md`);
- reviewers: 4 agents (`REVIEWER-BRIEF.md`), all different identities from the authors.

## Fixes made before the freeze (each with tests)

- **A reviewer's condition names its record.** A proposed condition is recorded only if it cites one of two things:
  - a card fact showing the link unestablished;
  - a prerequisite the card does not hold as evidence.

  The next revision must answer each condition with ACCEPTED or REBUTTED and the records checked. An acceptance must
  chart the gap; a rebuttal must not. Tests: `tests/sessionPlanningChecks.test.ts`, `tests/sessionPlanningPath.test.ts`.
- **Missing evidence sets no ceiling.** A no-plan's constraint must rest on established figures. An unestablished
  price or an uncounted market is a gap to research. Where the binding figure fails, the card's EVIDENCE fact that fixes
  it is cited. Tests: `tests/sessionPlanningChecks.test.ts`, with matched controls.
- **mv-04.** The determination is in `../mv-04-determination.md`. The rubric's EXECUTABLE rests on a visitor count with
  no stated period. Neither the case nor the plan was changed.

## Focused regression (`regression/`)

| case | verdict | usable | e2e | note |
|---|---|---|---|---|
| ho-11 | ✓ | ✓ | ✓ | |
| mv-04 | ✗ | ✗ | ✗ | CONDITIONAL, as determined (rubric unchanged) |
| mv-01 | ✓ | ✓ | ✗ | Resolution measures reach and volume on the templates route; the rubric holds the GitHub route's price decisive |
| fx-02 | ✓ | ✓ | ✓ | failed in run 4 |
| fx-04 | ✓ | ✓ | ✓ | failed in run 4 |

Critical failures: 0.

## Fresh unfamiliar objectives on the frozen build (`fresh/`, cases fx-15…fx-28)

These cases were written by a separate agent. It did not see the briefs or earlier runs.

| level | result | Wilson 95% |
|---|---|---|
| published after independent PASS | 14/14 (n14 graded after its objective change) | — |
| verdict correct | **11/14** | 52.4–92.4% |
| owner-usable | 11/14 | 52.4–92.4% |
| end to end | 11/14 | 52.4–92.4% |
| critical failures | **0** | — |

**Both new rules held in use.**
- **Real limits.** The three genuine limits (fx-25 target, fx-26 capital, fx-27 deadline) were declared on the cited
  card fact. The contradicted-price case (fx-23) named the gap, not a limit.
- **Conditions answered against records.** On n02 and n04 the reviewer's conditions carried their records. The author
  rebutted one (ECONOMICS on n02, citing `exposure`, `peakFundingCents` and Brain's basis) and accepted the others. The
  reviewer then passed the answers.

**Failures:**
- **fx-15 (n01). A Brain planner defect, not a session error.** Brain's planner excluded the only opening because it
  read the payer "Commercial beekeepers registered with the state apiary program" as a program, not a buyer. The
  session's context does not show an excluded opening's card, so the author could not dispute the exclusion.
- **fx-16 (n02) and fx-18 (n04).** These were published CONDITIONAL, while the rubric expects EXECUTABLE. Each condition
  cites a specific card record:
  - **n02:** the channel is a newsletter placement, and the conversion rate is per page visitor. No record says how many
    visitors a placement sends.
  - **n04:** each clinic files once "during this calendar year", and the year is about 91% over. No record says how many
    clinics remain unfiled.

  These are not unsupported conditions of the run-4 kind. Whether the case author or the reviewer read the card
  correctly is not re-adjudicated here, and the scores stand as graded.

**Defects found during the frozen run, recorded, not fixed (the build is frozen):**
1. **Payer misclassification.** The planner reads a payer phrase containing "program" as a program, not a buyer
   (fx-15).
2. **Excluded cards are hidden.** An excluded opening's card is not exposed to the session, so an exclusion cannot be
   disputed on the evidence.
3. **Unstated owner hours read as zero.** The owner-hours check treats unstated hours (`hoursCeiling` null) as zero
   allowed, so an unknown blocked n14's first plan from publishing (CLAUDE.md invariant 39). n14's first step published
   nothing; the graded step is the one after its objective change.

## The four outcomes, kept separate

1. **Software checks pass.** On the frozen head, typecheck is clean, and `test:impacted` passes on both SQLite and
   Postgres (84 files, 1,359 tests each; `test-pg-result.txt`).
2. **Unfamiliar objectives produce usable plans.** 11 of 14 on Brain's real MCP router, on isolated worlds. This is not
   the 90% of `docs/COMPLETION-SPEC.md`: the lower bound is 52%.
3. **The Claude app connection works.** Not demonstrated. The owner's production connector, as of this session, serves
   no `brain_planning_*` tool, because the branch is not deployed. See `../../planning-session-release.md`.
4. **A real commercial objective.** The owner's $10,000 objective (discovery world d01) published a no-plan with an
   ordered experiment. The frozen checker re-checked it with 0 problems (`discovery-recheck/`).
