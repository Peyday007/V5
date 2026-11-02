# Remote B2B brokerage, sourcing and pooled purchasing: holiday 2026 window

Researched 2026-11-02/03 with web search. Labels: **[P]** primary (the company's own page), **[S]** secondary (directory, vendor blog or survey), **[A]** assumption with no source.

Constraints tested: the owner does no physical work; suppliers ship; settled cash by about **2026-11-27**; at most **$300 at risk before income** and **$3,000 total**; no new paid APIs; no freelance-platform bidding.

---

## 0. Cross-cutting facts that decide the ranking

| Fact | Evidence | Consequence |
|---|---|---|
| **Stripe:** a new account's first payout is "typically paid out 7 days after the first successful payment", and up to 14 days in some industries. | [P] [Stripe support](https://support.stripe.com/questions/common-questions-about-payout-schedules), [Stripe docs](https://docs.stripe.com/docs/payouts) | A card payment must land by about **Nov 18–20** to be settled cash by Nov 27. Anything that is paid later is not settled in time. |
| **PayPal:** a new seller's first payments can be held for **up to 21 days**. Early release is at PayPal's discretion. | [S] [Shopify community](https://community.shopify.com/t/how-long-does-paypal-hold-money-after-the-store-receives-payment/270346), [FreshBooks](https://www.freshbooks.com/hub/payments/why-is-my-paypal-money-on-hold) | Do not use PayPal as the collection rail. |
| **Affiliate networks pay in arrears.** CJ pays around the 20th of the following month, on locked commissions only, and current-month commissions do not count. HubSpot pays monthly via Impact after a holding period. Gusto pays within 30 days of the referral's first paid invoice. | [S] [dash.fi CJ review](https://content.dash.fi/blog/cj-affiliate-program-review), [S] [timelines.ai on HubSpot](https://timelines.ai/best-affiliate-programs-hubspot-crm), [P] [HubSpot affiliates](https://www.hubspot.com/partners/affiliates), [P] [Gusto PartnerStack terms](https://gusto.com/legal/terms/partnerstack-terms) | No commission earned in November reaches the bank by Nov 27. This structurally kills (c). |
| **Cold-email deliverability.** A new domain or mailbox needs about **2–4 weeks** of warmup (Warmy, Mailshake), and some guides say 4–8 weeks. The average sender actually warms for 8 days (Smartlead). | [S] [Warmy](https://www.warmy.io/blog/how-long-to-warm-up-new-domains-before-starting-to-send-campaigns/), [Mailshake](https://docs.mailshake.com/article/303-how-does-warmupyour-email-work), [Smartlead](https://www.smartlead.ai/benchmarks/how-long-to-warm-up-email-before-cold-outreach) | Volume outreach from a new domain is not credible before about Nov 10–17. Use an aged mailbox at low volume, or LinkedIn. |
| **Cold-email reply rates.** Belkins measured **0.45%** across about 7.5M cold B2B emails sent in 2025. Apollo's platform average is **3.43%**. Mailshake's most common range is 1–4%. | [S] [Belkins](https://belkins.io/blog/cold-email-response-rates.md), [Apollo](https://www.apollo.io/insights/what-is-a-good-benchmark-for-reply-rates-in-cold-outreach), [Mailshake PDF](https://assets.mailshake.com/wp-content/uploads/2025/04/16091740/Cold-Email-Report-2025-Mailshake.pdf) | 1,000 sends yield about 5–35 replies. The rate at which replies close is **unpublished** [A: 5–15%]. |
| **LinkedIn** allows about 100 connection requests per rolling 7 days. The figure is observed by third parties; LinkedIn does not publish it. | [S] [Salesforge](https://www.salesforge.ai/blog/linkedin-connection-request-limit), [Overloop](https://overloop.com/blog/linkedin-limits) | That is roughly 300 touches before Nov 24. |
| **CAN-SPAM** has no B2B exemption. Cold email is lawful on an opt-out basis if the sender is identified honestly, the subject is accurate, the email carries a postal address, and opt-outs are honoured. GDPR requires a documented legitimate interest. CASL (Canada) is stricter. | [S] [Instantly compliance](https://instantly.ai/blog/b2b-email-list-compliance-gdpr-canspam), [Prospeo](https://prospeo.io/s/is-cold-emailing-illegal) | Target the US first. Leave Canadian recipients out unless there is a CASL basis. |
| **What buyers spend.** Business.com (updated June 2025) found a median of **$30 per client gift**, while clients expect about $100. Tremendous found an average of **$62 per employee** in 2025 (median $25). | [S] [Business.com](https://www.business.com/customers/corporate-gift-study), [Tremendous](https://www.tremendous.com/blog/employee-holiday-gifting-trends/) | A 20-recipient order is about $600–$2,000 in gross merchandise value. |

---

## (a) Corporate holiday food-gift brokerage with suppliers that ship to each recipient

**What is sold.** A done-for-you gifting service. The buyer sends a recipient list (CSV) and a budget. The broker picks gifts and places the order on a supplier's corporate or consumer checkout using the broker's own card, which makes the broker the merchant of record to the client. The supplier ships to each address. The broker sends tracking and follow-up.

**Who pays.** The business client prepays the broker the full amount (retail + shipping + service fee) through a Stripe invoice or payment link. The broker then pays the supplier.

**Supplier evidence (published):**
- **Wine Country Gift Baskets** [P] ([corporate page](https://www.winecountrygiftbaskets.com/information/corporate-gifts.asp)):
  - Volume discounts on a single order: **10% at $4,000–7,999**, **12% at $8,000–11,999**, **15% at $12,000+**. They cannot be combined with other offers.
  - Net 30 on approval, for initial orders over $1,500.
  - Multiple recipients per order are supported, plus an e-gift link where recipients enter their own address.
  - Branded ribbon or card has no minimum and a 24-hour turnaround. A custom program needs 150+ units or $10k and takes 4–6 weeks.
  - No holiday cutoff date is published ("order early").
  - The affiliate program is on CJ. Directories disagree on the rate: 3.2% vs 10% [S] ([revshare](https://www.revshare.so/programs/advertiser/wine-country-gift-baskets-a2342e81), [FlexOffers](https://www.flexoffers.com/affiliate-programs/wine-country-gift-baskets-affiliate-program/)).
- **Hickory Farms** [P] ([b2b](https://www.hickoryfarms.com/b2b/)):
  - Large-order spreadsheet for 10+ recipients, shipped to individual addresses nationwide.
  - Volume discounts "on request". No tiers or payment terms are published.
  - B2BLeads@hickoryfarms.com, 1-800-715-1474. Reply within 24–48 business hours.
- **Harry & David** [P] ([business gifts](https://harryanddavid.com/h/business-gifts/all), [wholesale](https://www.harryanddavid.com/h/wholesale)):
  - Corporate desk at 877-322-1200.
  - The wholesale page targets retailers (150+ wholesale accounts) and does not mention dropship.
  - No reseller discount is published.
- **Goldbelly** has an affiliate program only, at a disputed 1–4% (Impact) or 5–10% [S] ([LinkClicky](https://linkclicky.com/affiliate-program/goldbelly/), [Shopper](https://shopper.com/partnerships/goldbelly-com-affiliate-program)).
- **SnackMagic:** no affiliate or reseller program found.
- **Goody:** a $50 business referral bonus after the referred user's first paid gift [S] ([Goody help](https://intercom.help/goody/en/articles/8545679-how-does-the-goody-for-business-referral-program-work)). That is too small to matter.
- **GiftBasketsOverseas** runs a drop-ship reseller program with a one-time enrolment fee of **$250+** and CSV/XML feeds. The page returned 403, so its terms are unverified [S] ([reseller page](https://resellers.giftbasketsoverseas.com/program_overview.php)).

**Margin reality.** No supplier publishes a reseller discount a newcomer can get on day 1. Wine Country's 10% applies only at $4k+ per single order. Realistically, the broker's margin is an **explicit service fee** of about 10–20% plus the client's own retail cost [A]. The selling line is "we handle the list, the card messages, the tracking and the re-ships". Example: a 25-recipient order at $60 is $1,500 of goods; a 15% fee is **$225 gross profit**, less about $50 in Stripe fees (about 2.9% + 30¢ per charge on the full amount [A: standard US card rate]).

**Finding buyers online.** Target small firms that must thank clients: insurance agencies, mortgage brokers, real-estate teams, CPA firms, law firms, MSPs and dental groups. Use Google Maps / Apollo free-tier lists, LinkedIn (about 100 requests/week), and an *aged* mailbox at about 30–50 sends/day.

**AI automation.**
- Personalised first lines.
- A one-page offer site with 3 curated tiers ($35 / $60 / $100).
- A Stripe payment link per quote.
- A CSV template for recipient lists.
- Suppliers' own multi-recipient upload forms.
- Tracking-number emails.

**Cash timing.** The client prepays, so no money is at risk before income. The broker's card covers the supplier, and the card statement is due after Stripe pays out. **The client must pay by about Nov 18–20** for settlement by Nov 27, because of Stripe's 7-day first payout.

**Uncertainties.**
- No published close rate from cold outreach to a gift order.
- Corporate gift budgets and approvals are often decided in October ([Snappy timeline](https://www.snappy.com/blog/corporate-holiday-gifts-the-complete-planning-timeline)), so November buyers are late deciders.
- Stripe may review or hold a new account that takes a large first ticket.
- Some suppliers may refuse or flag resale on consumer checkout.
- If a supplier ships late or a gift spoils, the broker owns the complaint and the refund (chargeback risk).

**Exact path.**
1. **Nov 3:** Stripe account and a 1-page site. Email the Hickory Farms and Wine Country corporate desks asking for volume pricing and holiday cutoffs.
2. **Nov 3–5:** 300 hand-researched local-business leads. AI-personalised emails from an aged mailbox; LinkedIn in parallel.
3. Quote within 2 hours of a reply. Payment link. Order placed the same day.
4. **Nov 20:** last order that can settle by Nov 27. Orders after that still pay out in early December.

**Kill test.** By **Nov 12**, with at least 400 sends and 150 LinkedIn touches, fewer than 3 interested replies, or 0 paid orders by **Nov 17**, means stop. The Nov 27 cash target is then unreachable on this path.

**Credible settled cash by Nov 27:** **$0–$600 likely** (0–2 small orders × $100–$300 fee). Upside is about $1,000. Money at risk is about $0–$60 (domain or site); no inventory.

---

## (b) Branded merchandise / promotional products brokerage

**ASI-style route — rejected for this window.**
- Distributors average a **37.8%** profit margin (2024, ASI) and 35% gross in Canada (2025) [S] ([ASI 2025 Counselor SOI](https://asicentral.com/press-releases/asi-releases-2025-counselor-state-of-the-industry-promo-trends-tariffs-and-tech/), [ASI Canada](https://members.asicentral.com/news/strategy/october-2026/infographic-key-sales-figures-in-canadian-promo/)).
- Membership has a cost (undated: $150 application + $29.99/mo; ESP+ around $149–199/mo) [S] ([Bizfluent](https://bizfluent.com/how-8238367-asi-number.html), [ASI store](https://store.asicentral.com/Store/Supplier/Package/9)).
- Supplier credit and account setup take time.
- Holiday branded orders typically need **6–8 weeks** of lead time ([Yukon Bags](https://yukonbags.com/blogs/journal/corporate-gift-ordering-timeline)), plus logo proofs and samples.
- Distributor terms are commonly net 30 to the client [A].
- Conclusion: no settled cash by Nov 27.

**Print-on-demand route (Printful), which is viable as an add-on to (a):**
- No minimums. The broker pays Printful per item at order time. Printful ships to each recipient.
- 2025 US holiday cutoffs, which the 2026 page appears to repeat: **Dec 11 standard, Dec 16 express** [P] ([Printful guide](https://www.printful.com/blog/your-holiday-shipping-and-order-deadline-guide)).
- The Growth plan is $24.99/mo for up to about 30% off. This is third-party and conflicting [S] ([ecommerceceo](https://ecommerceceo.com/printful-pricing/)).
- Margin is set by the broker: retail-like pricing on a $15–25 base [A].
- Added latency: the client must supply a vector logo and approve a digital mockup.

**Credible cash:** $0–$300. It is best sold as an upgrade on (a) ("add a logo mug"), not as a separate campaign. **Kill test:** the same as (a).

---

## (c) Affiliate / referral programs paying per closed B2B sale — REJECTED for Nov 27

- **HubSpot:** 30% recurring for up to 12 months, a 180-day cookie, paid monthly via Impact after a holding period [P]/[S] ([HubSpot](https://www.hubspot.com/partners/affiliates), [timelines.ai](https://timelines.ai/best-affiliate-programs-hubspot-crm)).
- **Gusto** (PartnerStack): $300 / $400 / $500 / $700 tiered per successful referral, paid **within 30 days of the referral's first paid invoice** [P] ([terms](https://gusto.com/legal/terms/partnerstack-terms); the snippet was seen in search and the page returned 403).
- **Swag.com:** 6% per sale on ShareASale (now Awin). Its status is "Closed" per affi.io [S] ([LinkClicky](https://linkclicky.com/affiliate-program/swag-com/), [affi.io](https://affi.io/m/swag-com)).
- **CJ** pays about the 20th of the following month, on locked commissions only [S].
- **Other risks:** most programs forbid spam, and approval takes days. A SaaS trial, then conversion, then a paid invoice, then a hold all exceed 25 days.
- **Settled cash by Nov 27: about $0.** It is an option for December or January income only.

---

## (d) Supplier–buyer matchmaking / finder's fees — REJECTED for Nov 27

- **Fees:** finder's fees are typically **5–15%** of deal value and negotiated. Sourcing agents charge 5–10% of order value [S] ([ReferralHero](https://referralhero.com/blog/finders-fees), [Epic Sourcing](https://www.epicsourcing.co/epic-guide/sourcing-agent-cost-fees)).
- **Why it fails:**
  - No published evidence that a new, unknown intermediary gets paid within weeks.
  - The fee is due when the buyer pays the supplier, and wholesale is commonly on net terms [A].
  - It needs a written agreement signed by both sides, and suppliers can bypass the finder.
  - First wholesale orders need samples and qualification, which take weeks.
- **Credible cash by Nov 27: about $0.**

---

## Ranking (credible settled cash by 2026-11-27)

| Rank | Path | Credible settled cash | At risk | Verdict |
|---|---|---|---|---|
| 1 | (a) Food-gift brokerage with a service fee, client prepay by Stripe, supplier ships to each recipient | $0–600 (upside about $1k) | ≤$60 | **Conditional go.** Run the kill test on Nov 12 / Nov 17. |
| 2 | (b-POD) Printful logo add-on sold inside (a) | $0–300 | ≤$25 (optional Growth plan) | Add-on only. |
| — | (b-ASI) Promo distributor | $0 | $150+ | Reject: lead times, membership, net terms. |
| — | (c) Affiliate / referral | $0 by Nov 27 | $0 | Reject for this goal: payout lag of 30–60+ days. |
| — | (d) Finder's fees | $0 | $0 | Reject: deal cycle and payment terms. |

**Honest bottom line.** Nothing here credibly produces a large settled amount by Nov 27. Path (a) is the only one whose cash rails (client prepay, Stripe payout in about 7 days) fit the date. Its weak link is demand: an unknown seller, cold outreach at 0.45–3.4% reply rates, and buyers who mostly decided in October. Treat it as a $0–$600 expected-value bet with near-zero downside.

**Open items to verify by email/phone** (rule-7-style lookups, not owner decisions):
- Hickory Farms and Harry & David volume tiers and 2026 holiday cutoffs.
- Whether they object to a third party ordering for its clients.
- GiftBasketsOverseas reseller margin.
