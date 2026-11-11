# Weekly Bid Digest — open federal bids for small contractors

A weekly PDF/HTML digest of open SAM.gov contract opportunities that match one small contractor's
trade (NAICS), set-aside certifications and service area, with recent comparable awards from
USAspending under each one. Sold by email, fulfilled by a script in `build/`, priced below the
software subscriptions it replaces.

## Who buys, and why

Small trade and service firms (janitorial, landscaping, HVAC, electrical, roofing, security,
construction, IT) that already sell to, or want to sell to, federal buyers but have nobody watching
SAM.gov every day.

- **The market is large and reserved for them.** Agencies awarded about **$179 billion** of prime
  contracts — nearly 28% of the total — to small businesses in FY25
  ([SBA FY25 scorecard release, 2026-06-25](https://legacy.sba.gov/article/2026/06/25/sba-releases-fy25-scorecard-small-business-contracting)).
  Much of it is set aside (small business, 8(a), WOSB, SDVOSB, HUBZone) so only they can bid.
- **The buyers are visible.** Every prospect in `prospects.csv` was found as the recipient of a
  $15k–$1.5M federal contract in its trade in the last 18 months (USAspending, small-business
  recipients only) — they bid, so they need the feed.
- **The notices are hard to watch.** In the extract used here, about two thirds of open notices list
  no place of performance (only the buying office), and one trade's notices are spread across
  several NAICS codes and notice types (solicitation, pre-solicitation, sources sought). A small firm
  either checks SAM.gov by hand or pays for a matching tool.

**What the alternatives cost** (checked 2026-11-11):

| service | price | source |
|---|---|---|
| GovTribe | $1,900 per seat per year ($158/mo); Pro $2,100 | [govtribe.com/pricing](https://govtribe.com/pricing) |
| HigherGov | Starter $500/yr (1 user); Standard $2,500/yr | [highergov.com/pricing](https://www.highergov.com/pricing/) |
| BidPrime | $4,600–$9,500/yr per a published plan comparison | [govcontractfinder.com pricing guide (checked 2026-07-20)](https://govcontractfinder.com/tools/government-contracting-software-pricing-guide) |
| GovSpend, Deltek GovWin IQ | custom quote only | same guide |
| BidNet Direct | $0–$1,999/yr by states; federal add-on reported at $149/yr (sources disagree; the page refused our direct fetch, figures are from its search summary — treat as unverified) | [Civic IQ, captured 2026-08-26](https://civiciq.com/blog/civic-iq-bidnet-direct-pricing) |
| SAM.gov saved searches | free, but the firm builds and reads the searches itself | sam.gov |

Honest position: HigherGov Starter ($42/mo equivalent) and SAM.gov's own free alerts are close to
our price. We do not compete on software. We sell a **done-for-you** list: no login, no search to
build, the right NAICS and set-asides already chosen, sources-sought notices included, and the
"who won this last time and for how much" line that the free alerts do not give.

## What we sell (`offer.json`)

| product | price | what |
|---|---|---|
| Weekly Bid Digest | **$49/month** | one trade's NAICS codes, your certifications, home state + neighboring states, every Monday |
| Weekly Bid Digest Plus | $99/month | up to 3 trades or any NAICS list, any states or nationwide, plus a mid-week "closes within 7 days" alert |
| Incumbent and price history report | $79 one-time | 5 years of USAspending awards for one solicitation's NAICS and location |

First two weekly digests free to anyone who replies "yes" — the proof comes before the invoice.

## How it works (`build/`)

| file | does |
|---|---|
| `data.py` | downloads the SAM.gov Contract Opportunities public extract (GSA, data.gov, no key) to `.cache/` at most once a day and reduces it to biddable notices (solicitation, combined, pre-solicitation, sources sought), one row per solicitation number |
| `matching.py` | matches a profile: NAICS, location (place of performance, else the buying office's state — labelled), and set-aside eligibility; computes the outreach teaser |
| `usaspending.py` | USAspending `spending_by_award` (no key): comparable recent awards per notice; cached a day |
| `digest.py PROFILE.json OUT/` | writes `digest.html`, `digest.pdf` (Chromium via Playwright, `pdf.cjs`) and `rows.json` (the exact source rows shown) |
| `verify.py OUT/` | re-reads the raw CSV with the `csv` module (not the generator's pandas path), checks every shown field against the source row with that NoticeId, re-counts the matches independently, writes `verification.json` |
| `profile_from_uei.py UEI OUT.json` | drafts a customer profile from public records: NAICS actually paid under, certifications reported on award records, location |
| `find_prospects.py` | prospects: USAspending small-business recipients by trade × state → the firm's own domain (guessed from its name, accepted only if the page names the firm and its city/state) → a business address on that domain |
| `make_prospects.py` | re-checks each address in a real browser on `source_url`, computes the teaser from the live extract, writes `prospects.csv` |

"Open" = response deadline after the moment the digest is made. A profile's certifications decide
which set-asides it sees; notices set aside for programs it does not hold are counted and left out.

## Samples (`samples/`)

Three real small contractors, each a prospect in `prospects.csv`, with profiles drafted from their
own public USAspending records (`profile_from_uei.py`: certifications as reported on their awards,
home state from the prospect row). Data: SAM.gov extract downloaded 2026-11-11 08:37 UTC.

| firm | trade / extra NAICS | area | certifications (as reported) | open matches | with award history | field mismatches vs source | independent recount | folder |
|---|---|---|---|---|---|---|---|---|
| CBKN Dirtworks (Algodones, NM) | sitework (237310, 238910) | NM + neighbors | WOSB, small business | 12 | 12 | 0 | 12 | `samples/cbkn-dirtworks/` |
| Gerke Electric (Cincinnati, OH) | electrical (238210) | OH + neighbors | SDVOSB, small business | 10 | 10 | 0 | 10 | `samples/gerke-electric/` |
| SRL Total Source (Waldorf, MD) | janitorial (561720, 561790) + 561210 | MD + neighbors | 8(a), SDVOSB, small business | 11 | 11 | 0 | 11 | `samples/srl-total-source/` |

Each folder: `profile.json`, `digest.html`, `digest.pdf`, `rows.json` (the source rows shown) and
`verification.json` from `verify.py`: every title, solicitation number, agency, type, deadline, NAICS,
set-aside and place of performance equals the raw extract row with that NoticeId; no deadline has
passed; the raw-CSV recount finds exactly the notices the digest shows. Notices that announce an
intent to sole-source are labelled as such rather than presented as open competitions.

## Prospects (`prospects.csv`)

**121 firms**, each a small-business recipient of a $15k–$1.5M federal contract in its trade in
the last 18 months (award ID and amount in `evidence_award_id` / `evidence_award_usd`, UEI in
`recipient_uei`). For every row the address is on the firm's own domain and was found **in a real
browser on `source_url`** (110 in the visible page text,
6 as a mailto link, 5 only in the page source; `email_check`).
95 use a role address (info@, sales@, contact@, estimating@ …); the rest publish a named person's business address.
Candidates removed by hand (a large Alaska Native corporation family, an acquired firm, a too-generic name, sites that were not the recipient) are listed with reasons in `make_prospects.py`.

- Trades: hvac 13, staffing 12, janitorial 11, facilities 11, it 11, electrical 10, sitework 9, repair 9, roofing 8, construction 8, landscaping 5, security 5, pest 5, waste 3, painting 1.
- States (20): AL 3, CA 9, CO 4, FL 9, GA 10, HI 2, IL 2, MA 1, MD 5, NC 6, NJ 2, NM 5, NY 4, OH 6, OK 1, PA 1, SC 1, TX 23, VA 23, WA 4.
- `teaser` is computed by `matching.teaser` from the same extract for the firm's trade in its state and
  neighboring states (counts in `open_local`, `open_nationwide`, `open_local_sb_setaside`); where none
  are local it quotes the nationwide count. 110 of 121 have at least one local match.
- Teasers are true on 2026-11-11 08:37 UTC; notices close daily, so rebuild
  (`python3 build/make_prospects.py`) before activating if more than a few days have passed.

## Outreach (`campaign.py`)

Three short plain emails (day 0, +3, +5), no links, no attachments, no tracking, sent through
`businesses/common/outreach.py` from the owner's mailbox, which appends his name, phone, mailing
address and opt-out. The offer is "reply yes for this week's digest for your trade, free". It says
plainly that we are independent and not part of SAM.gov or any agency. `DAILY_LIMIT = 5`.

## Unit economics and a realistic revenue estimate

Costs per customer: data free (public extract and API), compute ~1 minute per digest on this
machine, PDF rendering local. Payment processing ~2.9% + $0.30 ($1.72 on $49). The real cost is
the owner's time: ~15 minutes to set up a profile and ~5 minutes a week to run, spot-check and send
(`digest.py` + `verify.py`), i.e. ~20 minutes a month per customer → ~$140/hour at $49/month.
Gross margin ≈ 96% before time.

Assumptions (cold B2B email to firms that already win federal work; none of these are measured yet):

- 3% of prospects reply "yes" to a free sample over the 3-step sequence;
- 30% of free trials convert to $49/month after two digests;
- 6% monthly churn once paying.

Wave 1 (121 prospects): ≈ 2 trials → ≈ 0–1 paying customer → **$0–$49 MRR**.
At the current `DAILY_LIMIT = 5` (~100 new prospects a month): ≈ 3 trials and ≈ 1 new customer a
month → **about $300 MRR after 6 months, ~$3,500 first-year revenue**. The estimate scales roughly
linearly with sending volume; a few Plus customers ($99) move it up, but no estimate here should be
read as more than the assumptions above until replies are measured.

## Fulfillment

1. **Reply "yes"** → look the firm up in `prospects.csv`; draft its profile with
   `python3 build/profile_from_uei.py <recipient_uei> customers/<slug>.json` (certifications and
   NAICS from public records). Reply asking only to confirm certifications, NAICS and states.
2. **Monday run**: `python3 build/digest.py customers/<slug>.json out/<date>/<slug>` then
   `python3 build/verify.py out/<date>/<slug>` — send only when `field_mismatches` is 0 and
   `open_matches_not_shown` is 0 (or the digest hit its `--max` cap, which it says).
3. **Send** the PDF (HTML inline) from the owner's mailbox as a reply in the same thread.
4. **After the second free digest**: send the payment link ($49/month subscription). No payment link
   exists yet — creating it (Stripe or similar) is the owner's.
5. **Paying**: keep running weekly; cancel = reply "stop".

`customers/` and `out/` hold customers' own data and are git-ignored, like `.cache/`.

## Measurement, kill and expand rules

Read with `python3 businesses/common/outreach.py bid-digest status` and `... replies`.

- **Measure**: positive replies ("yes") per prospect contacted; trial → paid; weekly churn; minutes
  spent per customer per week.
- **Kill**: after 150 prospects have completed the sequence with fewer than 2 "yes" replies, or
  after 10 free trials with no paying customer, stop the business.
- **Fix once before killing**: 0 "yes" after the first 60 → rewrite step 1 around the single
  closest-deadline notice for the prospect's trade instead of the count.
- **Expand**: ≥ 3 trials and ≥ 1 paying customer from the first 150 → add trades and states to
  `find_prospects.py`, raise the daily limit (more mailboxes), and offer Plus to every paying
  customer with more than one NAICS.

## Caveats

- The SAM.gov extract is a daily file; a notice amended or cancelled since the last download can be
  stale for up to a day. The digest says when the data was downloaded and tells readers to confirm
  on SAM.gov.
- Comparable awards are same-NAICS awards at the same city (else state) — a benchmark and a likely
  list of incumbents, not proof of who holds the exact predecessor contract.
- Certifications in a drafted profile are as reported on award records and must be confirmed by the
  customer.
- Brand "Weekly Bid Digest" is descriptive; no trademark search was done.
