# Run 15: fresh acceptance on the frozen release 5603727 (2026-11-28)

The build was frozen at the merge of PR #1366, which carries Run 14's repairs: a wage is not a purchase price (`WAGE_AS_PRICE`), and a weekly owner-hours allowance binds every week. The hosts ran from a worktree pinned to that SHA.

An independent agent wrote the hidden cases in `cases/`: 12 established-opportunity cases (`av-*`) and 4 raw-objective discovery cases (`aw-*`). Five authors and two fleet reviewers took work from Brain's queue, and no author was prompted. `changer.sh` applied the mid-run changes to a07 (a contradicting price, 06:09:03) and a11 (objective narrowed).

**Grading:**
- **Bench:** the canonical grader read each published final revision. The changed cases a07 and a11 were graded at `--step 1`.
- **Discovery:** an independent grader agent graded the published plans against `cases/discovery.json` and COMPLETION-SPEC §2–§3.

## Result (COMPLETION-SPEC §4)

| set | passed / run | accuracy | Wilson 95% | critical | owner-usable | end-to-end |
|---|---|---|---|---|---|---|
| bench (hidden, held-out) | 8 / 12 | 0.67 | 0.39–0.86 | 1 | 8 / 12 | 8 / 12 |
| raw-objective discovery | 3 / 4 | 0.75 | 0.30–0.95 | 0 | (graded by rubric) | (graded by rubric) |
| **all** | **11 / 16** | **0.6875** | **0.44–0.86** | **1** | | |

The standard (≥ 0.90 with zero critical failures) is **not met**. This is the recorded result, unchanged.

## Failures

| case | published | failure | critical | cause class | cause |
|---|---|---|---|---|---|
| av-01, av-06, av-11 (after its change) | CONDITIONAL | UNJUSTIFIED_REFUSAL | no | Brain input defect, then review | Each sound opening's price was a directly comparable offer's current listing, with this offer's measured paid conversion. Brain's price reader read "sellers **list** … at $240" as *no exchange shown*, while "sell for $180 (listing prices)" (Run 12) read as a sale. So Brain's planner held OFFER_AND_PRICE unestablished ("no single price on the card"), fleet-1 labelled the price NOT_A_PURCHASE, and the authors made the plans conditional. |
| av-04 | CONDITIONAL | UNJUSTIFIED_REFUSAL + PAYER_POPULATION_INFLATED | **yes** | software check (Run 10 repair) | The same listing-price defect affected the workbook. Separately, `members` modelled 2 deals from Tri-County's single $2,400 purchase order. Run 10's `ARITHMETIC_UNSTATED` rule asked each weighed opening for the deals that carry the target alone, which for one organisation's order is an invented population. |
| aw-01 (d01) $1,500 / 21 days / 9 owner hours | NO_PLAN | incorrect (B) | no | Opus reasoning (discovery depth) | No opening cites its buyers, and at most one cites a price. The openings are category-level freelance writing, and the test emails businesses from no named or counted list. |

## Repairs, each at its owner (in the next build)

- **Brain's price reader (`paymentNature.ts`):**
  - "list / lists / listed" now count as purchase wording, like "sell / sold / priced".
  - Still not counted: a listing fee a seller pays, a grant described as "listed", a wage, and a person's word.
- **Review gate:** a NOT_A_PURCHASE condition against a price Brain establishes must name what payment it is instead (`nonPurchase`: reward, bounty, grant, prize, rebate, settlement, wage, another buyer's claim). The reviewer instructions say that a directly comparable offer's current price is an evidenced price.
- **`members`:**
  - A capped opening states `dealsMax`, and its deals never exceed it.
  - Only non-strategy openings are asked to carry the target alone, unless capped.
  - The strategy's members carry the target together.
- **Regressions:** `tests/run15Regressions.test.ts`, on the real a01 card, the real fleet-1 condition, and the real a04 members, with controls.
