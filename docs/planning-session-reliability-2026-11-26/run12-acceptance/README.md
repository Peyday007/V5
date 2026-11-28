# Run 12: fresh acceptance on the frozen release 30835d5 (2026-11-28)

The build was frozen at the commit released to production as PR #1359. It holds Run 11's repairs:
- a conversion test must carry the target;
- a verification needs its verdicts;
- the large-project repairs from the production app journey: a call budget, a context that fits, refusal of malformed revisions.

The hosts ran from a worktree pinned to that SHA. An independent agent wrote the hidden cases: 12 established-opportunity cases (`ap-*`) and 4 raw-objective discovery cases (`aq-*`). Five authors and two fleet reviewers took work from Brain's queue, and no author was prompted.

`changer.sh` applied:
- **a03:** the supplier's cost rose (01:45:04);
- **a09:** the objective changed.

Both changes were re-planned and republished.

**Grading:** the bench used the canonical grader on each published final revision; the changed cases (a03, a09) were graded at `--step 1`. Discovery was graded by an independent grader agent against `cases/discovery.json` and COMPLETION-SPEC §2–§3.

## Result (COMPLETION-SPEC §4)

| set | passed / run | accuracy | Wilson 95% | critical | owner-usable | end-to-end |
|---|---|---|---|---|---|---|
| bench (hidden, held-out) | 9 / 12 | 0.75 | 0.47–0.91 | 0 | 9 / 12 | 9 / 12 |
| raw-objective discovery | 2 / 4 | 0.50 | 0.15–0.85 | 0 | (graded by rubric) | (graded by rubric) |
| **all** | **11 / 16** | **0.6875** | **0.44–0.86** | **0** | | |

The standard (≥ 0.90 with zero critical failures) is not met. This is the recorded result, unchanged.

## Failures

| case | published | failure | critical | cause class | cause |
|---|---|---|---|---|---|
| ap-01, ap-03 (after its change), ap-04 | CONDITIONAL | UNJUSTIFIED_REFUSAL | no | Brain input misleading, then Opus reasoning | The sound opening's price was a current comparable listing on the buyers' own marketplace. The seller's own outreach measured paid conversion (`paid 27 of 300` …), and Brain's planner held OFFER_AND_PRICE established. The reviewer raised a condition calling the price "what other sellers ask" and the conversion "agreements without a price", and the authors accepted it. **Independent adjudication: the plans are defective; EXECUTABLE is correct** (`adjudication-ap01-ap03-ap04.md`). |
| aq-03 (d03) $12,000 net / 45 days / $2,500 | CONDITIONAL | incorrect (B) | no | Opus reasoning (discovery) | Every opening is a marketing service to local small businesses, although the rubric wants materially different openings. Buyer counts and supplier costs are missing or mis-cited, and one price citation is misstated. |
| aq-04 (d04) $2,500 / 21 days / no capital, no owner hours | CONDITIONAL | incorrect (B) | no | Opus reasoning (discovery) | The rubric wants cited buyer counts and prices for at least two openings. One opening has no count and a misstated price citation, and the other's only count source could not be read. |

**Repairs to ap-01/ap-03/ap-04, each at its owner (in the next build):**
- **Brain's input:**
  - **Fault:** the bench world rendered the case's measured `paid` conversion on the card as "27 agreements from 300 contacts". That reads as something other than a purchase, and the reviewer read it that way.
  - **Repair:** it now reads "27 paid orders from 300 contacts" (`bench/planningReliability/case.ts`), which is what the case records. Brain's reader (`readOfferWins`) parses both the same way, so no figure changes.
  - **Effect on this run:** this was an evaluation-instrument defect. It is recorded here, and Run 12's result is not rewritten.
- **Review gate:**
  - **Rule:** a condition against a price Brain's planner establishes now names the defect the spec recognises: `defect` is PERSON_WORD, CONTRADICTED or NOT_A_PURCHASE. Without one it is refused.
  - **Reviewer guidance:** the instructions also name the revision to judge (the item's `revisionId`, not whichever revision is current).
- **Regressions:** both kept in `tests/run12Regressions.test.ts` on the real recorded condition and Brain's real run, with controls.

**The two discovery failures** are research depth and diversity. No general check owns them, and they are recorded as reasoning failures.
