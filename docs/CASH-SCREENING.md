# Cash screening: what to read to see it working

`server/services/cash/screenMetrics.ts` counts what the goal screen did. Every
figure is a count of existing rows; nothing is estimated or written.

| figure | read from |
|---|---|
| decisions by verdict, and by reason | `cash_decisions` where `is_current = 1` (optionally one goal) |
| superseded decisions | `cash_decisions` where `is_current = 0` |
| questions skipped | `cash_events` of kind `QUESTION_SKIPPED` |
| research released | withdrawn `cash_needs` whose resolution starts `Not researched:`, and cancelled `russell_missions` of openings with a current REJECT |
| Claude jobs avoided | REJECTed openings that never had a deep dive started, plus recorded skipped questions |

A figure nothing has recorded reads 0 and `notes` says so: zero rows is a
count, not a measurement of how many questions were asked. The value-of-information
step returns its skipped questions to its caller, so the count rises only once a
caller writes a `QUESTION_SKIPPED` event.

## Search balance

`yieldBalance` in `discoveryYield.ts` sorts each way of looking into EXPLOIT
(has yielded openings with a known payer), INVESTIGATE (asked, nothing usable
yet) and EXPLORE (known, never asked). The shares are counts of those methods,
so they move with the rows; there is no fixed percentage. With nothing yielding,
discovery keeps running (`discoveryContinues` is always true).

## Where the measurements and the surviving set are read

- `screenMetrics` (decisions by type, questions skipped, research released, Claude
  jobs avoided) and `candidateSet` (the openings that survive the goal's own
  limits, for a planner that combines them) are both on the owner's Cash view as
  `screening`, beside the other owner-only blocks. The set is `null` when the
  project has no goal with a target, because there is then no limit to survive.
- A question the screen decides is not worth asking is recorded as a
  `QUESTION_SKIPPED` cash event, once per opening and card field, by the research
  pass in `operate.ts` (`recordQuestionsSkipped`). Before this nothing wrote that
  event and the counter could only read zero.
