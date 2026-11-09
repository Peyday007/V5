> **Superseded 2026-11-09** by [`CASH-10K-PLAN-2026-11-09.md`](CASH-10K-PLAN-2026-11-09.md). Kept as the record of how the plan got here.

# The $10K plan, rebuilt for remote operation — goal `wst_7b4fcbb5f2384f31b6c3`

> **Superseded** by `docs/CASH-10K-BRAIN-PLAN.md`, the plan Brain's own research, construction and quant engine now produce. The owner's constraints carry over unchanged:
> - Freelance marketplaces are not the main business model.
> - No paid API has been added: `package.json` is unchanged since the 2026-11-03 assignment.
> - No government contracts, domain speculation or broken-website plays.
> - $375 per arrangement before proof, $750 a week tied up, $3,000 in all.

**Standing rule** (`server/domain/operatingModel.ts`):
- The business runs entirely online, with AI and software doing as much of the work as possible.
- **The owner does no physical work.**
- Physical work is in scope only when an independent supplier or subcontractor performs it and this operation coordinates it remotely.
- Markets are chosen on demand, margin, fulfilment access, settlement speed, competition and how much can be automated — never on where the owner lives.

The previous seven-line plan rested on the owner installing lights, delivering trees, cleaning gutters and hanging flyers. **It is withdrawn.** Its door-hanger, installation and delivery lines all fail the rule.

## Verdict

**$10,000 of settled cash by Nov 27 is not supported by the evidence under the current limits.**

| Measure | Settled cash |
|---|---|
| Best remote portfolio, p50 (half the outreach on AI setups, the rest on gifts and lists, no ads) | **$3.0k** |
| p10 / p90 of that portfolio | $1.7k / $5.0k |
| Kept after pass-through and tool costs, p50 | $1.4k |
| Highest-revenue mix, p50 (mostly gift brokerage) | $4.2k |
| Highest-revenue mix, p90 | $8.2k |

- The highest-revenue mix reaches **$10k in 4% of tested conditions**. Its revenue is mostly the gift suppliers' money passing through: it keeps $850 at p50.
- These come from Brain's scenario engine (`npx tsx fast-cash/10k/plan-model-remote.ts`; output in `plan-model-remote-output.txt`), a sweep of 10,000 conditions. Its shares are coverage of the tested conditions, not probabilities.

### Demand estimated by the quant engine (2026-11-02, evening)

The sweep above, and the withdrawn local plan's $15.7k base / $4.35k adverse
cases, typed every demand rate in as a hand range; the quant engine (§79) was
never called. `npx tsx fast-cash/10k/demand-model.ts` now pools the published
evidence for each rate, keeps reply, interest and order apart, makes counts
whole and reads total outflows against $3,000 in the same world as the cash
(problem files `plans/quant/cash-10k-demand-*-2026-11-02.json`).

| Plan | Settled by Nov 27, p10 · p50 · p90 | $10k, owner-funded spend only | $10k, all outflows ≤ $3,000 |
|---|---|---|---|
| This plan, half on AI setups | $0.2k · $2.1k · $6.7k | 6% | 0% |
| This plan, mostly gifts | $0.2k · $2.7k · $9.9k | 10% | 0% (gift pass-through) |
| Withdrawn local plan, as written | $3.8k · $6.9k · $11.3k | 17% | 0% |
| Withdrawn local plan, subcontracted | $3.5k · $6.1k · $10.2k | 11% | 0% |

Shares are coverage over evidence-weighted inputs, not calibrated probabilities:
no source states a sample size for this seller. Interested conversations are
p50 6 (p10 2, p90 22), not 10. **90% is not supported by any plan on file.**
Its 10th percentile would have to rise roughly 3–50×.

What blocks a 90% claim: close rates for a new seller (AI setups, gift orders,
lists: no published figure), gift-order size, reply rate for this audience, and
— for anything that passes supplier money through — a $3,000 ceiling on total
outflows that gross collection of $10k breaks.

**The binding constraint is interested conversations, not products or fulfilment.**
- Every remote line sells through one pool of outreach. A warmed mailbox sends about 30 a day safely, LinkedIn allows about 100 invites a week, and a new sending domain needs 2–4 weeks of warm-up.
- About 900 touches by Nov 23 yield about **10 interested conversations** at the median: p10 6.7, p90 14.7.
- At mid-evidence close rates, $10k needs about **41**.
- Settlement narrows it further. A new Stripe account's first payout comes 7–14 days after its first payment, so card sales must land by about Nov 13. Invoices over $1k paid by ACH or wire settle in days.

## The opportunities, each run online

| | What is sold | Who pays | Evidence they pay (published unless marked) | How customers are found | Remote fulfilment and what AI does | Price, cost, settlement | Main uncertainty | Kill test |
|---|---|---|---|---|---|---|---|---|
| **1** | AI receptionist plus missed-call text-back, installed and running | Home-service firms (HVAC, plumbing, roofing), nationally | Agency setup fees $1,500–5,500 and $2,000–4,000 | AI-written outreach from an aged mailbox and LinkedIn; AI builds the prospect list from public business pages | AI configures the voice agent (Retell, about $0.07/min, or a $54.99 reseller seat) and writes the scripts. No subcontractor. | $1,500 setup + $297 first month. About 92% margin. ACH or wire at signing. | Owners are heavily pitched; self-serve versions exist at $50–300/month; text-back needs SMS sender registration, 5 days to 6 weeks | Fewer than 2 booked calls from the first ~200 touches by Nov 9 |
| **2** | Holiday campaign: landing page plus email/SMS sequence | Small e-commerce and local service businesses | $99 (AWeber done-for-you) to A$2,997 | Same pool | AI writes and builds it; the owner only approves | $750–1,500, fully prepaid; last sale about Nov 17 | Late in the season | No sale by Nov 14 |
| **3** | Corporate food-gift brokerage | Small firms sending client or employee gifts | Median client gift $30 (Business.com); employee gift $62 (Tremendous); Wine Country volume tiers 10–15% | Same pool | **Suppliers ship** to each recipient. AI handles quotes, recipient spreadsheets and orders. | Client prepays gross ($690–3,450 an order); a 10–20% fee is kept | Corporate gift budgets are mostly set in October; no published reply-to-order rate | Fewer than 3 interested replies by Nov 12, or no paid order by Nov 17 |
| **4** | Trigger lists, business-level records only (e.g., venues taking holiday bookings, sold to caterers) | Agencies, B2B sellers | Comparables $29–500 per list | Same pool | Brain researches public sources and delivers a CSV | $149–499, about 95% margin, card | Named-person lists would need data-broker registration (CA, OR, TX, VT), so business records only | Fewer than 3 positive replies from 300 sends by Nov 12 |
| **5** | Large-print puzzle licence packs (senior living, church Advent) | Activity directors, churches | Activity Connection $199.95/yr; CarePrints about $59/month | Same pool | Brain's verified puzzle generator; PDF by email | $19–29; PayPal invoice | Cheap content already exists | Fewer than 1 sale from 250 contacts |
| *(dropped)* | Exclusive junk-removal leads sold to contractors | Haulers ($34–43 a lead, 2023) | Service Direct | Facebook lead ads, about $41 per lead | **Contractors do the work**; AI routes each lead | Cost per lead roughly equal to the price a new broker can charge | **The model shows it lowers contribution, so it is out** | — |

**Rejected under the rule or on settlement timing:**
- Everything the owner would perform: installs, deliveries, cleanups, door hangers.
- Etsy and Teachers Pay Teachers: money held 14+ days, or paid monthly.
- Affiliate and referral programs: paid 30–60 days in arrears.
- Supplier sourcing reports: need paid registries or someone on site.
- Appointment setting: can't deliver meetings without warmed domains.
- Moving brokerage: needs FMCSA registration.

Details and sources: `fast-cash/10k/research-*.md`.

## What would make $10k credible

Each item below is a fact the owner holds or a decision that is his; none is a guess.

1. **Four times the interested conversations.**
   - *If the owner already has several aged mailboxes or an existing list:* each additional warmed inbox at 30 a day adds about 600 touches by Nov 23. At the modelled ~1.16 conversations per 100 touches, that is roughly 7 more conversations, and the gap is about 31. So about **4–5 more inboxes** close it.
   - *A warm network of business owners* converts far above cold outreach. No figure is assumed here.
2. **Counting December.** Agency sales take 2–8 weeks. The same pipeline keeps closing after Nov 27, and lines 1 and 2 recur (the $297/month receptionist fee). Starting new inboxes' warm-up now buys capacity from about Nov 24.
3. **Not spending on lead ads.** At published costs per lead they lose money. The $3,000 ceiling is better left unspent than spent there.

## Sequence

| Day | Who | What |
|---|---|---|
| Nov 3 | Owner | Open Stripe and put one live payment through to start its payout clock. Open PayPal Business. Confirm which aged mailboxes and lists exist. |
| Nov 3 | Brain | Build the national prospect lists (public business pages): HVAC/plumbing/roofing firms, small e-commerce brands, firms that send client gifts. Write the offers and sequences. Build the demo voice agent (≤$60). |
| Nov 4–23 | — | About 30 emails a day per warmed inbox and about 100 LinkedIn invites a week, split 50% to line 1, 30% to line 3, 20% to lines 2 and 4. Replies are answered with AI drafts that the owner approves. |
| Nov 9, 12, 14, 17 | — | Kill checks, as in the table. A failed line's share of outreach moves to the best-performing line. |
| Nov 13 | — | Last card sale that settles through Stripe's first payout. After this, invoices over $1k go by ACH or wire. |

## Remaining uncertainties

- Close rates for a new seller with no case studies: none are published; swept 5–25% for setups.
- Reply rate for this offer: swept between the 0.45% and 3.43% benchmarks.
- Whether the owner has aged mailboxes and how many.
- New Stripe account holds.
- How fast SMS sender registration clears.
- Gift-order size: 10–50 recipients.

**Every price above is a published figure. Every conversion rate is swept, not assumed.**

## Previous plan

The local physical-service plan (v1 and v2) is in git history and in `docs/CASH-10K-PLAN-2026-11-02.md`. It is kept as research, not as a plan Brain may execute.
