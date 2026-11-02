# The $10K plan — goal `wst_7b4fcbb5f2384f31b6c3`, Nov 3–27, 2026

**Verdict, stated plainly.**

- **Base case (mid-evidence): about $15.7k collected.** Without the mailer it is about $12.2k, so the base case does not depend on the mailer.
- **Adverse case (low end of every published benchmark, mailer fails to fill): about $4.35k.** $8k under adverse conditions is **not** supported. All five gap-closers below together reach about $10.4k within capacity.
- **Nothing here is validated by a sale yet.** Every rate nobody has measured for this operation is swept over its published range, and the kill tests below replace those ranges with real counts by Nov 6–12.

Computed by Brain's scenario engine: `npx tsx fast-cash/10k/plan-model.ts`.

- **Sweep:** 10,000 conditions. The engine labels its shares *coverage of the tested conditions, not probabilities.*
- **"All lines, 3,000 hangers":**
  - collected p10 $8.3k, p50 $12.4k, p90 $16.9k;
  - ≥$9k in 85% of tested conditions, ≥$8k in 92%;
  - fits the 280 person-hour capacity in 96% of conditions.
- **The 6,000-hanger strategies** break the capacity limit in 59–88% of conditions, so they are not the plan.
- **What moves the result most** (rank correlation with contribution): door-hanger response 0.82, then booking rate 0.32, then gift-box orders 0.18.

Evidence files: `fast-cash/10k/research-coop-mailer.md`, `research-brokerage-pooled.md`, `research-remote-puzzle-lines.md`, and `docs/CASH-10K-PLAN-2026-11-02.md` (v1, with local price sources).

---

## 1. Where to sell, and why

**The market is the owner's own metro, whichever it is.** Nothing in Brain's records says the owner is in Pennsylvania. "Pennsylvania" came from the openings Brain's research happened to file. The standing research authorization names Michigan. So the plan is not pinned to a state. It is chosen by two facts that hold everywhere in the US:

1. **Cash timing decides the market, more than demand does.**
   - A new Etsy shop's money is withdrawable about 14 days after each sale.
   - A new Stripe account pays out 7–14 days after its first charge.
   - Teachers Pay Teachers pays November earnings in December.
   - So online sales by a new seller with no audience realistically collect **$0–$500** by Nov 27.
   - Cash, check and in-person card payments settle the same day or the next business day. The money therefore has to come from prepaid, in-person sales.
2. **Execution access decides where.** Every in-person line needs the owner and two helpers on site. The metro is wherever they live.
   - Prices come from **national** published benchmarks.
   - **Day-1 check:** read the same sources for the actual metro (Angi or HomeAdvisor cost pages for the city, the USPS EDDM route map, two local tree lots). If a local price is more than 20% below the national figure used here, cut that line's price to it.

A suburb with freezing winters and detached single-family homes fits all six lines. A dense urban core with no single-family houses fits only lines D, E and F.

## 2. The lines

Labels: **[P]** = published figure, **[E]** = estimate, **[U]** = unmeasured and swept.

### A. Holiday light installation, single-story homes

| | |
|---|---|
| **What's sold** | A roofline plus bush install, Nov 14–Dec 6, with an optional January takedown (+$75). |
| **Buyers** | Homeowners whose usual installer is booked; local pros say they fill by Thanksgiving. |
| **Price** | $249–449 **[P]**: Angi 2025 average $442 (via Jobber); HomeAdvisor $220–683. Plan price $349. |
| **Fulfilment** | The team installs; overflow goes to an insured local crew at ≤70% of price. Subcontract day rates are $150–250 **[P]**. |
| **Cash needed** | About $20 per job in clips **[E]**. |
| **Payment** | 50% deposit at booking, balance on install day. |
| **Contribution** | About 70% self-installed **[E]**; about 25–35% subcontracted. |
| **Capacity** | About 5 person-hours per job. |
| **Main uncertainty** | Ladder liability with no insurance. Hard rule: single-story only, no roof walking. Some states require a contractor registration before taking deposits (NJ, MD and CT do). **Check the owner's state on day 1.** |
| **Kill test** | Fewer than 2 paid bookings by **Nov 12** → drop it; pass interested leads to an insured installer for a referral fee. |

### B. Fresh tree, delivered and set up, removed in January, plus wreaths

| | |
|---|---|
| **What's sold** | A 6–7 ft Fraser fir, delivered and set up Nov 28–Dec 7, hauled away in January, at $159. Wreath add-on $45. |
| **Price** | Comparable delivery services charge $100+ **[P]**; a farm's setup service sells at $149 **[P]**. |
| **Cost** | Tree $70–100 **[P]**: $90 at a farm in 2025, about $100 lot average. Wreath $18.50–30 **[P]**. |
| **Payment and cash** | **Paid in full when booked.** The tree is bought only after payment, so $0 is at risk. |
| **Revenue timing** | Collected inside the window; delivery is an obligation just after it. |
| **Kill test** | No supplier price confirmed by **Nov 6**, or fewer than 8 prepaid trees by **Nov 18** → stop marketing it and fulfil what was sold. |

### C. Fall cleanup: leaves plus single-story gutters

| | |
|---|---|
| **Price** | $129–200 **[P]** (Angi gutter cleaning average $144–168). |
| **Payment** | On the day of the job. |
| **Window** | Ends about Nov 22. |
| **Kill test** | Fewer than 3 jobs by **Nov 9** → drop it and give its door-hanger space to A and B. |

### D. Co-op postcard mailer, 5,000 homes (the local-mailer mechanism, reproduced)

This is a threshold presale: pooled buyers share one fixed cost, and payment comes before any cost.

| | |
|---|---|
| **What's sold** | Up to 14 ad slots on one 9x12 card mailed to every home on chosen carrier routes. Slot price $300–350. |
| **Price evidence** | Asking prices $250–810 per 10k homes **[P]** (a survey of operators); a Cornelius NC rate card at $595 per 10k **[P]**. |
| **Cost** | $2,100–2,760 **[P]**: EDDM Retail postage $0.260 per piece (USPS Notice 123); 9x12 print $744–1,309 per 5,000. |
| **Payment** | Paid before printing. **Minimum 8 paid slots by Nov 12, or everyone is refunded.** The loss if it fails is card fees plus $0–150. |
| **Timing** | Print takes 5–7 business days. Mail lands Dec 1–11, so offers should be for December. |
| **Main uncertainty** | No close rate is published. Vendors say a first card takes 4–6 weeks to fill; the plan gives it 10 days. |
| **Kill test** | Fewer than 3 paid slots from 60+ conversations by **Nov 6** → stop. |

**Owner's decision.** The $2.1–2.8k of print and postage is paid with advertisers' prepaid money, but it is larger than the "$750 newly tied up a week" rule. It runs only if the owner treats customer-prepaid pass-through as not tied up. **The base case reaches $12.2k without it.**

### E. Client gift boxes for local businesses (prepaid)

| | |
|---|---|
| **What's sold** | A $55 box of PA-made (or local-made) shelf-stable food, with a logo card, minimum 10 boxes. |
| **Buyers** | Realtors, insurance agents, financial advisers, dentists, trades. **[P]**: average client gift $43 and median $38 (BPMA); average 2025 employee gift $62 (Tremendous). |
| **Reach** | Phone, walk-in, and CAN-SPAM-compliant email. 81 named West Shore businesses are already listed (`buyers-gift-boxes.csv`); rebuild that list for the owner's actual metro on day 1. |
| **Cost** | $30–40 per box **[E]**; promo distributors average a 37.8% margin **[P]**. |
| **Payment** | Invoice paid before anything is bought. |
| **Kill test** | Fewer than 2 quote requests from the first 40 contacts by **Nov 10**, or no prepaid order by **Nov 17** → drop it. |

### F. Wreath fundraiser brokerage for churches, scouts, clubs and HOAs

| | |
|---|---|
| **What's sold** | Wreaths the organisation resells at $45. The broker sells to the organisation at $30. |
| **Spread** | Nursery group cost $18.50–30 **[P]** (Armstrong, McCarthy). |
| **Payment** | The organisation collects prepaid orders, then pays the broker. |
| **Main uncertainty** | Most schools ran their fall sales already, so the buyers are churches, scouts, clubs and HOAs. **No 2026 wholesale price is published** — get a quote on day 1. |
| **Kill test** | No organisation signed by **Nov 12** → drop it. |

### G. Remote large-print puzzle packs (senior living, churches), by Stripe link

- **Product:** a $29 per-community licence, or a $19–29 church Advent bulletin.
- **Supply side:** 32,200 US residential care communities **[P]** (CDC/NCHS). Existing content is cheap: Activity Connection $199.95/yr, CarePrints about $59/month **[P]**.
- **Fulfilment:** Brain's verified puzzle generator already made the sample (`fast-cash/10k/sample-puzzle-book/`).
- **Expected:** $0–500 by Nov 27. It is kept because it costs nothing and builds December revenue.

### Rejected, with the reason

| Rejected | Reason |
|---|---|
| Etsy custom crosswords | The payout lands after Nov 27. |
| Teachers Pay Teachers | Paid in December. |
| Restaurant placemats | Needs $500+ fronted. |
| Junk-haul and moving brokerage | No margin over existing crews. |
| Snow contracts | Liability through March, and cash mostly after the window. |
| Black Friday arbitrage | Capital and inventory risk. |
| Fundraiser rep commissions | No supplier publishes one; they pay after the window. |
| Pooled swag | Setup costs are per imprint. |
| Buying Angi/Thumbtack leads | Platform bidding, which is excluded. |

## 3. How customers are reached

| Channel | Volume | Rate, swept **[U]** | Published reference |
|---|---|---|---|
| Door hangers covering A, B and C | 3,000, in two batches of 1,500 at about $190 each | 0.4–3% respond; 25–50% of those book | Printers 1–5%; lawn-care 0.4–2%; one operator about 50% close |
| Personal network (owner plus 2 helpers) | 300 people | 2–6% buy | House-list response 5–9% |
| Businesses (E) | 80, or 160 as a gap-closer | 0–4% order; 10–30 boxes each | Cold email reply median 1.6%, average 4.5% |
| Mailer advertisers (D) | 60+ conversations | 0–14 slots | None published |
| Organisations (F) | 30 | 0–10% sign; 30–80 wreaths each | None |

## 4. The two named cases (same formulas as the sweep)

| | Base | Adverse |
|---|---|---|
| Door-hanger response, booking rate | 1.5%, 45% | 0.75%, 35% |
| Personal network buying | 4% | 2% |
| A. Lights ($349 / $299) | $2,814 | $1,037 |
| B. Trees and wreaths | $2,283 | $932 |
| C. Cleanup | $1,693 | $656 |
| D. Mailer (10 slots at $350 / 6 slots, so refunded) | $3,500 | $0 |
| E. Gift boxes (2 orders × 20 / 1 order × 15) | $2,200 | $825 |
| F. Organisations (2 × 50 / 1 × 30 wreaths) | $3,000 | $900 |
| G. Remote packs | $250 | $0 |
| **Collected** | **$15,740** | **$4,350** |
| Person-hours (capacity 280) | 243 | 200 |

**Base case reaching 90% ($9k):**
- It is met with $6.7k of margin.
- Without the mailer it is $12.2k.
- It still clears $9k if hanger response falls with everything else at base: $14.3k at 1.0% ($10.8k without the mailer), $12.9k at 0.5% ($9.4k without the mailer).

**Adverse case reaching 80% ($8k): the gap is $3.65k.** One lever at a time:

| Lever | Collected |
|---|---|
| Mailer fills to 8 slots at $300 | $6.75k |
| A second 3,000 door hangers | $5.84k |
| 160 businesses instead of 80 | $5.18k |
| One more organisation | $5.25k |
| **All five together** | **$10.4k in 263 hours** |

The honest adverse expectation is $4–5k unless the Nov 6–12 counts come in above the low end.

**Money out before any income:** about $250 (the first 1,500 hangers $190, a sample box $45, sample prints $15). Everything else is bought after payment.

## 5. Sequence

| Day | Who | What |
|---|---|---|
| Nov 3 | Owner | Open Square, for same-day in-person and next-day payouts. Apply for the state sales-tax licence. Check the state's home-improvement registration rule. Call 3 tree lots and 2 nurseries for prices. |
| Nov 3 | Brain | Fit the door hanger, the posts, the business one-pager and the mailer rate card to the metro. Build lists of local businesses and organisations. Re-read local prices. |
| Nov 4–8 | Helpers | Hand out 1,500 hangers. |
| Nov 4–8 | Owner | Message 100 personal contacts. Make 40 business contacts. Hold 60 mailer conversations. Contact 30 organisations. |
| Nov 4–8 | — | First cleanups. |
| Nov 6 | — | Kill checks: mailer (≥3 slots), tree supplier. |
| Nov 9 | — | Kill check: cleanup. |
| Nov 9–15 | — | Second hanger batch, only if A, B or C passed. Next 40 businesses. Gift invoices. First light installs. |
| Nov 10 | — | Kill check: gift boxes. |
| Nov 12 | — | Kill checks: lights, mailer minimum, organisations. |
| Nov 13 | — | Mailer to print if ≥8 paid slots; otherwise refund everyone. |
| Nov 16–25 | — | Peak installs. Gift and wreath orders filled. Tree presale pushed through Black Friday. |
| Nov 28–Dec 11 | — | Prepaid trees and wreaths delivered. Mailer lands. |

**If a line fails, its time and door-hanger space go to:**
1. lights, the highest-value ticket;
2. then gift boxes, which are bought after payment;
3. then a second hanger batch.

A failed line costs at most its printing.

## 6. What still needs validation, and the exact test for each

| Assumption | Test | Pass by |
|---|---|---|
| Door-hanger response ≥0.75% | Count QR scans, calls and texts from the first 1,500 | Nov 9: at least 11 responses |
| Booking rate ≥35% | Responses that pay a deposit | Nov 9 |
| Mailer slots sell | Paid slots out of 60 conversations | Nov 6: ≥3; Nov 12: ≥8 |
| Businesses order gift boxes | Quote requests out of 40 contacts | Nov 10: ≥2 |
| Tree and wreath costs | Written prices from a lot or nursery | Nov 6 |
| An organisation signs on | Signed organisations out of 30 | Nov 12: ≥1 |
| Local prices match the national figures | Re-read Angi/HomeAdvisor for the city, and 2 tree lots | Nov 3 |
| Legal: deposits and sales tax | The state's contractor-registration rule; sales-tax licence | Nov 3 |

## 7. From plan to transactions

1. Square account in the owner's name.
2. Print the first 1,500 hangers (≤$190).
3. Start knocking and messaging.

Brain's own email and invoicing (Resend, Stripe, CONTACT_BUYER authority) speed up lines E–G, but **none of the plan waits on them**.
