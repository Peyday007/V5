# Collection: live sources and the report

## Sources (data, `SOURCE_ROWS` in `server/services/feeds/sources.ts`)

There is one definition. `pullDueFeeds`, the pull the Russell tick runs, reads `SOURCE_ROWS`, and
`collect_sources` holds a projection of the same rows (`seeds/index.ts`). These are the rows added
beyond the original three and the GDELT news queries:

| slug | kind | publisher | what it is |
|---|---|---|---|
| `federal-register-proposed-rules` | JSON_API | Federal Register | proposed rules open for comment |
| `federal-register-notices` | JSON_API | Federal Register | agency notices |
| `fda-recalls-rss` | RSS_ATOM | US FDA | recalls and safety alerts |
| `cisa-advisories-rss` | RSS_ATOM | US CISA | cybersecurity advisories |
| `watch-dol-state-minimum-wage` | PAGE_WATCH | US DOL | page-change watch, read once a day |
| `canadabuys-new-tenders-csv` | CSV | Government of Canada (CanadaBuys) | **procurement**: new federal tender notices, open-data CSV |
| `find-a-tender-ocds` | JSON_API | UK Find a Tender | **procurement**: new tender notices, public OCDS API |
| `gleif-new-lei-registrations` | JSON_API | GLEIF | **business register**: newly registered legal entities |
| `osm-houston-factories` | OSM_OVERPASS | OpenStreetMap / Overpass | **OSM category**: named `man_made=works` features in one metro |

None needs a key or any spending. The procurement sources sit outside SAM.gov and need no
registration. Field names, response shapes and notice URLs for the last four were written from the
publishers' documented formats. The authoring session had no network egress (CONNECT 403), so they
were **not** read live from here. A changed or misremembered format cannot pass for an empty
source: a parser that does not find its top-level shape throws `UNPARSEABLE`, and so does a CSV
whose header lacks a mapped column. The pull records that as `failure_cause = 'UNPARSEABLE'`, a
different fact from `NO_MATCHING_RECORDS`.

## Robots/terms: read by the pull, before it asks

`pullDueFeeds` reads the publisher's `robots.txt` itself before it fetches a source
(`robotsGate` in `server/services/collect/seeds/robots.ts`). It records the answer and the time on
the source's `collect_sources` row, creating that row if it does not exist. It does not depend on
anyone remembering to run the `robots` CLI step.

- `ALLOWED` (rules allow the path for `brain-feed`, or no robots.txt at all: 404/410): the source is
  asked. The answer stands for seven days, then is read again.
- `DISALLOWED`: the source is not asked. The pull is recorded `ok = 0`,
  `failure_cause = 'REFUSED'` and held for the source's interval.
- Unreadable (a network error or a non-2xx answer): `UNCHECKED`, not asked, recorded
  `SOURCE_UNREACHABLE`, and retried with the ordinary backoff. Never treated as permission.
- `TERMS_FORBID` is set by a person who read the terms, and a permissive robots.txt does not
  overturn it.

Production always uses the real reader (`robotsReaderFor`). Only a test that injects a fake fetcher
may leave the check out. `tests/collectSeedsLiveProof.test.ts` pins this.

The CLI remains for a deliberate run:

```
npx tsx server/services/collect/report/cli.ts seed     # idempotent insert
npx tsx server/services/collect/report/cli.ts robots   # read robots.txt for every source now
npx tsx server/services/collect/report/cli.ts report   # print figures from rows
```

## Metrics on the live path

Every pull, including a refused one, writes the additive `feed_pulls` columns:

- `method` (kind)
- `wall_ms`
- `memory_bytes` (process RSS when the pull ended)
- `bytes` (measured only for text bodies; a parsed JSON body's wire size is not known, so it is left
  null rather than estimated)
- `duplicates`
- `failure_cause`, from what actually failed: `REFUSED`, `RATE_LIMITED`, `SERVER_ERROR`, `TIMEOUT`,
  `UNPARSEABLE`, `SOURCE_UNREACHABLE`, or `NO_MATCHING_RECORDS` on an empty successful pull
- `cheap_calls = 0` and `claude_jobs = 0` (a pull spends neither)

## Report

Every figure is read from `feed_pulls` / `feed_items`; an unmeasured column prints "not measured".
It shows sources registered and active, pulls and failure rate, records fetched, stored and
duplicate rate, signals, cheap-lane calls, Claude jobs consumed, records never sent to Claude (a
count of stored, un-shortlisted records, not a cost), measured pull time, records/minute, the
slowest or flakiest source as the bottleneck, and the stored baseline alongside.

## Not yet true

No production figure is claimed here. This worker may not deploy. What production now does by
itself, once this code is released, is read and record robots.txt for every row before its first
pull, and store per-pull metrics for every source. The proof is then read from production rows
(`report`, or `collect_sources.robots_status` / `robots_checked_at` and `feed_pulls`) after the
release. That reading has not been taken.
