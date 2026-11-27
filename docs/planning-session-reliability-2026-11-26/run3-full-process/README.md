# Run 3: the full author → checks → revision → independent review → publication process (2026-11-27)

**Transport:** the agents reached Brain only through its real MCP endpoint (`mcpRouter`: the same authentication,
authorization and tool dispatch the app connector uses). One isolated world per case was served by
`scripts/planningMcpHost.ts`. Every world had two worker credentials with the operator's scopes: the author's and
the reviewer's.

**What is graded:** the plan each world **published**. A plan publishes only after Brain's checks are clean and an
independent reviewer, under a different credential, has passed that exact revision. A world that published
nothing would have failed as `NOT_PUBLISHED`.

**Sample:** the 22 held-out cases (`ho-*`, `mv-*`), on fresh worlds. In ho-14 the objective changed after the
first plan; the change was applied, and the grade is taken after it.

**Agents:**
- 4 author agents (`AUTHOR.md`);
- 3 reviewer agents (`REVIEWER.md`);
- 1 discovery author (`DISCOVERY.md`);
- 1 research verifier.

## Held-out results

| level | result | Wilson 95% |
|---|---|---|
| published after independent PASS | 22/22 | — |
| verdict (completion spec §2–3) | **20/22 = 90.9%** | 72.2–97.5% |
| critical failures | **0** | — |
| owner-usable | **22/22** | 85.1–100% |
| end to end (§3a) | **19/22** | 66.7–95.3% |

**Verdict failures** (both non-critical `UNJUSTIFIED_REFUSAL`):
- **ho-11:** published CONDITIONAL where the rubric expects EXECUTABLE. The reviewer had asked for a run-rate test.
- **mv-04 (w21):** the same pattern. The author booked receipts net of an assumed 20% marketplace fee ceiling.

Both plans are owner-usable.

**End-to-end failures:**
- those two verdict cases;
- mv-01 (`RESOLUTION_ABSENT`): its no-plan named no measurement of OFFER_AND_PRICE.

**Review:** 5 worlds got REVISE first (w06, w11, w13, w21, and d01 below). Each was revised with answers per
finding and passed on re-review.

**This verdict figure is not complete planning reliability.** 22 cases cannot establish 90%: the lower bound is 72%.

## Discovery journey (world d01, the owner's $10,000 objective)

The world held **no openings**: no candidate solutions were supplied. The session:

1. **Discovered and admitted 4 routes** from public pages:
   - website accessibility audits;
   - n8n automation job bidding;
   - AI voice receptionists;
   - podcast clip retainers.

   Brain's route parser first refused the three where Brain was named as the performer, because Brain holds no
   proved deliverable for them. They were resubmitted with named fulfillers.
2. **Brain raised 8 research questions** on those openings.
3. **13 claims were researched over 3 submissions** and verified by an independent verifier through Brain's evidence
   gate. All were rejected, each with its reason:
   - **lawsuit counts:** population and definition mismatch (not buyers);
   - **first price submission:** unverifiable, because the context then hid claim text (a defect, fixed);
   - **every price submission:** the question's declared geography was a literal the gate did not recognise (a
     defect, fixed by using `ANY_NAMED_MARKET`);
   - **some price claims:** "most clients" is not the small-business population, and a quote ceiling is not a price.
     These are rejections on merit;
   - **remaining price claims:** geography UNSTATED, a policy edge recorded below.

   Nothing unverified reached the card as evidence. The planner reran after each verification.
4. **Published NO_PLAN.** The decisive gap is no accepted buyer price, buyer count or fulfiller cost. The resolution
   is tied to the $2,000 cap (a quote of $240 or less per site), the 30-day timing and a $197 test inside the $300
   pre-proof cap. The plan passed review after REVISE.

**Discovery outcome:** routes were discovered, research went through the gate, and the plan was justified and
published. There is no rubric case for an open-world objective, so this is reported separately and not graded.

## Findings

- **Gate policy edge:** for a question that names no market, Brain's gate passes UNKNOWN geography but fails
  UNSTATED, and a verifier honestly answers UNSTATED for a page that names no country. This is left unchanged
  because the gate is shared with production research, and it is reported for a decision.
- **Brief bias:** the author brief was written by the same session that built the grader. Between runs it gained
  field descriptions, such as "humanHours is the fulfiller's work". It names no case answers.
- **Not the claude.ai app:** this is Brain's real MCP router and authorization on isolated worlds, not the claude.ai
  app connector to production, which would need a deploy.
