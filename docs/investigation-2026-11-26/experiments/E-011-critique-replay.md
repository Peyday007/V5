# E-011: critique replay through REF `applyCritique` (W1b)

**Hypothesis.** W1b ("a drop resting only on WINDOW/CAPITAL is kept") overrules the recorded false window drops, and a drop on a true violation still drops.

**Inputs.**
- The recorded critic verdicts (`PROBE critique`), reconstructed into the reply shape `critiqueJson` reads.
  - The rule list and the why are taken from each dropped entry, `the critique dropped it (fails R1, R2): why`.
  - Ranked routes become KEEP.
- These are applied to the routes the critic judged: the recorded parse, re-read through REF `parseRoutes`.
- Constructed cases on a p10 snow-contract route (p10 limits):
  - the integration diagnosis's quoted snow drop;
  - controls;
  - fault injections.

**Command.** `node --import tsx docs/investigation-2026-11-26/experiments/harness/e011_critique_replay.ts`

**Raw output.** `raw/E-011/replay.json`, `constructed.json`, `stdout.txt`

## Result: the 10 recorded critiques (known-bad, E0)

**9 of 10 have an identical outcome at REF.** The one that changed:

| case | rules | recorded | REF |
|---|---|---|---|
| final_p06_all "Contra CSV" ($5 Craigslist fee the route never used; graders: a misreading) | CAPITAL only | dropped | **kept against the critique**, ranked last |

The named false window drops are **still dropped**, because the critic paired WINDOW with a second rule:

| case | false claim | rules | REF |
|---|---|---|---|
| final_p02_cap #1 | net 30 "outside" a 60-day window | WINDOW, CHANNEL, VALUE | dropped |
| final_p02_cap #6 | 30-day cycle "exceeds" 60 days | WINDOW, CHANNEL, VALUE | dropped |
| final_p02_all | net 30 | WINDOW, CHANNEL | dropped |
| final_p10_all | Printful Dec 3–7 "after" a window ending 24 Feb | WINDOW, CHANNEL | dropped |

**W1b's rule is all-or-nothing on the rule list.** One soft co-rule (CHANNEL "not guaranteed") defeats it. In the recorded evidence, **every** false WINDOW claim except the snow case came with a co-rule.

**Caveat.** The REF critic prompt now carries a COMPUTED line and "never drop on a date that line shows it meets". A live critic might no longer write these claims. That is untested, because it needs an LLM.

## Result: constructed cases (snow route, 35 days to cash, p10 limits)

| case | type | REF result | correct? |
|---|---|---|---|
| WINDOW-only "first snow is in December, after the 90-day window" | known-bad | kept (score −100) | ✓ |
| false WINDOW + CHANNEL | known-bad | **dropped** | ✗ |
| **true** WINDOW violation the route's own figures hide (payer on net-120), no repair | control | **kept** | ✗: a true violation is overruled |
| true WINDOW violation, critic repairs `daysToFirstCash: 120` | control | dropped (DEADLINE re-check) | ✓ |
| **true** CAPITAL violation the route did not state (deposit), no repair | control | **kept** | ✗ |
| LAWFUL drop | control | dropped | ✓ |
| invented objection citing **F999** (no such finding), MARKET | fault | dropped | ✗: nothing checks that cited refs exist |
| DROP with no rule named ("not convinced") | fault | dropped | ✗: an unreasoned drop is accepted |
| KEEP verdict but WINDOW scored 1 | fault | dropped (score-derived failure) | — |

## What this shows

`applyCritique` cannot tell a false numeric objection from a true one. It keys on **which rule names** the critic wrote, not on whether the claim is true:
- WINDOW-only drops are kept whether right or wrong;
- WINDOW+X drops are dropped whether right or wrong.

The only path that judges the figure itself is REPAIR, which is re-checked by `parseRoutes`. Critic citations (F-refs) are never checked against the findings shown.

## Diagnostics

| question | detects known-bad? | passes known-good? | catches injection? |
|---|---|---|---|
| C31-F (false drop detected and overruled) | **no**: 4 of 5 recorded false window drops still drop | **no**: true numeric violations are kept | **no** (F999, no-rule drop) |
| C05-I / C05-F (correct date changes keep/drop; wrong date claim detected) | only for WINDOW-only claims | no | no |
| C29-F (over-strict veto, e.g. a fee read as a capital breach) | yes, the CAPITAL-only case | **no**: the true CAPITAL control is also kept | — |
| C31-P / C31-X | FAIL stands | | |
