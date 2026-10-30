# Collection: live sources and the report

## Sources (data, `server/services/collect/seeds/index.ts`)

| slug | kind | publisher | basis |
|---|---|---|---|
| `fr-proposed-rules` | JSON_API | Federal Register | public API, no key |
| `fr-notices` | JSON_API | Federal Register | public API, no key |
| `fda-recalls-rss` | RSS_ATOM | US FDA | public RSS |
| `cisa-advisories-rss` | RSS_ATOM | US CISA | public RSS |
| `grants-gov-new-opportunities` | RSS_ATOM | Grants.gov | public RSS (funding, **not** procurement) |
| `watch-dol-state-minimum-wage` | PAGE_WATCH | US DOL | public page, one read a day |

Six sources, three kinds, none needing a key or spend. No procurement/RFP feed outside SAM.gov
registration was found that could be named with confidence, so none is claimed. No OSM category or
CSV dataset source is seeded.

## Robots/terms

Seeding leaves every source `UNCHECKED`, which the registry never treats as due. The check must
run where there is network egress; the authoring session had none (CONNECT 403), so **no robots.txt
was read and none is claimed checked**.

```
npx tsx server/services/collect/report/cli.ts seed     # idempotent insert
npx tsx server/services/collect/report/cli.ts robots   # read robots.txt, record answer and time
npx tsx server/services/collect/report/cli.ts report   # print figures from rows
```

An unreadable robots.txt stays `UNCHECKED`; a disallow is recorded `DISALLOWED`; a 404 is recorded
`ALLOWED` with the note that none exists.

## Report

Every figure is read from `feed_pulls` / `feed_items`; an unmeasured column prints "not measured".
It shows sources registered and active, pulls and failure rate, records fetched, stored and
duplicate rate, signals, cheap-lane calls, Claude jobs consumed, records never sent to Claude (a
count of stored, un-shortlisted records, not a cost), measured pull time, records/minute, the
slowest or flakiest source as the bottleneck, and the stored baseline alongside.

## Not yet true

These sources are **not running in production**: nothing in the base pulls from `collect_sources`
(see `docs/COLLECTION-REUSE.md`), and robots has not been checked. The production verification
needs the follow-up wiring, a deploy, then `seed`, `robots` and `report`.
