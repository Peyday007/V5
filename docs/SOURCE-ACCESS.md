# Source access: how research reads public pages

Owner: `server/services/sources/access.ts`. Every research path that opens a
page — the free lane, its capacity pool and the `brain_fetch_source` MCP tool —
calls `readSource`, which returns the same `SourceFetch` the direct reader
always did, plus the route that produced it.

## Routes, in order

| route | when | what is cited |
|---|---|---|
| DIRECT (`fetchForWorker`) | always first, unless the host's own record says it never works there | the page (HTML, text, JSON, XML, and now PDF text) |
| CONNECTOR (`connectors.ts`) | a site with its own public API, added only from measured failures | the page, or the API address when the content differs |
| BROWSER (`browserMcp.ts`) | 403/429/503, empty or thin page, JS shell; only where robots.txt allows the path | the page |
| SITEMAP | 404/410: the page the same site's sitemap or feed now lists for the closest path | the successor page's own address |
| ARCHIVE | gone, blocked or unreadable and the Internet Archive has a 200 snapshot | the `web.archive.org/web/<ts>/<url>` snapshot address |

Connectors registered (each added from a measured production failure):

- `www.find-tender.service.gov.uk/Notice/<id>` — notice pages answer 403 to a
  reader and render empty in the browser; the service's own OCDS API
  (`/api/1.0/ocdsReleasePackages/<id>`) is read instead, as labelled lines.

Never routed around: a private/loopback/metadata address, credentials in the
URL, a port other than 80/443, and 401/402/451. A bot-challenge, block,
login-wall or "not found" page is reported unreadable whichever route fetched
it: the first production comparison showed most browser "reads" of 403 pages
were Cloudflare/PerimeterX block pages, and none of them is a source.

## Why Playwright MCP (2026-11-04)

The owner remembered a starred browser/crawler project named something like
"Look Watch". This session's GitHub access is bound to `Peyday007/V5`, and
`/user/starred` and `/users/peyday007/starred` are both refused ("sessions are
bound to their configured repositories"), so the star could not be read and is
not guessed at here.

| | Microsoft Playwright MCP | Crawl4AI | Firecrawl MCP |
|---|---|---|---|
| licence / cost | Apache-2.0, free | Apache-2.0, free | MCP is MIT, but it is a client of the Firecrawl API: paid cloud, or a self-hosted AGPL stack |
| what runs | one container (Node + Chromium), official image `mcr.microsoft.com/playwright/mcp` | one container (Python + Playwright + Chromium + Redis), REST `/md` and an MCP SSE endpoint | API + workers + Playwright service + Redis to self-host |
| protocol | MCP streamable HTTP, first-party | REST, MCP secondary | MCP over a paid API |
| footprint | runs in 1 GB | 2-4 GB recommended | several services |
| fit | renders a page and returns its visible text through `browser_evaluate`; Brain does its own extraction, verification and citation | better markdown and deep crawling — features Brain's gate does not need | no free self-hosted path that is lighter than the other two |

Selected: **Playwright MCP**, as its own Fly app (`.github/workflows/browser.yml`,
`northline-browser`, Flycast-only private address, auto-stop when idle). It is
the smallest thing that adds JavaScript rendering, it is MCP-native, and it
keeps Chromium off the Brain's 2 GB machine.

## Measuring it

- `npm run admin -- sources show [hours]` — reads, readable by route, what
  DIRECT alone would have read, ms per successful read, hosts still failing,
  the per-host learned route, and the free lane's fragments/claims before and
  after.
- `npm run admin -- sources compare [n]` — re-reads Brain's own recently failed
  URLs with DIRECT alone and with the whole layer, on the production machine.

Both run through the Admin workflow.

## Production results, 2026-11-04

`sources compare 40` on Brain's own failed research URLs (Admin run
41910342590), old reader vs the layer, on the production machine:

- pages read: **3/40 → 20/40** (two of the 20 were block pages that #502 now
  refuses, so 18 genuine). Recovered by: PDF reading (6), the Internet Archive
  (6: g2.com, stockx.com, trade.gov, geibun.co.jp, …), the browser (3: JS-only
  or slow pages), the Find a Tender connector (1), and two transient 403s.
- time per successful read: 0.6 s → 8.2 s. Fallbacks are slow (a render is
  4-8 s, an archive lookup 2-10 s) but they only run after DIRECT failed.
- resources: the comparison process went 178 → 372 MB RSS, mostly PDF
  extraction; Chromium runs on `northline-browser` (shared-cpu-1x, 1 GB,
  stops when idle), not on the Brain's machine.

Live free-lane research, 2 h after vs the 2 h before (Admin run 41911542982):
fragments submitted 2 → 4, "no readable source" failures 6 → 2, verifications
2 → 4, syntheses 1 → 2, claims accepted 2 → 3.

What still fails, and why no route here fixes it:

- **Invented deep links (404)** — most remaining failures (sba.gov, census.gov,
  gsa.gov, business.gov.au, nasscom.in). The archive has no copy because the
  page never existed; the fix is in how candidates are chosen, not how they are
  read.
- **Bot protection** — upwork.com, etsy.com, goat.com, edmunds.com, cars.com,
  railwayage.com serve Cloudflare/PerimeterX challenges to the browser too.
  That is the site's access decision; it is reported, not evaded.
- **ADDRESS_NOT_PUBLIC** — hachettebookgroup.com and herzog.com resolve, from
  production, to an address that is not public; the access check refuses them.
- **PDFs over 8 MB** — refused whole (a truncated PDF does not parse).
