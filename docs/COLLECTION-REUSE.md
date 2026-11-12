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
| feed pipeline | `server/services/feeds/*` (`pullDueFeeds` now also pulls `collect_sources` rows) |

## New in this unit

`server/services/collect/seeds/index.ts` (the sources as data), `seeds/robots.ts` (reads and
records robots.txt), `report/index.ts` and `report/cli.ts` (the report).

## One registry, read by the pull

`SOURCE_ROWS` in `server/services/feeds/sources.ts` holds the sources Brain ships with, and
`SEED_SOURCES` (`collect/seeds/index.ts`) is derived from its shared rows, so the seeds cannot
drift from it; a test holds the two equal.

`collect_sources` is what `pullDueFeeds` reads. With no injected list, a pull covers the code rows
plus every enabled `collect_sources` row its scope may see (`readRegistryRows`: a project's pull
sees the shared rows and its own, and the unscoped loop pulls every row), so **adding a database
row alone makes it pulled**. A row whose slug a code row already defines is left to that row, so
nothing is pulled twice. `sourceFromRegistry` turns a row into a runnable source. When the part of
`parser_id` after the `:` names a parser `sources.ts` has (`json:remoteok`), the row reads exactly
as the code row with that parser. A query-string mapping (`csv:id=Ref&title=Name&url=Link`) feeds
the generic collector for the row's kind. Otherwise the kind's default reading applies. A disabled
row is not pulled. The robots gate and metrics treat registry rows like any other source. If the
registry cannot be read, the code rows are still pulled, and the pull's result reports
`collect_sources` as `SOURCE_UNREACHABLE`. `tests/feedsRegistryConsumed.test.ts` holds all of this.

Still open, and not in this unit's paths: there is no Postgres migration for `131_collect_registry`.
