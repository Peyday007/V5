# Collection benchmark

Harness: `server/services/collect/bench/index.ts` (`measureBulk`, `compareToBaseline`).
Test: `tests/collectBulk.test.ts`. Baseline: `docs/COLLECTION-BASELINE.md` and
`tests/fixtures/collect-baseline/baseline.json`.

Sources are built from registry rows (`sourceFromRow`) with the real `remoteok` and
`remotive` parsers, served by a fake fetcher (no network); the free-model lane is a
counting completer. Counts are deterministic and asserted. Timings and memory are one
SQLite dev-machine run, indicative only, never compared. Nothing is estimated; this is
**not** a production measurement and no real source was pulled by this unit.

## 10,500 fixture records (`companies=1500,filler=4500`)

| figure | value |
|---|---|
| pulls / failed pulls (SOURCE_UNREACHABLE) | 6 / 2 (failure rate 0.333; one source always 503, others unaffected) |
| records fetched / inserted / duplicates | 21,105 / 10,605 / 10,500 (duplicate rate 0.4975) |
| detector records read / signals | 5,000 / 229 |
| records screened by the cheap lane / cheap-lane calls | 60 / 120 |
| rule-covered records sent to the cheap lane | 0 |
| Claude jobs created (`work_items` + `russell_candidates` delta) | 0 |
| incremental pull: fetched / newly stored | 10,605 / 105 (new rate 0.0099) |
| collect / interpret time | 979 ms / 181 ms (incremental pull 175 ms) |
| records/minute (collect, first pull) | about 643,500 |
| heap delta | about 29.6 MB |

## Against the stored baseline (`companies=20,filler=40`)

| figure | baseline | now |
|---|---|---|
| pulls / failed | 6 / 2 | 6 / 2 |
| fetched / inserted / duplicates | 240 / 120 / 120 | 241 / 121 / 120 |
| detector signals | 20 | 20 |
| screened / cheap calls | 40 / 80 | 40 / 80 |
| Claude jobs | 0 | 0 |

The extra fetched/inserted record is the incremental pull's one new record, which the baseline
workload does not have. Unchanged: the 20 cross-source copies are still stored as extra rows
(dedupe in this unit is within a batch only).

## The actual bottleneck (measured, not guessed)

- On fixtures the bottleneck is **collect** at scale (979 ms vs 181 ms) and **interpret** at the
  baseline size; the database insert path (one `INSERT` per record) dominates collect.
- `runDetectors` reads at most **5,000** stored records per rule (`LIMIT 5000`), so on 10,500
  records it sees a slice (229 of up to 1,500 possible signals). That limit belongs to
  `server/services/feeds/detectors.ts`, outside this unit; raising it or paging it is the follow-up.
- The cheap lane is bounded at 60 records per pass at the default pace, so unscreened volume grows
  faster than it is screened; the rules path, not the lane, is what scales.
- Real-network throughput, memory under production load and per-host limits are **not measured**.
