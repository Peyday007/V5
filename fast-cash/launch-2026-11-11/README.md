# Three businesses: launch status (2026-11-11)

All three are built to the point where the only remaining steps are account
sign-ups that need the owner's identity, bank or card. Nothing has been sent,
posted, bought or signed up for. `node fast-cash/launch-2026-11-11/check.mjs`
verifies that every kit is complete.

| | Local co-op mailer | Etsy shop | Dropshipping store |
|---|---|---|---|
| Cash to activate | **$0** | **≈ $16.60** (≤ $31.60) | **$0** |
| Owner time | 30–60 min | 75–100 min | 2–2½ h |
| First money | the day an advertiser pays a Stripe link | the first order (no reserve on digital items; weekly payout) | the first order (paid out monthly, $25 minimum) |

---

## Local co-op mailer

**What is ready** (`mailer/`; detail in `mailer/LAUNCH.md`)
- **The product:** *The Neighbor Card, New Year 2027 Edition*. A 9×12 EDDM card
  to **4,944 homes in Camp Hill & East Hampden** (17011, 11 real USPS routes:
  Camp Hill 57%, Hampden 32%, East Pennsboro 9%, Lemoyne 3%). Zone 2 adds
  Hampden West (17050), for 9,894 homes in total.
- **Mock-up of both sides** at print resolution (PNG + PDF), with a slot grid
  and the EDDM Retail indicia. A route map and a one-page rate card answer the
  two questions earlier prospects asked: "show me the card" and "which homes".
- **Prices:** 18 spaces, one business per category. Standard $295, Double $525,
  Back Premium $575, Front Feature $625. Both zones: $495 / $895 / $975 / $1,050.
- **Prints only if 10 cells are paid by Wed Dec 9.** Otherwise everyone gets a
  full refund by Dec 11. It drops at the post office on Mon Jan 4, 2027.
- **Sales material:** advertiser agreement, an order form to fill in by email,
  a 3-step CAN-SPAM email sequence, a phone and walk-in script, and a
  Facebook/Nextdoor post.
- **Prospects:** 117 West Shore businesses with sources, ranked by fit for
  January.
- **Costs:** fixed cost ≈ $2,294 (print $743.99 Clubflyers + postage $1,285.44
  + freight estimate). Break-even is 8–9 cells, and a full card makes about
  +$3,895. The owner pays for print and postage only out of advertiser money
  already collected.

**Missing before customers can buy**
- A Stripe account and 8 Payment Links, so an advertiser can pay.
- Your name, mailing address, phone and email in the placeholders. CAN-SPAM
  requires a physical address; a PO box is fine.

**Exact cost to activate: $0.**
- Stripe has no setup or monthly fee; it takes 2.9% + 30¢ from each payment
  received.
- EDDM Retail has no permit fee.
- The only loss case: if the threshold is missed, the Stripe fees on refunds,
  about 3% of what was collected.

**Action required from you**
1. Open a Stripe account (ID, SSN, bank) and create the 8 Payment Links
   (`mailer/ORDER-FORM-EMAIL.md`).
2. Fill in your legal name, address, phone and email (`mailer/LAUNCH.md` §5),
   and sell under your own legal name, so no fictitious-name filing is needed.
3. Selling is the job: about 10 conversations a day from `mailer/prospects.csv`.
   Kill test 1 is on Fri Nov 20.

---

## Etsy shop

**What is ready** (`etsy/`; detail in `etsy/SHOP-SETUP.md`, `etsy/COST.md`)
- **8 instant-download listings.** Each is a finished PDF; together they hold
  382 puzzles, every one passed by Brain's validators, with no puzzle repeated
  across products:

  | Listing | Price |
  |---|---|
  | Large Print Christmas Sudoku | $3.99 |
  | Large Print Sudoku 100 | $4.49 |
  | Easy Sudoku | $3.49 |
  | Expert Sudoku | $3.49 |
  | Large Print Christmas Word Search | $3.99 |
  | Kids' Christmas Activity Pack | $3.49 |
  | Large Print Mazes | $3.49 |
  | 5-book Bundle | $9.99 |

- **Listing photos:** 6 per listing at 2700×2025.
- **Listing copy:** titles, 13 tags each, descriptions, category and
  attributes (`listings.csv` / `LISTINGS.md`).
- **Shop set-up text:** a shop name (CozyPuzzlePress recommended), an
  announcement, an About section, policies and an FAQ.
- **Delivery:** Etsy delivers the files automatically. Nothing happens after a
  sale.

**Missing before customers can buy**
- An Etsy seller account. It needs a government ID and a selfie, a bank
  account, a card and two-step sign-in.
- The 8 listings uploaded and published.

**Exact cost to activate: ≈ $16.60**
- One-time setup fee, about $15. Etsy shows the amount at sign-up; some
  sellers report up to about $30.
- 8 listings × $0.20 = $1.60.
- Per sale: 6.5% transaction fee + 3% + $0.25 processing. You keep about
  $2.70–$3.61 on a single item and $8.57 on the bundle.

**Action required from you**
1. Do the one-minute trademark check on the shop name.
2. Open the Etsy shop and pay the setup fee.
3. Upload and publish the 8 listings by following `etsy/SHOP-SETUP.md`.

---

## Dropshipping store

**What is ready** (`store/`; detail in `store/STORE-SETUP.md`, `store/COST.md`)
- **Platform: Fourthwall (free plan) with Printful fulfilment.**
  - $0 a month, with checkout built in.
  - Fourthwall is the merchant of record, so it collects and pays the sales
    tax and you need no PA sales-tax licence.
  - Printed and shipped in the US.
- **10 print-on-demand products, 12 print-ready files at 300 DPI.** Each
  carries a real sudoku that a second solver checked has exactly one
  solution. Mugs, tees, a holiday sweatshirt, a tote, a poster, a coaster and
  a journal, at $12.99–$39.99, for about $13 profit a unit.
- **Copy:** catalog with titles, descriptions, tags and costs, homepage copy
  and policies.
- **Christmas deadline:** "Order by Dec 8" is set for Christmas delivery.
- **Delivery:** Printful prints and ships each order. Nothing happens after a
  sale.
- **Backup:** Printful Quick Stores ($0; the same design files work).

**Missing before customers can buy**
- A Fourthwall account with Stripe payouts connected.
- The 10 products uploaded and the shop set to Live.

**Exact cost to activate: $0.**
- Payment processing is 2.9% + 30¢ per sale, taken from each sale.
- No custom domain is needed at launch.

**Action required from you**
1. Sign up at fourthwall.com/get-started and connect Stripe payouts (bank, last
   4 of your SSN).
2. Upload the 10 products by following `store/STORE-SETUP.md`. In the designer,
   check each base cost before publishing.
3. Set the shop to Live.
