# Rate card, costs and dates: The Neighbor Card, New Year 2027 edition

Decided 2026-11-11. The one-page PDF for prospects is `mockup/rate-card.pdf`. This
file holds the reasoning behind it and the cost table. **PUBLISHED** means a
figure from a cited page, read 2026-11-11. **ESTIMATE** means my own figure,
with its basis stated.

"The Neighbor Card" is a working name. Rename it freely: it appears in
`build/make_html.py`, `CARD = ...`.

## 1. The product

- **Card.** A 9" × 12" EDDM flat, 14 pt gloss with UV coating, full colour on
  both sides.
- **Delivery.** USPS EDDM Retail to the **4,944 homes** in Zone 1, Camp Hill &
  East Hampden (17011). Zone 2, Hampden Twp West (17050, 4,950 homes), is an
  optional second edition. See `ROUTE-PLAN.md`.
- **Grid.** Each side has a 4 × 3 grid of 2.8" × 2.33" cells, which gives 22 ad
  cells after the masthead, the footer and the USPS mailing panel. The 22 cells
  are sold as 18 spaces:

| Space | Size | Cells | On card | Zone 1 Founding price | Both zones (9,894 homes) |
|---|---|---|---|---|---|
| Standard spot | 2.8" × 2.33" | 1 | 14 | **$295** | $495 |
| Double spot | 5.7" × 2.33" | 2 | 2 | **$525** | $895 |
| Back Premium (next to the address, the first thing seen at the mailbox) | 5.7" × 2.33" | 2 | 1 | **$575** | $975 |
| Front Feature (top-left of the front, under the masthead) | 5.7" × 2.33" | 2 | 1 | **$625** | $1,050 |
| **Full card** | | 22 | 18 | **$6,380** | $10,745 |

**Why these prices.** The research put a slot on a 5,000-home card at $250–$350
(ESTIMATE in `fast-cash/10k/research-coop-mailer.md`, §5B). That range sits
between the Missoula operators' $150 per 2,500 homes and the 9x12 Tools median
asking price of $477 (PUBLISHED, cited there). $295 is the middle of the range,
about **6¢ a home**. That is in the same band as the Valpak and Money Mailer
anecdotes of $250–$650 per 10,000. The premium spaces are priced at 1.8–2.1×
a standard spot, in line with the research's 1.5–2× rule. The both-zone price
gives about a 16% discount over buying each zone separately.

**What is included, and why each term is there.**

- **Category exclusivity.** One business per category per zone, locked in the
  order spaces are *paid*, not promised. Every published operator uses this
  rule.
- **Ad design included.** Advertisers send a logo, an offer and contact details,
  and the owner builds the ad. This removes the main friction ("we don't have an
  ad").
- **Founding price held for the next two editions** if renewed by each sell-by
  date. This sets up renewals; one operator self-reports 60–70% renewal.
- **No sales tax charged.** See `LAUNCH.md` §4.

## 2. Threshold and refund (the presale guarantee)

> The card prints only if at least **10 of the 22 ad cells are paid by Wed Dec 9,
> 2026, 5:00 pm ET**. If not, every advertiser gets a full refund within 2
> business days (by Fri Dec 11, 2026).

A double, Back Premium or Front Feature counts as 2 cells.

Zone 2 has its own threshold: 10 Zone-2 cells, where both-zone buyers count. If
Zone 2 misses it, both-zone buyers are refunded the difference (for example
$495 − $295 = $200 for a standard spot), and their ad runs in Zone 1.

## 3. Costs (Zone 1, 4,944 homes)

| Line | Amount | Basis |
|---|---|---|
| Print 5,000 9x12, 14 pt, UV, 2-sided (Clubflyers) | **$743.99** | PUBLISHED configurator price for 5,000; 10,000 = $1,482.99. Turnaround: 5 or 7 business days. https://www.clubflyers.com/printing/eddm-mailer/9x12/ (read 2026-11-11). The EDDM index page lists 9x12 5,000 "starting at $731.99": https://www.clubflyers.com/printing/eddm-mailer/ |
| Freight from the printer to the owner | **$250** (range $150–$350) | ESTIMATE. Clubflyers lists FedEx Ground and Express but no prices (https://www.clubflyers.com/shipping-options/). Shipment is about 250 lb: 5,000 × about 0.8 oz (9×12 in at about 330 g/m², 14 pt). |
| EDDM Retail postage, 4,944 × $0.26 | **$1,285.44** | PUBLISHED: "EDDM Retail® USPS Marketing Flats currently $0.26 per piece", https://www.usps.com/business/every-door-direct-mail.htm (read 2026-11-11) |
| Bundling supplies (rubber bands). Facing slips print free from the EDDM tool. | $15 | ESTIMATE |
| Ad design, mock-ups | $0 | Built here (`build/`), and the owner builds the ads from the template |
| **Fixed cost, Zone 1** | **$2,294.43** (range $2,194–$2,394) | |
| Stripe card fee per payment | 2.9% + 30¢; Payment Links have no extra fee. ACH is 0.8%, capped at $5. Stripe Invoicing adds 0.4% per paid invoice. Fees are **not returned on refunds**. | PUBLISHED: https://stripe.com/pricing (read 2026-11-11) |

**Zone 2** adds $743.99 print, about $250 freight (or $0 extra if shipped with
Zone 1), $1,287.00 postage and $15, for **about $2,296**.

Printing 10,000 of one design costs $1,482.99. Two different 5,000 runs cost
$1,487.98. Splitting the zones therefore costs **only about $5 more**, so
Zone 2 can be sold as a separate edition.

**Other printers checked 2026-11-11.**
- 55printing shows a full price table only for 6.5x9 (5,000 = $428.57); its
  9x12 has no price on the page (https://www.55printing.com/eddm-postcards-printing/).
- GotPrint and Primoprint show no prices without the JavaScript configurator.
- Click2Mail returned 403.
- One eBay printer listing quoted 5,000 9x12 at $1,018 (low reliability).

Clubflyers is the cheapest readable reputable price. **Before the print order,
get one live quote** from Clubflyers' checkout (with freight to the owner's ZIP)
and one from a local West Shore shop. Both quotes are free.

## 4. Break-even and results (Zone 1)

A Founding standard spot nets **$286.15** after the Stripe card fee.

| Case | Cash in | Stripe fees | Fixed cost | Contribution |
|---|---|---|---|---|
| Break-even | 8–9 standard cells (8 if freight is $150; 9 at the $250–$350 estimate) | | | ≈ $0 |
| Threshold reached exactly (10 standard cells) | $2,950 | $88.55 | $2,294.43 | **+$567** |
| Full card (18 spaces) | $6,380 | $190.42 | $2,294.43 | **+$3,895** |
| Both zones full, all buyers taking both zones (ESTIMATE) | $10,745 | about $320 | about $4,335 | **about +$6,090** |
| Threshold missed, all refunded | 0 net | about 3% of what was collected is lost (fees are not returned) | $0 | **about −$80** at 9 cells |

**The owner never fronts money.** Print is ordered on Fri Dec 11 only if
collected cash is at least $2,950. Postage is paid at the Jan 4 drop from the
same cash. If Stripe holds a new account's payouts, the owner can ask
advertisers to pay by ACH, or run on the schedule's 3 weeks of slack between the
print order and the postage payment.

## 5. Dates: why January, not December

| | December card | **January card (chosen)** |
|---|---|---|
| Selling days before the print order | 7 business days (Nov 12 → Nov 20) | **19 business days (Nov 12 → Dec 9)** |
| Published time to fill a first card | 4–6 weeks (Making Sense of Cents, cited in the research) | 4 weeks: still tight, but in range |
| Print and freight | Over Thanksgiving week (Nov 26–27) | Dec 11 → about Dec 22, with a week of slack before Jan 4 |
| In homes | About Dec 8–16, holiday peak; USPS sets no EDDM standard | About Jan 5–12, after the holiday catalogue flood |
| Best-fit categories | Restaurants, gift cards, spas | Dentists and eye care (benefits reset), gyms (new year), HVAC and plumbing (deep winter), chiropractors, realtors (spring listings), insurance (policy reviews), auto (winter service) |

On the December schedule a beginner would have to sell 10+ prepaid cells in 7
selling days, with no data showing that pace, and then print through
Thanksgiving week. **January is decided.** Revenue is still collected at sale.
Every order is prepaid, so cash arrives from the first sale on, and well before
the Dec 9 sell-by.

A USPS Market Dominant price change has been proposed for about **Jan 17, 2027**
(Marketing Mail about +6%; https://www.quad.com/newsroom/postal-paper-logistics-update-january-2026).
The Jan 4 drop is before that date and is priced at $0.26.

### Timeline

| Date | What |
|---|---|
| Wed Nov 11 | Kit ready (this folder) |
| Thu Nov 12 | Owner sets up Stripe and payment links, fills in the placeholders, rechecks the routes in the EDDM tool, and starts calls and walk-ins |
| Thu Nov 12 – Wed Dec 9 | Selling, about 25 contacts per business day (see `SALES-KIT.md`) |
| **Fri Nov 20** | **Kill test 1** |
| **Fri Dec 4** | **Kill test 2** |
| **Wed Dec 9, 5 pm** | **Threshold and ad-content deadline** |
| Thu Dec 10, noon | Last proofs approved; card files finalised |
| Fri Dec 11 | Print ordered (5-business-day option), **or** all refunds issued |
| about Fri Dec 18 | Printing done (ESTIMATE: 5 business days) |
| about Tue Dec 22 – Wed Dec 23 | Cards delivered (ESTIMATE: FedEx Ground from FL, 2–3 business days); a week of slack covers delays |
| Mon Dec 28 – Thu Dec 31 | Bundle in 50–100s, at most 6" high, with facing slips; buy postage in the EDDM tool |
| **Mon Jan 4, 2027** | **Drop Zone 1 at the Camp Hill Post Office** (Zone 2 at Mechanicsburg) |
| about Jan 5–12 | In homes (ESTIMATE; no USPS standard) |
| Wed Jan 13 | Delivery report to advertisers, plus the February-edition renewal offer at the Founding price |
