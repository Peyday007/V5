# $10K goal: closing commercial gaps (2026-11-08, second objective)

Goal `wst_7b4fcbb5f2384f31b6c3`, project `prj_22fb4fec295f403a8a22`.
Labels used below:
- **OBSERVED**: read from production Goals `plan` runs.
- **SOURCED**: read from a public page, linked.
- **ESTIMATE**: an estimate with its basis stated.

Commercial research by Claude workers is still barred from the work queue (§84; `brain_only_mode` ON, read 17:10Z). This session's own research is therefore recorded here and drives the plan through the reasoning loop's constructed rounds, which the free lane researches through the evidence gate.

## What changed on the production plan (Goals 42462929446 → 42506587301)

| Measure | Before #620 | After #620 |
|---|---|---|
| Pathways with a fulfiller | 5 | 9 (4 by Brain's own proven capability) |
| How buyers are reached | not classified | DIRECT_DEMAND 8 · MARKETPLACE 3 · PARTNER 1 · COLD_OUTREACH 5 · UNKNOWN 14 |
| Pathway-constructed research rounds | 0 | 2 (`mx-pw4490c427d6` researching, `mx-pwe37c37f6a0` queued) |
| Construction order | by modelled value | by cash collectible before the deadline |
| Supplier-price flips Brain can produce for | cost unknown | priced variant with a bounded production cost, plus a partner/white-label route |

**Defect found on the same reading and fixed (#621).** The one "executable" sale (`cop_665f0a845f984d168461`, Artisanal Sudoku, $50) named the buyer itself as its fulfiller. The buyer wants variant sudoku, and Brain's generator makes classic grids only, so the sale is not fulfillable as recorded. It now reads NO_SUPPLIER, and the move names Factory as the route to that capability.

## Research findings (SOURCED)

**Puzzle buyers**
- Artisanal Sudoku: $50 per puzzle by PayPal/Venmo on publication; 5+ published a week; no per-contributor limit; submission by email (jwsinclair at gmail) or Discord. Puzzles must be original, approachable, standard rules plus familiar variant constraints. https://artisanalsudoku.substack.com/p/how-to-submit-a-puzzle
- Crossword outlets pay $100–$150, and none was found paying on acceptance:
  - LA Times $125 daily / $300 Sunday; USA Today $150; Spyscape $100, paid on publication. https://www.cruciverb.com/
  - Apple News+ responds in about 2 months.
  - These miss a 19-day deadline. Crossword is also an AUTHORED format in Brain (validator only), so Brain cannot fulfil it.

**Custom puzzle gifts**
- Prices run $50–$400 (Your Crossword from $50; Lexicon Devil $125; Fiverr $50–$400).
- Etsy printable templates sell for $5–$12.
- Etsy fees: $0.20 listing, 6.5% transaction, 3% + $0.25 processing.

**Content and agencies**
- Verblio: AI + human $0.06/word plus a $49.50/month platform fee; human-only $0.16/word; managed plan from 50 articles a month. https://www.verblio.com/pricing
- White-label content wholesales at $0.05–0.15/word, and agencies resell at $0.15–0.50/word. https://www.prosemedia.com/blog/white-label-content-pricing-margins-packaging
- Clutch lists 35,824 US digital-marketing agencies. https://clutch.co/us/agencies/digital-marketing

**Payments**
- Stripe US: first payout 7–14 days after the first charge, then 2 business days (third-party summaries of Stripe's schedule).

## The independent revenue paths, ranked by cash collectible by the deadline

### A. White-label articles for marketing agencies — the material path

Constructed from production evidence: the supplier price pages `cop_ef8dba9460474dc6994b` (Verblio, $0.06/word) and `cop_a097c00e4d2247b09ac2`, flipped to the supplier's own buyers.

- **Buyer:** US digital-marketing agencies that resell content to their clients. Population: Clutch lists 35,824 (SOURCED).
- **Why they buy:** agencies buy wholesale at $0.05–0.15/word and resell at $0.15–0.50/word (SOURCED).
- **Acquisition:** a partner/white-label pitch to agencies from the directory. One agreement repeats every month: a DIRECTORY route converted into a PARTNER one.
- **Offer:** a 1,200–1,500-word SEO article, built brief → outline → draft → edit and delivered as an unbranded document within 48 hours.
  - Price: **$90 per article**, equal to Verblio's hybrid rate at 1,500 words, with no platform fee.
  - Sold as a **prepaid pack of 10 for $900**, paid by card at order.
- **Fulfilment:** Brain's proven business-document capability. Cost per article: model spend, not yet measured, bounded at 10% (ESTIMATE).
- **Net:** about $810+ per pack (ESTIMATE).
- **Cash timing:** card at order; Stripe's first payout 7–14 days later. Packs must sell by about 18 November to settle before 27 November.
- **What it needs (MODEL arithmetic):**
  - About 12 packs to cover the $10,000.
  - At 60 contacts a day over about 10 selling days, that is 600 agencies. 1% buying a pack gives about $5,400; 2% gives about $10,800.
  - Conversion is unmeasured; only selling measures it.
- **Capital:** $0. Resend's and Stripe's start tiers cost nothing up front. Inside the $375 / $750 / $3,000 limits.
- **Constraints:** online; no physical work; not a freelance-marketplace listing; not public-sector; any country.

### B. Artisanal Sudoku — small, needs a capability

- **Sale:** $50 per puzzle, from a buyer who publishes its own submission route.
- **Blocker:** the buyer wants variant constraints. Brain's sudoku generator makes classic grids only, so the variant generator would have to be built through Factory first.
- **Size:** at 5+ puzzles a week shared across all contributors, realistically a few accepted puzzles: $100–$200.

### C. Personalised holiday word-search / cryptogram gifts — small

- **Fulfilment:** Brain generates and solver-checks both formats.
- **Channel:** a marketplace (Etsy), where buyers come to the listing.
- **Price:** comparable printables sell for $5–$12; custom made-to-order work runs $50+.
- **Blocker:** a new shop in 19 days sells little, and an Etsy shop needs the owner's own seller account.
- **Size (ESTIMATE):** tens to low hundreds of dollars.

**Rejected on arithmetic, not unfamiliarity:**
- Crossword submissions: they pay on publication, months out.
- Ticket resales: buy-first capital and one buyer each.
- Bug bounties: they pay once, after a win.

## The proposed sale (path A), and only the authorization it needs

> **Offer to an agency owner, by email:** "White-label SEO articles for your clients: 1,200–1,500 words, researched and edited, delivered unbranded in 48 hours. $90 per article; a prepaid pack of 10 is $900, paid by card. Reply with a topic and we'll start."

To send it and be paid, Brain needs exactly:
1. A standing commercial authority on `prj_22fb4fec295f403a8a22` granting **CONTACT_BUYER**, **QUOTE_AND_INVOICE** and **ACCEPT_PAYMENT**, with per-action and total ceilings inside the goal's limits.
2. **A message provider:** `BRAIN_MESSAGING_PROVIDER=resend`, `RESEND_API_KEY`, `BRAIN_MESSAGING_FROM`.
3. **A billing provider:** `BRAIN_BILLING_PROVIDER=stripe`, `STRIPE_SECRET_KEY`.

Nothing else blocks it. Building the agency list from the directory is data work Brain does itself, and research runs beside the sale.

## Remaining barriers to collected cash

1. Items 1–3 above (owner, MISSING_AUTHORITY). Without them, nothing can be sent or collected.
2. Conversion is unmeasured. Path A reaches $10,000 only if about 2% of contacted agencies buy a pack within about 10 days.
3. Stripe's first-payout hold (7–14 days) shrinks the selling window to about 10 days.
4. Commercial evidence enters Brain only through the free lane while brain-only mode is ON. Its two pathway rounds are researching exactly these constructions.
