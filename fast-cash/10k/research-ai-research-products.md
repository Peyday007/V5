# Selling AI-produced research and data products directly — commercial research

Researched 2026-11-02/03 with web search. The operator's limits: settled cash by
**2026-11-27**, no more than $300 at risk before income, no more than $3,000 in total,
no paid data APIs, no freelance-platform bidding, no government buyers, online only.

Source quality: most price points come from vendor pages (PRIMARY for that vendor's own
price, not for the "market rate"). Benchmarks for law, reply rates and warmup come from
vendor blogs (SECONDARY) unless an official page is cited.

---

## 0. Constraints that apply to every option

### 0.1 How long cash takes to settle
| Rail | What a new account gets | Source |
|---|---|---|
| Stripe (new account) | "After you successfully receive your first live payment, Stripe typically schedules your initial payout to complete within **7–14 days**, depending on your industry, country of operation, and risk level." After that, US settlement is 2 business days. | https://docs.stripe.com/payouts (PRIMARY) |
| PayPal (new seller) | "we hold the initial payments you receive for **up to 21 days**". Marking the order delivered can release it sooner. There is also a monthly release limit. Some unofficial reports say digital goods can get rolling reserves of 30–90 days. | PayPal help article help848 (PRIMARY); https://synctrack.io/blog/paypal-money-on-hold/ (SECONDARY) |

**What this means:** with a new Stripe account, the first charge has to land by about
**Nov 13** to settle safely by Nov 27 (or Nov 20 at the 7-day best case). An existing,
already-paid-out Stripe or PayPal account avoids the first-payout delay. Use one if the
operator has it.

### 0.2 Cold email from a new domain is too slow for Nov 27
- A new domain needs 3–4 weeks of warmup, and 4–6 weeks before sending at any
  meaningful volume. Ramp from 5–10 to 25–40 emails per inbox per day
  (https://www.mailreach.co/blog/how-to-warm-up-email-domain,
  https://leadhaste.com/blog/email-warmup-for-new-domains, https://syncgtm.com/blog/how-long-to-warm-up-email — SECONDARY).
  A domain bought Nov 3 is ready around Nov 24–Dec 1. That misses the window.
- The only usable outbound is the operator's **existing, aged mailbox** at low volume
  (≤30–40 per day, personalised), plus warm channels: LinkedIn, niche communities, and
  replies to public "looking for leads" posts.

### 0.3 Funnel benchmarks
- Instantly's platform-wide average reply rate is **3.43%**. About **14.1%** of replies
  are positive, which gives a positive reply rate of about **0.48%**, or roughly
  **5 positive replies per 1,000 cold emails**. Boomerang puts it at 0.3–0.6% positive
  (https://www.getboomerang.ai/glossaries/cold-email-reply-rate-benchmarks-2026;
  https://www.apollo.io/insights/what-is-a-good-benchmark-for-reply-rates-in-cold-outreach — SECONDARY).
- Saleshandy's Jan–Jun 2026 average is 3.7%; the top 10% reach 10%+
  (https://saleshandy.com/blog/cold-email-statistics/).
- Capacity at 40 emails/day from 1 aged inbox × ~8 business days (Nov 4–13) is
  **about 320 sends**. At benchmark rates that is **2–3 positive replies**, maybe 3–6
  with a strong free sample. That means **0–2 sales**. This volume limit, not
  production capacity, is what caps every option below.

### 0.4 Law for anything that contains contact data
- **CAN-SPAM** has no B2B exemption. Every email needs an accurate sender, a physical
  address and a working opt-out. The FTC kept 2025 penalty levels for 2026 (Federal
  Register 2026-18853). Secondary sources give **$53,088 per email**
  (https://public-inspection.federalregister.gov/2026-18853.pdf; https://prospeo.io/s/can-spam-penalties-per-email).
  This applies both to the operator's own outreach and to how buyers use the lists.
- **CCPA/CPRA:** the B2B contact exemption **expired on 2023-01-01**. Business
  contact details of California residents are now ordinary personal information
  (https://instantly.ai/blog/b2b-email-list-compliance-gdpr-canspam — SECONDARY).
- **California Delete Act — this is the deal-breaker for named-person lists.** A data
  broker is "a business that knowingly collects and sells to third parties the personal
  information of a consumer with whom the business does not have a direct
  relationship". There is **no minimum business size**.
  - A broker that starts in **Nov 2026** pays a **$1,000** access fee (Dec: $500) plus
    card processing, then registers each January (2026 fee $6,000; a $9,500 increase
    has been voted for a later year).
  - Penalties are administrative fines. The agency runs a "Data Broker Strike Force".
  - Sources: https://privacy.ca.gov/drop-for-data-brokers/account-creation-fees-and-annual-registration/ (PRIMARY),
    https://legiscan.com/CA/text/SB362/id/2839527,
    https://www.crowell.com/en/insights/client-alerts/california-privacy-agency-launches-data-broker-strike-force-amid-delete-act-crackdown
- **Oregon** (HB 2052) requires registration *before* selling brokered personal data,
  with **no threshold**. **Texas** requires registration with a $100/day penalty.
  **Vermont** requires annual registration
  (https://www.cozen.com/news-resources/publications/2024/new-data-broker-laws-in-texas-and-oregon,
  https://technologylaw.fkks.com/post/102j4kl/dont-forget-to-register-as-a-data-broker-in-texas — SECONDARY).
- **GDPR (if EU/UK buyers or subjects):** cold B2B email can rely on legitimate
  interest, but only with a documented assessment. Germany is reportedly stricter
  (opt-in, UWG §7; one source only, unverified).
- **What follows:** selling lists of **named people with personal emails or phones**
  is likely data brokering. That costs $1,000+ in California alone, which breaks the
  $300 cap, and it is `LEGAL_RISK` under rule 11.

  **Permitted shape: entity-level business records only.** That means:
  - business name, address, website, main phone
  - generic role inboxes (info@, sales@)
  - the trigger evidence and its source URL
  - optionally the *name and title* of the owner as published on the business's own
    site or a public filing, with no personal contact field

  Whether a sole proprietor's published name counts as personal information is still
  **uncertain**. The conservative rule is to omit people entirely, or give only a role
  (e.g. "Owner — see website/About page").

  A "commissioned research, client-specified criteria" structure (Brain acting as a
  service provider) *may* fall outside "selling". That is a legal question nobody has
  answered here, so do not rely on it.

### 0.5 What the competition looks like
- **Apollo** has a free tier with sizeable credits; paid Basic is about **$49–59 per
  user per month** (https://www.zeliq.com/blog/apolloio-pricing, https://www.costbench.com/software/sales-intelligence/apollo-io/free-plan/ — SECONDARY).
  A buyer who can use Apollo will not pay much for generic firmographic lists.
- Apify actors scrape new-business filings, permits and restaurant licences for
  **$3–10 per 1,000 records** (https://apify.com/scrapemint/new-business-registration-leads,
  https://apify.com/rook-data-tools/new-food-service-license-leads).
- So the value has to come from *judgement-heavy* research that scrapers and databases
  do not do:
  - finding the trigger across many messy sources (event venues taking holiday
    bookings, businesses "opening soon" announced on social or news)
  - qualification
  - a written "why now" line per record with a source

---

## 1. Ranked options (by credible settled cash by Nov 27)

| Rank | Option | Price point | Credible settled cash by Nov 27 | Verdict |
|---|---|---|---|---|
| 1 | (a) Custom trigger-based B2B list, entity-level, one-off | $149–$499 | **$0–$1,000** (most likely $0–$300) | Proceed **only** as a 10-day test |
| 2 | (d) Weekly niche lead feed subscription | $49–$149/mo | **$0–$300** (first-month charges only) | Upsell from #1; do not lead with it |
| 3 | (b) Fixed-price market/competitor report | $99–$399 | **$0–$400** | Weak; buyers are scattered and trust is low; test only through warm networks |
| 4 | (c) Supplier sourcing report for e-commerce sellers | $49–$149 | **~$0** | **Reject for this window** |
| — | Named-person contact lists sold broadly | — | — | **Reject** (data-broker registration ≥$1,000 in CA; LEGAL_RISK) |
| — | Selling any of these through Fiverr/Upwork gigs | — | — | **Reject** (owner rule; also gigs anchor at $30–$400) |

Overall judgement: **none of these is a credible path to large settled cash by Nov 27.**
The binding limit is how many buyers can be reached (no warmed domain, 7–14 day
first payout), not production. Option 1 is the only one worth a bounded test, and it
should be treated as a lottery ticket at **≤$50** at risk.

---

## 2. Option (a): custom trigger-based B2B prospect lists (entity-level)

**What is sold.** A one-off spreadsheet of 100–300 businesses matching a buyer's
trigger, with source URLs and a "why now" note per row. The best-fit triggers for
November:
- venues and businesses taking **holiday-party / NYE event bookings**, sold to
  caterers, DJs, photo-booth and rental firms
- **newly opened / opening-soon restaurants**, sold to POS resellers, food and beverage
  distributors, linen and uniform services, local agencies
- companies **hiring for a function** (e.g. first marketing hire), sold to agencies
  and fractional consultants
- **recently funded startups**, sold to agencies and recruiters

**Who pays.** Small agencies, B2B sales reps at vendors that sell to new businesses,
and independent recruiters.

**Evidence buyers pay (published, outside freelance marketplaces):**
| Comparable | Price | Source |
|---|---|---|
| Custom list-building services (range) | **$0.50–$5.00 per contact**; another estimate is $0.10–$0.50 per contact, with custom projects in "low four figures" | https://prospeo.io/s/list-building-service ; https://www.cleanlist.ai/blog/2026-10-30-b2b-lead-services (SECONDARY) |
| Flat-rate custom list (one vendor) | **$500 per list**, 48h delivery | https://lumen-data.pages.dev/ (vendor, unverified) |
| Data brokers, per record | $0.10–$0.45 per record | https://prospeo.io/s/buy-business-leads |
| Fully loaded cost per usable contact | "$0.30 record → $1.40 usable" | https://hub.causo.ai/guides/buy-vs-build-lead-list-cost-2026 |
| One-off weekly DFW new-business CSV | **$29** per file | https://www.getly.store/product/dfw-new-business-leads-weekly-csv-of-newly-permitted-dallas-fort-worth-businesse-mv5g0dxe |

None of these vendors publish revenue, so there is no evidence of how large the
market is. The $29 single-file price shows the floor for generic public-record lists.

**How customers are found (fits the timeline):**
- the operator's existing aged mailbox, ≤40 personalised sends per day, each with
  **10 free sample rows** for the prospect's own niche and city
- LinkedIn DMs to agency owners
- replying to public "need leads for X" threads (r/sales, r/agency, Indie Hackers,
  niche Slack/Discord communities), respecting each community's rules
- Expect 0.5–1.5% positive replies (§0.3).

**Checkout.** Stripe Payment Link or invoice, sent the same day as a positive reply.
Use an existing account if there is one (§0.1).

**Remote AI fulfilment.**
- Brain does the sourced research passes: trigger discovery from news, venue websites,
  social posts, public licence datasets, and job-posting pages.
- It qualifies each record, writes the "why now" line and source URL, and dedupes.
- Delivered as XLSX/CSV within 24–48h.
- No paid data APIs, so there is no email verification service. Deliver only
  published generic inboxes and state that.

**Cost and margin.** About $0–$15 (domain not needed if using the aged inbox; Stripe
fee 2.9% + 30¢). Margin is about 95%.

**Cash timing.** A sale by Nov 13 settles by Nov 27 on a new Stripe account. A sale
after about Nov 18 probably does not.

**Uncertainties.**
- Buyers expect named decision-makers with direct emails, and we deliberately omit
  those (§0.4), which lowers value against Apollo's free tier.
- The reply rate for a "free sample" offer is unmeasured.
- Whether a published owner name counts as personal information.
- No proof that agencies pay $149+ for entity-level lists.

**Exact path.**
1. **Nov 3:** pick 2 niches (holiday-event venues for event vendors; new/opening
   restaurants for POS/food vendors) × 3 metros. Brain builds a 25-row sample for each.
   Make a one-page offer (Stripe Payment Link: $199 for 150 rows, $349 for 300 rows).
2. **Nov 4–13:** Brain researches 300 buyer businesses (published company inboxes
   only) and drafts personalised emails. Send ≤40 per day from the aged inbox with a
   CAN-SPAM footer, plus 10–20 LinkedIn DMs and community replies per day.
3. On a positive reply: send 10 free rows for their exact territory, then the payment
   link. Deliver within 48h of payment.
4. Offer the weekly refresh (§5) at checkout.

**Kill test.** If by **Nov 12** there are ≥300 targeted sends and fewer than 3 positive
replies, or no paid order, stop. Cash after that date cannot settle on a new Stripe
account. Maximum spend at the kill point: about $15.

---

## 3. Option (d): recurring niche lead feeds (weekly)

**What is sold.** A weekly CSV/email of new entities matching a trigger in a territory,
built from public sources, which may include government open data such as permits and
licences. Examples:
- new commercial permits, sold to contractors and suppliers
- new food-service licences / restaurant openings
- new business filings, sold to insurance agents, accountants, merchant-services reps

**Who pays.** Local vendors and sales reps; insurance agents are a proven buyer
segment (DataSignal AI targets Florida insurance agents).

**Evidence buyers pay (published prices):**
| Comparable | Price | Source |
|---|---|---|
| PermitGrab (permit leads) | **$149/month flat**, 14-day trial | https://www.saashub.com/permitgrab |
| DataSignal AI (Florida leads) | **$99 / $249 / $499 per month**; $149/mo for up to 500 leads/month | https://datasignalai.pages.dev/insurance/ |
| Bellows (public-record events incl. new filings) | **from $49/month** | https://bellows.pages.dev/ |
| NYC newly licensed restaurant dataset | **$999/month**, daily | https://csvfirst.pythonanywhere.com/csv/nyc-newly-licensed-restaurant-dataset/ |
| Chain Store Guide Restaurant Franchisee PLUS | **$1,800/year** | https://chainstoreguide.com/category/restaurant-franchisee-leads |
| Starfleet Media pre-opening restaurant reports (2021, dated) | under $200/month | https://starfleetmedia.com/solutions/preopening-restaurants-resource/ |
| Richmond BizSense (incl. weekly new business licences) | $15/month | https://richmondbizsense.com/?p=142744 |
| North Dakota SoS new-business records | $40 per type per month | https://www.sos.nd.gov/node/3982 |

Many small players exist, which shows demand but also price pressure. Apify actors sell
the same raw records for $3–10 per 1,000.

**Customers, checkout, fulfilment.** Same as option (a). Stripe Subscriptions; Brain
runs the weekly pull, qualification and delivery automatically.

**Cost and margin.** About 95%.

**Cash timing.** Only the first month's charge falls in the window. At $49–$149 each,
even 3 subscribers is $150–$450 *before* the payout delay. That cannot carry a cash
goal by Nov 27; the value is recurring revenue after the window.

**Uncertainties.**
- Churn.
- Competition from cheap scrapers.
- Some cities and states restrict commercial reuse or charge for bulk records. Check
  each dataset's terms before using it.
- Selling to a government buyer is excluded, but using government data is fine.

**Exact path.** Attach to option (a): every option-(a) buyer is offered "this list,
refreshed weekly, $99/mo". Do not run separate acquisition.

**Kill test.** No paid conversions among option-(a) buyers by Nov 20 → drop it.

---

## 4. Option (b): fixed-price market and competitor research reports

**What is sold.** A 10–25 page sourced report on a market or local competitors (pricing,
offers, reviews, positioning) for a small business, a founder validating an idea, or a
small investor screening a sector.

**Evidence buyers pay (price anchors):**
| Comparable | Price | Source |
|---|---|---|
| FMeasure startup analysis (automated) | **$69.99 per report** | https://www.fmeasure.com/market-research |
| Fixed-price automated AI report | **$15 per report** | (vendor listing in search results; low confidence) |
| Contra competitor analysis (Quarkixs) | **from $225**, 2 days | https://contra.com/s/LqPO3YL3-competitor-analysis-report |
| Fiverr AI market research (reference only; channel excluded) | $30–$400 | https://fiverr.com/ameliaolive/do-a-comprehensive-market-research |
| Nexus Intel AI consultant-style | $5,000–$12,000, 3–5 days | https://nexusintel-ftat9hqt.manus.space/ |
| IBISWorld subscription (incumbent) | avg SMB spend about $10,319/yr | https://www.spendhound.com/marketplace/ibisworld-pricing |

The prices split in two: automated reports at $15–$70, which are commoditised, and
consultant reports at $800–$12k, which need trust and references we do not have.

**How customers are found.** Scattered buyers with no clear trigger. Possible channels
are founder communities (Indie Hackers, r/startups, r/smallbusiness) and SEO, but SEO
is too slow for this window. Cold email to small businesses offering "a competitor
report" reads as spam and converts below benchmark.

**Fulfilment.** This is Brain's strongest fit (sourced reports, about 1–3 research
passes each). Cost is about $0; margin about 97%.

**Cash timing.** A sale needs a trust-building conversation first. Getting one by
Nov 13 is unlikely.

**Exact path, if tested at all.** Post 1–2 genuinely useful *free* sample reports in
founder communities (rules permitting), with a $149 "custom version for your market"
Stripe link. Run it in parallel with option (a), with no spend.

**Kill test.** No paid order by Nov 13 → stop.

---

## 5. Option (c): supplier sourcing reports for e-commerce sellers

**What is sold.** A shortlist of 3–10 manufacturers or wholesalers for a product, with
MOQ, price signals, certifications and red flags.

**Price anchors:**
| Comparable | Price | Source |
|---|---|---|
| Per-supplier verification report (real manufacturer vs trading company, licence, registered capital) | **$49** | https://china-sourcing-agent.pages.dev/pricing (vendor) |
| 3+ factory quote comparison | **$99** | same |
| Supplier audit / single product / monthly | **$100 / $300 / $500 per month** | https://www.maplesourcing.com/china-sourcing-agent-fees-complete-cost-breakdown.html |
| Agency retainers | $1,000–$5,000 per month | same |

**Why it is rejected for this window.**
1. The service buyers value is verification: licence checks in Chinese registries,
   samples, negotiation, and on-site QC by SGS/QIMA. Reliable Chinese registry lookups
   (Qichacha, Tianyancha) are mostly paid or need a login, which breaks the no-paid-
   data rule. Physical inspection breaks the no-physical-work rule.
2. Without verification, the product competes with free Alibaba / Made-in-China
   search. A wrong recommendation (a scam or trading company) creates liability and
   refunds.
3. Buyers are found through Amazon-FBA and Shopify communities that are crowded with
   agents, and trust takes longer than 10 days to build.

**Kill test.** Not started.

---

## 6. Bottom line for the planner

- **Expected settled cash by Nov 27 from this whole family: about $0–$500.**
  Optimistic case about $1,000. The constraint is reach and payout timing, not
  production.
- Run option (a) + upsell (d) as a **≤$50, 10-day test**, ending Nov 12, from an
  **existing aged inbox** and an **existing Stripe/PayPal account** if one exists.
  Deliver **entity-level data only** (no personal contact fields), which avoids
  CA/OR/TX/VT data-broker registration.
- If the test produces ≥1 paid order, keep option (d) running after Nov 27 as
  recurring revenue. It does not count toward the Nov 27 goal.
- Rule-11 flag: selling named-person contact lists is `LEGAL_RISK` (data-broker
  registration ≥$1,000 in CA, no threshold in OR). Do not proceed without the owner's
  explicit decision.
