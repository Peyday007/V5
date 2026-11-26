# E-013: does the W1i objective-reader repair generalise?

**Hypothesis.** REF `readObjective` reads amount, window, capital and hours correctly on paraphrases it was not tuned on, not only on the fm1126a phrase classes.

**Inputs** (`harness/e013_objective_reader.ts`, now = 2026-11-26T06:00Z).
- **dec1125c ×3:** verbatim from the planner probes.
- **fm1126a ×7:** **reconstructed**. The batch's own texts are not in the repository. Only fragments are quoted in `docs/planning-failure-map/map.json`, and each sentence was built around one quoted fragment.
- **control ×2:** plain phrasings.
- **new ×12:** written here. They are not in `tests/objectiveFreshPhrasings.test.ts` and not in the batch.

The expected values are a human reading. An unread figure is expected to be named in `unread`.

**Command.** `node --import tsx docs/investigation-2026-11-26/experiments/harness/e013_objective_reader.ts`

**Raw output.** `raw/E-013/result.json`, `stdout.txt`

## Results

| set | field checks OK | rows fully correct |
|---|---|---|
| dec1125c (3) | 12/12 | 3/3 |
| fm1126a-reconstructed (7) | 24/24 | 7/7 |
| control (2) | 7/7 | 2/2 |
| **new (12)** | **33/47** | **2/12** |

**New-set failures, by field:**
- **amount refused** (`kind: OTHER`) on 3 rows:
  - "ten thousand bucks"
  - "Half a grand"
  - "twenty-five hundred dollars"
- **capital unread** on 5 rows:
  - "no more than two grand"
  - "Zero budget"
  - "Budget is capped at $4k"
  - "I'm not putting a cent in"
  - "no upfront money"
- **hours unread** on 4 rows:
  - "Maybe 6 hrs a week"
  - "maybe 5 hours weekly"
  - "Ten hours a week tops"
  - "can't work more than 8 hours total"
- **window unread** on 2 rows:
  - "within a fortnight"
  - "this weekend"

**11 of these 14 misses are silent: no entry in `unread`.** The reader neither reads the figure nor says it could not, which breaks its own contract ("a phrase the reader saw and could not interpret is named in `unread`").

**Consequence downstream (static).** A null capital becomes "the owner set no figure" (`routeProposal.ts:350`), and a null hours limit becomes "no figure set" (`:355`). So "Zero budget" becomes **no capital limit at all**, and the parser's CAPITAL rule is skipped (`:925`).

Not tested here: the model second reading (`objectiveAssist.ts`) that runs when the amount or deadline is missing. It needs an LLM. It does not run for capital or hours.

## What this shows

W1i fits the phrase classes it was written for: 100% of the reconstructed batch classes. It does not generalise. On fresh everyday phrasings, 2 of 12 objectives were read fully correctly, and capital and hours fail most often, silently.

## Diagnostics

| question | detects known-bad? | passes known-good? | catches injection? |
|---|---|---|---|
| C01-P | the batch-only recheck would report PASS; this paraphrase set reports **FAIL** | yes | — |
| C01-F (ambiguous request) | — | — | silent nulls, no `unread` entry |

The C01-P recheck planned in the map ("recheck on the next batch") will only detect this if the next batch uses new wordings.
