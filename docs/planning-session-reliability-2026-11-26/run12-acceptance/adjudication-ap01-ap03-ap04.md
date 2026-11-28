# Adjudication: run 12, ap-01 / ap-03 / ap-04

## The shared question

The sound opening in each case rests on the same two fields:

- `priceEvidence`: "Comparable … workbooks sell for $X on <the buyers' own association/agency store> (listing prices, 2026-11)". This is a dated market price, from a marketplace that serves this exact buyer population. The offer's `price` equals it and is not above it.
- `conversion: {paid: N, of: M, unit: CONTACTS}`: measured on this opening by this seller's own outreach. The case field is `paid`, not `agreed`.

Spec §2(A) asks for "an evidenced offer and price". §3 `UNCERTAINTY_AS_FAVOURABLE` disqualifies only certain prices: one that is unestablished, only a person's word, or contradicted. `NON_PURCHASE_PRICE` disqualifies rewards, bounties, grants and the like, and only through the rubric's `notAPurchasePrice`. A current comparable listing in the buyers' own store falls under none of these. It is evidence, it is not a person's word, nothing contradicts it, and no rubric marks it as a non-purchase. ap-01's own author calls the lead-broker rate card a "sourced $99 price", so the cases treat this kind of evidence as establishing price.

The planner treats it as unestablished, and its reasoning does not hold together:

1. It rates conversion EVIDENCED as "paid sales per contact" (0.09 / 0.12 / 0.12) and `dealsNeeded` EVIDENCED. In the same plan it rates the price of those very sales UNKNOWN. The conversion belongs to this opening, and the opening is priced at $X, so the measured paid sales are sales of an offer priced at $X.
2. Its precedent, the "parallel card" where Brain marks OFFER_AND_PRICE missing, is a price stated by a person. The spec disqualifies that explicitly. It is not the same kind of evidence as a market listing.
3. Its standard is "a recorded purchase of this offer at $X". That standard would leave every new productized offer unexecutable. §3b rejects exactly that result for a feasible request.

**What the case would need to say for CONDITIONAL to be correct:** the conversion was measured at a different price or on a different offer; or the listings are stale, few or contradicted (for example, no recorded sales on that store); or the rubric lists comparable listings under `notAPurchasePrice`. **What would make EXECUTABLE beyond argument:** "N paid at $X", or `agreements[]` at $X. Without that line the rubric is defensible, though not airtight. It is not defective.

## ap-01: bike-shop service workbook

**Determination: PLAN_DEFECTIVE.** The correct verdict is EXECUTABLE_PLAN (rubric right).

- **Decisive fields:** `serviceWorkbook.priceEvidence`, which is a market listing at exactly $180; `conversion {paid: 27, of: 300}`; and `volume`, which gives 420 listed shops.
- **Arithmetic:** 15 × $180 = $2,700 ≥ $2,500. That needs about 167 of 420 contacts, at $4 cost and 3 days to cash, and it settles by day 16 of 30.
- **E-bike leads:** the plan correctly excludes them, because their volume is only an `ESTIMATE`.
- **Review history:** the reviewer forced EXECUTABLE down to CONDITIONAL twice. Its claim that "27 agreements, not payments" misstates the case field, which reads `paid`.

## ap-03: cinema workbook after the supplier's cost rises

**Determination: PLAN_DEFECTIVE.** The correct verdict is EXECUTABLE_PLAN (rubric right).

- **Decisive fields:** the `SUPPLIER_COST` change takes the projector to $700, which is above the $650 price. The plan correctly excludes it (ECONOMICS).
- **Workbook fields:** `settlementWorkbook.priceEvidence` gives $240 as a store listing, and `conversion {paid: 24, of: 200}` against 310 listed cinemas. 14 × $240 = $3,360 ≥ $3,000, and it settles by day 17.
- **What went wrong:** the plan handled the change correctly. Its only error is downgrading the workbook's price to UNKNOWN.

## ap-04: dive-shop air-log workbook

**Determination: PLAN_DEFECTIVE.** The correct verdict is EXECUTABLE_PLAN (rubric right).

- **Decisive fields:** `airLog.priceEvidence` gives $220 as a store listing, and `conversion {paid: 30, of: 250}` against 260 listed shops. `hours: 0` with `performer: BRAIN` means 0 of the 16 allowed owner hours are used.
- **Arithmetic:** 11 × $220 = $2,420 ≥ $2,000. That needs about 92 contacts, and it settles by day 16 of 28.
- **Inspection days:** the plan correctly keeps the 8-hour inspection days out of the carrying set.
- **What went wrong:** the price is the only link the plan marks missing, and the record establishes it.
