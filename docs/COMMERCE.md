# The commerce kernel (§73)

What it is for: find generic products that are visibly selling now, find who
would ship one unit direct to a customer, establish what it sells for and what
one order costs to sell, and say which audience wants it. The output is a
short list of products with an **acquisition budget** — what one order leaves
to spend on winning a customer — and every figure resolves to a published
source.

The research is read-only. Selling (§74, below) is a separate step that runs
only once the owner connects a store, a supplier and an ad account and grants
the matching actions.

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

## Selling (§74)

Once a product is QUALIFIED, the same tick sells it — as soon as the owner has
connected three accounts and granted three actions. Until then each step does
nothing and `show` names exactly what is missing.

What happens, per product (at most 3 at once):

1. **Match** the supplier's exact item on CJ: the title must cover the
   product's name, it must ship to the first ad country within 20 days, and
   the cheapest landed cost wins. The margin is checked again with CJ's real
   price and shipping; a product under the floor is stopped.
2. **List** it in the owner's Shopify store at the lowest published retail
   price, with CJ's image, and publish it on the Online Store.
3. **Advertise**: a Meta traffic test at the owner's daily budget for 3 days.
   It is committed against the grant's ceilings first, built paused and
   switched on last, and has an end date. It is paused when it has spent two
   acquisition budgets with no order. A test that pays for itself runs again
   (up to 6 rounds); one that loses stops the product.
4. **Fulfil** every paid store order: commit the cost, buy the unit from CJ
   (paid from the CJ wallet), and mark the order shipped with CJ's tracking.
   This continues even when the programme is paused.

Every sale, ad spend and supplier cost goes in the cash ledger. Listing, the
ad test and the supplier order each run through the effects engine and are
reconcilable, so a lost answer is asked about, never repeated.

## Connecting it — the owner's checklist

Set these as Fly secrets (`flyctl secrets set NAME=value`), then restart.

**Store (Shopify)**
- Create the store and turn on Shopify Payments.
- Settings → Apps → Develop apps → create an app with Admin API scopes
  `write_products`, `write_publications`, `read_orders`,
  `write_merchant_managed_fulfillment_orders`. Install it.
- `BRAIN_STORE_PROVIDER=shopify`, `SHOPIFY_STORE_DOMAIN=yourstore.myshopify.com`,
  `SHOPIFY_ADMIN_TOKEN=shpat_…`

**Supplier (CJ Dropshipping)**
- Create the account, add money to the CJ wallet, generate an API key.
- `BRAIN_SUPPLIER_PROVIDER=cj`, `CJ_API_KEY=…` (optional `CJ_SANDBOX=true`
  for a dry run that charges nothing)

**Ads (Meta)**
- In Business Manager, a system user with `ads_management` on the ad account
  and the Page, and a token for it. A payment method on the ad account.
- `BRAIN_ADS_PROVIDER=meta`, `META_ACCESS_TOKEN=…`, `META_AD_ACCOUNT_ID=…`,
  `META_PAGE_ID=…`, `BRAIN_ADS_DAILY_BUDGET_CENTS=1000` (that is $10 a day;
  minimum 500), optional `BRAIN_ADS_COUNTRIES=US`

**The grant (Cash page → standing commercial authority)**
- Allow `LIST_PRODUCT`, `RUN_ADS`, `FULFIL_ORDER`, in USD.
- *At most committed at once* and *at most per action* are the spending caps:
  one ad test costs daily budget × 3, and each supplier order is one action.

Then run `npm run commerce -- probe` (or the workflow with `probe`) to check
the three keys. It sends nothing.

## Not done yet

- Refunds and returns are a person's (the order shows NEEDS_PERSON when the
  supplier refuses).
- Shopify payouts are not read back as settlements; sales are recorded as
  customer payments.
- Ad copy is a plain template; there is no creative testing yet.
