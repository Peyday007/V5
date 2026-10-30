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

## One registry definition

`SOURCE_ROWS` in `server/services/feeds/sources.ts` is the only place a source is defined, and it is
what `pullDueFeeds` pulls. `SEED_SOURCES` (`collect/seeds/index.ts`) is derived from its shared rows,
so the `collect_sources` table cannot be seeded with a different list; a test holds the two equal.
Still open, and not done here: `pullDueFeeds` does not yet read `collect_sources`, so adding a database
row alone does not make it pulled, and there is no Postgres migration for `131_collect_registry`.
