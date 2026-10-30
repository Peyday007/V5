# Collection: what was reused

## Peyday007/V2 (Next.js/Supabase dispatch board)

**Not inspected. Nothing was ported from it.** The bin that built this names only
`https://github.com/Peyday007/V5` as an acceptable source and lists every other repository as
excluded, and a worker may not widen its own access, so V2 was not attached or read. This is a
gap in the record, not a finding that V2 has nothing reusable. Someone with access should read
V2's scraping, lead-gathering, enrichment, de-duplication and source-management code and
record here what is worth porting.

## Reused from this repository (extended in place, not rebuilt)

| need | owner reused |
|---|---|
| source registry table, public/private visibility, robots status | `server/repos/collectSources.ts` (`addCollectSource`, `listCollectSources`, `setRobotsStatus`) |
| how a response becomes records | `server/services/collect/collectors/*` (`collect`) |
| per-pull metrics | `server/repos/collectMetrics.ts` (`recordPullMetrics`, `readSourceMetrics`) |
| the baseline | `docs/COLLECTION-BASELINE.md`, `tests/fixtures/collect-baseline/baseline.json` |
| feed pipeline | `server/services/feeds/*` (unchanged here) |

## New in this unit

`server/services/collect/seeds/index.ts` (the sources as data), `seeds/robots.ts` (reads and
records robots.txt), `report/index.ts` and `report/cli.ts` (the report).

## Two registries exist and should be reconciled

`server/services/feeds/sources.ts` now carries its own `SOURCE_ROWS` (in code), while the database
registry `collect_sources` is what this unit seeds. Nothing in the base calls `listCollectSources`
to pull, so today the seeded rows are data that no loop consumes. A follow-up unit must make
`pullDueFeeds` read `collect_sources` (through `collect()` and `recordPullMetrics`) and retire the
duplicate in-code rows.
