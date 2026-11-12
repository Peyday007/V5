# Tabstop Accessibility Reports

Plain-English website accessibility (WCAG 2.1/2.2 AA) audit reports for small
businesses, produced by an automated generator in `build/` and sold by cold
email through the owner's Instantly workspace (`campaign.py`, mailed by
`../common/outreach.py`).

## Who buys, and why

Small businesses with their own websites — online stores, dental and medical
practices, law firms, restaurants, hotels and B&Bs, salons, retailers.

- **Website accessibility claims are common and rising.** Seyfarth Shaw counted
  3,117 federal website-accessibility lawsuits in 2025, up 27% from 2,452 in
  2024, 36% of all federal ADA Title III suits; UsableNet, counting federal plus
  New York and California state courts, reports about 5,000.
  ([Seyfarth Shaw, Mar 2026](https://www.adatitleiii.com/2026/03/federal-court-website-accessibility-lawsuit-filings-bounce-back-in-2025/),
  [UsableNet 2025 mid-year report](https://info.usablenet.com/hubfs/2025-MidYear-Report-FINAL.pdf?hsLang=en),
  [ABA Business Law Today, Aug 2025](https://businesslawtoday.org/2025/08/digital-accessibility-under-title-iii-of-the-ada/))
- **Most sites have detectable failures.** The WebAIM Million (2025) found
  detectable WCAG 2 failures on 94.8% of the top million home pages, averaging
  51 errors per page; low-contrast text (79.1%), missing alt text (55.5%) and
  missing form labels (48.2%) lead. ([WebAIM Million 2025](https://webaim.org/projects/million/2025))
- **The cheap "fix" is discredited.** In April 2025 the FTC finalized an order
  requiring accessiBe to pay $1 million and barring it from claiming its
  automated widget can make any website WCAG-compliant without evidence.
  ([FTC press release, 22 Apr 2025](https://www.ftc.gov/news-events/news/press-releases/2025/04/ftc-approves-final-order-requiring-accessibe-pay-1-million))
- **Other regimes.** The European Accessibility Act applies to consumer
  e-commerce and other services from 28 June 2025 (microenterprises providing
  services are exempt; relevant only to US shops selling into the EU)
  ([Taylor Wessing](https://www.taylorwessing.com/en/interface/2025/accessibility/key-eu-accessibility-act-exemptions-and-the-challenges-they-pose)).
  The DOJ Title II rule (WCAG 2.1 AA) covers state and local governments, not
  private businesses, and its compliance dates were pushed back a year by an
  April 2026 interim final rule
  ([Duane Morris](https://www.duanemorris.com/alerts/doj_extends_ada_title_ii_digital_accessibility_deadlines_one_year_0426.html)).
  We do not sell to public entities.

The buyer's problem: they do not know what is wrong, which items matter, or how
to tell their web person to fix it.

### Competitor prices (checked 2026-11-11)

| Alternative | Price | Source |
|---|---|---|
| accessiBe accessWidget (overlay) | $490/yr (Micro, ≤5k visits/mo) to $3,990/yr | [accessibe.com/pricing](https://accessibe.com/pricing) |
| Manual WCAG audit, small site | ~$1,000–$3,000 for 1–10 pages; $1,500–$7,000 typical for a small site | [digitala11y](https://digitala11y.com/how-much-does-a-web-accessibility-audit-cost), [accessibility.works](https://www.accessibility.works/blog/web-accessibility-ada-compliance-costs-budgeting-guide/) |
| Per-page manual audit | $100–$250 per page | [accessible.org](https://accessible.org/small-business-afford-website-ada-compliant/) |
| Automated monitoring SaaS | ~$50–$300/month | [digitala11y](https://digitala11y.com/how-much-does-a-web-accessibility-audit-cost) |

Our position: far cheaper than a manual audit, honest about being automated
(unlike overlays), and more useful than a free scanner because every issue
comes with the exact element and the code fix, in language an owner can forward
to their developer.

## What we sell (`offer.json`)

| Product | Price | What it is |
|---|---|---|
| Free homepage summary | $0 | One homepage scan (desktop) in a short summary layout (~4-page PDF): counts and top 3 problems with fixes. Sent to anyone who replies. |
| Accessibility Audit Report | **$149** | Up to 10 key pages at desktop (1366px) and mobile (390px): axe-core 4.10.2, scripted Tab traversal (focus order, visible focus, traps), 320px reflow, headings, alt text, labels, landmarks. Each issue: plain English, exact element, WCAG criterion, severity, code fix. PDF + HTML + JSON of every failing element, plus what automation cannot cover. |
| Monthly re-scan | $29/mo | Same pages re-scanned monthly; what was fixed, what is new. |

Never: legal advice, "ADA compliance certification", a promise of protection
from claims, or any claim that we are lawyers. Every report says so in its footer.

## The generator (`build/`)

```
node build/audit.mjs https://example-business.com                 # discover key pages, full report
node build/audit.mjs example.com --pages https://a/,https://a/contact --out out/a
node build/audit.mjs example.com --quick                          # free homepage summary
```

Outputs `report.html`, `report.pdf`, `summary.json` (totals, findings, keyboard
and reflow results, and every failing element) in `out/<host>/` or `--out`.

- `scan.mjs` — loads each page in Chromium (Playwright), dismisses cookie/newsletter
  overlays, injects vendored axe-core (`build/vendor/axe.min.js`, MPL-2.0), runs
  WCAG 2.0/2.1/2.2 A/AA + best-practice rules, Tab traversal (70 stops, compares
  focused vs unfocused styles), 320px reflow, page facts. Timeouts, bot walls
  (403/429/503, "Just a moment…"), error pages and empty renders are recorded as
  **could not scan** with the reason — nothing is inferred for those pages.
- `findings.mjs` — deduplicates instances across viewports, sorts by severity,
  builds the totals and the teaser sentence (exact counts).
- `rules.mjs` — plain-English explanations and concrete fixes for ~60 rules;
  unknown rules fall back to axe-core's own help text.
- `report.mjs` — the report HTML (rendered to PDF by Chromium).
- `prospecting/` — `harvest.py` (candidate businesses from public chamber-of-commerce
  member directories), `prospect.mjs` (homepage scan + email found on the
  business's own site), `build_csv.py` (qualify, re-verify the email in the raw
  HTML of `source_url`, write `prospects.csv`).

## Samples (`samples/`)

Full audits (10-page cap, desktop + mobile) of three real businesses from
the prospect list, in three industries, each with `report.html`, `report.pdf`
and `summary.json`; plus one free-summary example:

| Folder | Business | Pages | WCAG instances (axe-core only) | critical / serious | Problems found | could not scan |
|---|---|---|---|---|---|---|
| `samples/pressroomevents.com/` | The Press Room — event venue, Tacoma WA | 4 (all the site links) | 351 (214) | 12 / 339 | missing alt 8, pinch-zoom disabled 4, no visible focus 137, nameless links 112, contrast 69, colour-only links 14, untitled iframes 4, small targets 3 | 0 |
| `samples/samishbaydental.com/` | Samish Bay Dental — Bellingham WA | 7 | 47 (44) | 0 / 47 | contrast 28, small targets 14, no visible focus 3, nameless links 2 | 0 |
| `samples/stronglawattorneys.com/` | Strong Law — personal-injury firm, Anchorage AK | 10 | 200 (110) | 0 / 200 | contrast 106, no visible focus 84, sideways scroll at 320px 6, colour-only links 4 | 0 |
| `samples/samishbaydental.com-free-summary/` | free homepage summary (4-page PDF) | 1 | 8 (5) | 0 / 8 | — | 0 |

The full PDFs run 10–16 pages.

Spot-checks against the live pages: the Press Room's empty `<a href="tel:…"></a>`
and empty video-play links, and its `maximum-scale=1.0, user-scalable=0`
viewport, are present in the raw HTML; its header links show no focus change
when tabbed (screenshots compared); Strong Law's white-on-#f97800 phone button
measures 2.72:1; Samish Bay Dental's white-on-#dba11c booking buttons measure
2.3:1 and its Instagram tiles are links with `aria-label=""`.

## Prospects (`prospects.csv`)

78 real US businesses in 10 states (WA 17, AL 14, NY 13, AK 8, TX 7, CA 7, IA 4,
MN 3, NC 3, AZ 2) and 12 industries (legal 19, lodging 10, retail 10, restaurant 9,
dental 7, health/physio/chiropractic 6, salon-spa 5, veterinary 4, pet services 4,
home care 2, fitness 1, safety supplies 1).

How the list was made (all reproducible from `build/prospecting/`):

1. `harvest.py` read 238 category pages of 13 public chamber-of-commerce member
   directories → 853 member businesses that link their own website.
2. `prospect.mjs` scanned 412 of those homepages (desktop, axe-core + Tab
   traversal): 182 scanned with an email found, 143 scanned with no email
   published, 87 **could not scan** (bot walls, timeouts, dead domains — recorded,
   never guessed).
3. `build_csv.py` kept a business only if: the email is on the business's own
   domain and literally present on `source_url` (65 confirmed again in the raw
   HTML fetched separately, 13 inserted by JavaScript and confirmed in the rendered
   page — column `email_verified_by`); axe-core itself found ≥ 3 critical/serious
   WCAG instances on the homepage (median 10.5; the focus heuristic does not
   count); not a .gov/.edu/.org or chamber page. `review.json` records the hand
   review that removed 21 chains, franchises, large firms, a utility, a casino,
   cannabis retailers and public bodies, and corrected names/industries.
4. 66 of 78 addresses are role addresses (info@, office@, hello@ …); the rest are
   a named person's address published on their own contact page.

`issues_total` and `critical_serious` are axe-core WCAG instance counts on the
homepage at desktop width; `teaser` is the exact sentence used in the email and
is built only from those counts. Scans were taken 2026-11-11 (`scanned_at`).

## Fulfillment procedure

1. Reply arrives (`python3 businesses/common/outreach.py access-audit replies`).
   "no thanks"/unsubscribe → do nothing further (Instantly stops on reply).
2. "yes" → `node build/audit.mjs <their site> --quick --out out/<host>-summary`,
   open `report.pdf`, spot-check the top 3 issues against the live page (2 minutes),
   reply with the PDF attached and one line offering the full report at $149.
3. They want the full report → send a payment link (Stripe Payment Link or
   invoice, created by the owner; none exists yet — see caveats). On payment:
   `node build/audit.mjs <site> --out out/<host>` (add `--pages` if they name
   pages, e.g. a booking flow), spot-check every critical/serious rule on one
   instance each, send `report.pdf` + `summary.json` within 2 business days.
4. Offer the $29/mo re-scan in the delivery email; re-run monthly with the same
   `--pages` list and send the new PDF with a short "fixed / new / remaining" note.
5. Anything we cannot scan (bot wall, login) is said plainly; we never guess.

## Unit economics and a realistic estimate

Assumptions (stated, not measured yet):

- Cost per report: ~$0 compute (local Chromium); ~20 min of the owner's time for
  spot-check and email; Stripe fee ~$4.62 on $149 (2.9% + $0.30).
- Outreach: `DAILY_LIMIT = 5` new leads/day on one mailbox → ~100 contacts/month.
- Cold email to small-business role inboxes: 1–3% positive replies; 10–25% of
  people who receive a free summary buy the $149 report; 20–30% of buyers add
  monitoring.

Per 100 contacts: 1–3 "yes" replies → 0.1–0.75 sales → **$15–$110 revenue**, plus
occasional $29/mo. At 5/day this is a test, not an income: the first wave of
78 leads will most likely produce 0–2 sales. The value of wave 1 is
the measured reply and conversion rate.

Gross margin per sale ≈ $144 before the owner's time; at 20–30 min per
fulfilled report the effective rate is roughly $290–$430/hour of fulfilment
time, but prospecting time is the binding cost.

## Measurement and kill / expand rules

Read with `python3 businesses/common/outreach.py access-audit status` and `replies`.

- **Kill**: after 150 contacted with 0 positive replies, or 300 contacted with 0
  paid reports, or any complaint that the outreach felt threatening — stop and
  rewrite or retire.
- **Iterate**: positive replies ≥ 2% but no sales after 10 free summaries →
  change the paid offer (price $99, or "fix list for your developer" framing).
- **Expand**: ≥ 3% positive replies and ≥ 1 sale per 100 contacts → raise the
  daily limit, add a second warmed mailbox, and harvest more chambers and
  industries (`harvest.py` ROOTS).
- Track per industry: if one industry (e.g. dental) converts at 2× the others,
  concentrate there.

## Honest limits of automated testing

Automated checks find a large share of common, objectively testable problems —
Deque's study of 13,000+ pages put axe-core's coverage at about 57% of issues by
volume ([Deque](https://www.deque.com/blog/automated-testing-study-identifies-57-percent-of-digital-accessibility-issues/)) —
but they cannot judge whether alt text is meaningful, whether the focus order
makes sense, whether every task works by keyboard or with a real screen reader,
captions, PDFs, third-party widgets inside iframes, multi-step form errors, or
pages behind a login. Our Tab traversal and focus-visibility check are
heuristics: "no visible focus change detected" means the computed outline,
shadow, border, colour and underline did not change, which can miss focus
styles drawn with pseudo-elements. Every report states these limits, and a
clean automated result is never presented as conformance.

## Caveats

- No payment link exists yet; the owner needs a Stripe (or similar) account to
  take the $149 payments.
- Prospects were scanned on the date in `scanned_at`; sites change. Re-run the
  homepage scan before sending a summary.
- Business size was judged from the directory listing and the site (chains,
  franchises, large law firms and public bodies excluded by name list and
  review); a few may still be larger than "small".
