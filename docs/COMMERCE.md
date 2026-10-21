# The commerce kernel (§73)

What it is for: find generic products that are visibly selling now, find who
would ship one unit direct to a customer, establish what it sells for and what
one order costs to sell, and say which audience wants it. The output is a
short list of products with an **acquisition budget** — what one order leaves
to spend on winning a customer — and every figure resolves to a published
source.

It is research only. It does not open a store, list a product, order from a
supplier, take a payment or run an advertisement. Those need accounts and a
spending ceiling a person owns, and they are listed on the surface as
**not connected**.

## How to run it

1. A Cash Mode sprint must be active on the project (the kernel runs under its
   discovery grant).
2. Start the programme — `POST /api/projects/:id/commerce` with an objective,
   or on a terminal:

       npm run commerce -- start cash-mode-1 --objective "Find generic products selling now that one order can pay to advertise." --admin you@example.com

   or the `Commerce kernel` workflow with `command: start`.
3. The durable tick does the rest. `show` prints where every product stands;
   `tick` runs one pass by hand.

`seed` names a product a person wants looked at. `state --to PAUSED` stops new
questions (filing what already came back continues). `retire` takes a product
off the list with the reason kept.

## What a pass does

1. **File.** Every accepted claim from an open round that carries a
   `commerce_finding` becomes a product and a fact. An undated demand signal is
   refused: "selling now" is a claim about a date.
2. **Stand.** Each product is derived into a stage — ON_MAP, DEMAND_SEEN,
   SOURCED, PRICED, COSTED, QUALIFIED, or THIN_MARGIN, BLOCKED, STALE, RETIRED.
   Nothing derivable is stored.
3. **Ask.** At most three questions are live. Finishing a product comes before
   finding a new one: costs, then price, then supplier, then niche, and
   discovery last.

## Qualified means

- at least two independent, dated demand sources from the last 90 days;
- a supplier offer, a retail price, a shipping line and a card-fee line, all
  published and in one currency;
- one order leaves at least USD 15 and 35% of the lowest retail price before
  advertising;
- the chosen supplier publishes delivery in 20 days or fewer;
- no published prohibition or trademark position ends pursuit.

A missing line withholds the contribution and names the line. A published zero
is a figure. Ad policies are kept as conditions a person reads before selling.

## Declarations

A worker declares a finding on a claim with `commerce_finding` and its
companions (`commerce_product`, `commerce_subject`, `commerce_value`,
`commerce_amount_cents`, `commerce_rate_bps`, `commerce_currency`,
`commerce_days`). One validator, `validateCommerceFinding`, runs at both
submission doors. The product name is copied verbatim from the question so two
workers converge on one row.

## Envelopes

`RUSSELL_COMMERCE_DISCOVERY_V1` (DISCOVER, NICHE) and
`RUSSELL_COMMERCE_TERMS_V1` (SOURCE, PRICE, COSTS) take their source classes
and forbidden actions verbatim from the cash discovery envelope. Both forbid
contacting anyone, ordering, listing, advertising and committing.

## What comes next, and what it needs from the owner

| Capability | Needs |
|---|---|
| Storefront | A store in the owner's name and its admin API token |
| Payments | Payments enabled on that store |
| Supplier ordering | A supplier account and API key, and a commercial action to place orders |
| Advertising | An ad account, its token, and a spending ceiling the owner sets |
| Orders, fulfilment, support | Built after the three above exist |

`PUBLISH_EXTERNALLY` is always prohibited today, so listing and advertising
will need new, narrow commercial actions the owner grants.
