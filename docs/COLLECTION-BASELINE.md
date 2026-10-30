# Collection baseline

The feeds pipeline as it stood at `b663491`, measured before any collection
behaviour changes. Later benchmarks compare against `tests/fixtures/collect-baseline/baseline.json`.

## What is measured

`server/services/collect/baseline/index.ts` drives the unchanged code —
`pullDueFeeds`, `runDetectors`, `screenFeedLeads` — over a deterministic stored
workload with a fake fetcher and a counting free-model completer. Nothing is
estimated; a figure the harness cannot observe is `null`.

Workload `companies=20,filler=40`: three feed sources (two with records, one that
always answers 503), every body delivered twice an interval apart, 20 employers
each posting three data roles on one source and the same first role again on the
other under different ids and a different spelling of the employer, plus 40
unrelated postings.

## Counts (deterministic — compared exactly)

| figure | value |
|---|---|
| pulls / failed pulls | 6 / 2 (failure rate 0.333) |
| records fetched / inserted / duplicates | 240 / 120 / 120 (duplicate rate 0.5) |
| detector signals (`CONCENTRATED_HIRING`) | 20 |
| records screened by the free-model lane / completer calls | 40 / 80 (two models each) |
| Claude jobs created (`work_items` + `russell_candidates` delta) | 0 |

Reading it: the second delivery of every body is all duplicates, which is the
re-delivery cost. The 20 cross-source copies (same employer and role, different
source id and spelling) are **stored as 20 extra rows** — the baseline has no
cross-source dedupe, which is the gap the clean-and-dedupe unit closes. The 60
records the detector already accounts for skip the free screen; the remaining 40
cost two model calls each.

## Timings (this machine, indicative only)

Collect 25 ms for 240 records, interpret 41 ms, heap delta about 5.3 MB. These
vary by machine and are not compared in tests. The test asserts the counts and
rates only.

## Regenerating

`UPDATE_COLLECT_BASELINE=1 npx vitest run tests/collectBaseline.test.ts` rewrites
the fixture. Do that only when the workload changes, never to make a later
pipeline's numbers match.
