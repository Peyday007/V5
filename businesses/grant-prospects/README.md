# Funder Ledger — Grant Prospect Reports for small nonprofits

A one-time report that tells a small nonprofit which foundations in its state have **actually paid grants
to work like theirs** (recipient, amount and purpose, copied from each foundation's own Form 990-PF, with the
contact and application instructions from the same filing), plus open and forecast federal opportunities on
Grants.gov that match and admit nonprofits. Proof first: the first report is free to anyone who replies.

## Who buys and why

Nonprofits with roughly $100K–$3M in revenue and no full-time grant writer: food pantries, animal rescues,
land trusts, youth programs, small theatres, DV shelters.

- Finding funders is a named, measured pain. In GrantStation's *2024 State of Grantseeking* key findings, the
  greatest challenge was "lack of time and/or staff" (21%), followed by "difficulty in finding grant
  opportunities that matched with specific missions, locations, or programs" (15%); 92% of respondents applied
  for private-foundation funding, and private foundations were the largest source of grant funding for most
  mission areas. Median largest award for small organizations: $10,000.
  <https://grantstation.com/sites/default/files/imageLibrary/SoG/Key%20Findings%20The%202024%20State%20of%20Grantseeking%20Report.pdf>
- The tools that solve it are priced for larger shops (checked 2026-11-11):
  - Instrumentl: Discover $299/mo billed annually or $349/mo monthly; Pre-Award $499/mo; 14-day trial.
    <https://www.instrumentl.com/pricing> (the $179/mo figure in the brief is out of date)
  - Candid Foundation Directory: Premium $219/month, or $1,199/yr at the nonprofit rate ($2,199 standard);
    Ultimate $1,699/yr nonprofit rate. As reported from candid.org/pricing on 2026-10-18 by
    <https://grantsights.com/blog/candid-foundation-directory-pricing>
  - GrantStation: $699/yr list, frequently promoted at $179/yr. <https://grantstation.com/public/about.asp>
  - Consultants: about $100/hour is typical for prospect research and grant help (e.g. one consultant's
    published rate <https://sites.google.com/view/jedijaxllc/services-available>; Givebutter's guide says
    expect $100/hour or more <https://givebutter.com/blog/nonprofit-consulting>). A 10–20 hour prospect
    search is $1,000–$2,000.
- **Honest competition:** free options exist — Candid gives free Foundation Directory access to some small
  nonprofits (<https://learning.candid.org/?p=418917>), Zeffy runs a free grant finder, and ProPublica's
  Nonprofit Explorer is free. Our edge is not data access; it is that the work is done: a ranked, local,
  evidence-backed list with application instructions, in two days, with no subscription or learning curve.

## What we sell (offer.json)

| product | price | what |
|---|---|---|
| Free sample report | $0 | the full report for the org that replies "yes" |
| Grant Prospect Report | $149 one-time | one org, up to three focus areas or a second state; HTML + PDF in 2 business days |
| New-opportunities update | $49/month | monthly re-run: new 990-PF funders + new Grants.gov postings, with a diff |

$149 is half a month of the cheapest database and about 1.5 hours of a consultant.

## Unit economics and a realistic estimate

- Cost to fulfil: ~2 minutes of compute (all data is free and cached) plus ~15 minutes of a person's review
  before sending. Gross margin ≈ 95%+.
- Sending capacity: `DAILY_LIMIT = 5` on the one owner mailbox → ~100 first-touch emails/month.
- Assumptions per 100 first-touch emails (3-step sequence): positive replies 1–3; sample → paid report 25–40%;
  paid → monthly 30%.
- Per 100 sends: 1–3 samples → 0.25–1.2 paid reports → **$40–$180** one-time + 0.1–0.4 subscribers
  (**$5–$20/month** recurring, compounding).
- At 5/day this is a small business: roughly **$50–$200/month** in new revenue at current volume. It is worth
  running because cost is near zero; it becomes meaningful only if the reply rate holds and sending capacity is
  raised (more warmed mailboxes) or referrals from satisfied orgs (state nonprofit associations) appear.

## Data and tools (all free, no API key)

| need | source |
|---|---|
| every private foundation in a state, with assets | IRS EO Business Master File, `https://www.irs.gov/pub/irs-soi/eo_<st>.csv` (foundation code 04) |
| each foundation's latest 990-PF | IRS e-file indexes 2024–2026 `https://apps.irs.gov/pub/epostcard/990/xml/<yr>/index_<yr>.csv` → object id |
| grants paid, recipient city/state, purpose, amount, how to apply | the 990-PF XML (Part XV), via the GivingTuesday 990 data lake mirror `https://gt990datalake-rawdata.s3.amazonaws.com/EfileData/XmlFiles/<object_id>_public.xml` (ProPublica's XML download is behind a bot check) |
| customer profile | ProPublica Nonprofit Explorer API |
| federal opportunities | Grants.gov `search2` + `fetchOpportunity` (posted/forecasted, eligibility 501(c)(3)/other nonprofits/unrestricted) |
| prospects' websites | each org's own 990/990-EZ e-file (`WebsiteAddressTxt`) |
| PDF | Playwright + Chromium |

Ranking: a foundation is listed only if it paid a grant to an in-state organization whose name or stated
purpose matches the focus. Score = matching grants (purpose that names the work counts more than a related one,
e.g. a library for literacy) + heavy weight for grants in the customer's 3-digit ZIP area and foundations based
there + share of giving in the customer's region + total amount; foundations whose giving is concentrated in
another part of the state are down-weighted and flagged; "pre-selected organizations only" funders go in a
separate section. Matching-gift programs and grants whose filed address is the foundation's own are excluded.

Known limits (also printed in every report): only foundations based in the customer's state (the 350 largest
by assets plus smaller ones in the customer's ZIP area); community foundations and corporate giving programs
file Form 990, not 990-PF, so they are not covered; grant lists filed only as PDF attachments are missed;
filings lag 1–2 years. Federal matches are keyword-based; for many small orgs (e.g. literacy, food pantries)
there are honestly few or none open, and the report says so.

## Files

- `build/generate.py` — the report generator: `python3 build/generate.py --ein 232088132 --causes literacy`
  (or `--name "…" --state PA`); writes `samples/<slug>.html|.pdf|.json` (the JSON is every row the report used).
  `--teaser-only` prints the one-line finding.
- `build/grantdata.py` — data access, parsing, cause vocabularies, matching and ranking.
- `build/find_prospects.py` → `build/verify_emails.cjs` → `build/finalize_prospects.py` — the prospect pipeline
  (BMF candidates by NTEE and revenue $120K–$3M → website from the org's own 990 → role email on the org's own
  domain found in the page HTML → manual cause review in `build/prospect_overrides.json` → Chromium render of
  `source_url`, keeping only rows where the email is visible text or a mailto link → teaser computed with the
  generator).
- `samples/` — York County Literacy Council (PA, literacy), Salem Humane Society (OH, animal welfare),
  Gilmer Community Food Pantry (GA, hunger relief).
- `prospects.csv` — 72 verified prospects, 33 states, 14 causes. `campaign.py`, `offer.json`.

## Fulfilment

1. A reply arrives (`python3 businesses/common/outreach.py grant-prospects replies`). If it is a yes, look up the
   row in `prospects.csv` (EIN, state, cause).
2. Run `python3 build/generate.py --ein <ein> --causes <cause>[,<second>]`; open the HTML, skim the top 10
   funders for anything odd (a mis-matched purpose, a funder that obviously never takes applications), adjust
   causes if the org's focus is broader, re-run.
3. Reply with the PDF attached and two lines: the three funders worth contacting first and why. Mention the
   $149 full report (more causes / a second state / help reading it) and the $49/month update, with a payment
   link (Stripe Payment Link created by the owner — not yet created).
4. Paid: re-run with their confirmed focus areas, deliver within 2 business days; for monthly, re-run on the 1st
   and send what changed.

## Measurement, kill and expand rules

- Working: **≥2 positive replies per 100 first-touch sends** and **≥1 paid report per 5 samples sent**.
- Kill: after 200 sends, <1 positive reply per 100, or 0 paid after 10 samples → stop the campaign.
- Fix before killing: bounce rate >5% → re-verify emails; replies but no payment → test $79 and a
  "pay what it was worth" note.
- Expand: if the working bar holds after 200 sends → add causes/states to `find_prospects.py` PAIRS, add a
  second warmed mailbox, and pitch state nonprofit associations a member discount.

## Caveats

- Brand "FunderMatch" (from the brief) is already used by a free funder-search tool (peerpush.com/p/fundermatch),
  so the brand is **Funder Ledger** (no conflict found on search).
- No payment link exists yet; it needs the owner's Stripe account.
- Some foundations' 990-PF addresses are the trust department of a bank (PNC, Wells Fargo); the report shows
  what was filed.
