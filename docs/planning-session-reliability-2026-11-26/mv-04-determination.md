# mv-04: the plan or the expected answer? (2026-11-27)

Case `mv-04-marketplace-repeat-buyers` in `bench/planningReliability/mechanismCases.ts` (held out). Run 3 and run 4
both published CONDITIONAL, while the rubric expects `EXECUTABLE_PLAN`. **Neither the rubric nor the plan was changed by
this determination.**

## The complete evidence

There is one opening, `MARKETPLACE`. The objective is to collect $1,000 of settled cash within 30 days using no
up-front capital. The card's facts, all of kind EVIDENCE:

| field | value |
|---|---|
| price | "Comparable allergen meal-plan workbooks sell for $29 on the marketplace (listing prices, 2026-11)." |
| buyerVolume | "The marketplace shows 2,300 sales of comparable meal-plan workbooks in the last 12 months across 40 sellers; buyers return each season." |
| conversionRates | "60 paid pre-orders from 1500 unique visitors" (no period stated) |
| delivery / directCosts / exposure / timeToFirstCash | Brain-produced spreadsheet / $3 / $0 / 3 days |

**Brain's planner** (run on the r02 world) establishes every link:
- **CONVERSION:** "measured on this offer's own inbound page: 60 money-committed pre-orders from 1500 unique visitors".
- **MARKET_VOLUME:** "36 deal(s) needed, 191 available in the window (about 192 orders a month are stated, so 191 in 30 days)".

**The rubric's reasoning** (case description): "a marketplace counts 2,300 sales of comparable workbooks a year, and this
listing converts a measured 4% of 1,500 visitors at $29 … $1,000 needs about 39 sales in 30 days; many buyers do buy.
Executable." It is written as the control for mv-03, where one purchase order was the whole evidence of volume.

## The arithmetic the plan has to carry

- **Sales needed:** $1,000 at $26 kept per sale is **39 sales in 30 days**.
- **The market:** 2,300 sales a year is about **192 a month across all 40 sellers**, or about **4.8 a month for the average seller**.
- **This listing's share:** 39 sales would be **about 20% of the whole category's monthly sales**, roughly **8 times the
  average seller**, from one new listing.
- **Traffic needed:** at the measured 4%, 39 sales need about **975 visitors in 30 days**.
- **What the card says about traffic:** 1,500 visitors, with no period. They could have arrived over a week or over a year.

## Determination

**The expected answer is not supported by the card as written. The published CONDITIONAL plan is the better-supported
answer.**

**The rubric's mistake.** The rubric treats two facts as establishing this listing's sales pace:
1. the category's sales total, which shows the market can hold 39 sales;
2. a per-visitor conversion rate, which shows how a visitor converts.

Neither says how many visitors this listing gets in 30 days, or what share of the category's 192 monthly buyers it
captures.

**Where the planner already notices this.** Brain's own planner documents, in `server/services/cash/volume.ts`, that "a
transaction count over a trailing span … is the market's purchase rate, shared among its sellers". Yet its MARKET_VOLUME
basis compares the 36 deals needed with all 191 of the category's monthly orders. It checks the market's capacity, not
this listing's share, and no chain link measures the listing's traffic.

**What the plan does with the unknown.** The CONDITIONAL plan names that unknown and tests it. Selling runs to day 22,
with these gates:
- proof: 17 sales by day 10, the pace 39 needs;
- stop: under 8 sales by day 10;
- between 8 and 16: a day-15 check that needs 28 sales cumulative.

The test spends nothing, and two independent reviews judged the condition genuine.

**The one reading under which the rubric is right:** the 1,500 visitors arrived within about 45 days. Then about 1,000
visitors a month at 4% gives about 40 sales a month. The card does not say so, and an unknown period is not a favourable
assumption (CLAUDE.md invariant 39).

## What follows

- **The score:** mv-04 stays graded as the rubric reads it (a non-critical `UNJUSTIFIED_REFUSAL`). It is not re-scored
  in any figure reported; this file is the reasoning.
- **The case is underspecified.** A corrected case would state the listing's visitor rate, for example "1,500 unique
  visitors in the last 30 days" (making EXECUTABLE correct). Alternatively, it would keep the rate's period unstated and
  expect CONDITIONAL, with MARKET_VOLUME as the link a pace test resolves. Changing the case is a bench decision; it is
  recorded here and not made.
- **The planner finding is noted, not changed.** Brain's MARKET_VOLUME link reads a category total as available to one
  listing. That is shared production code, and this round was not an overhaul.
