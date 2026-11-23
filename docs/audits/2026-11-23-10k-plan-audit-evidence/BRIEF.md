# Extracted facts: Brain's $10K candidate plan (as stored, no changes)

Source of everything below: Brain production database and its own plan read, retrieved 2026-11-23.

## Goal
- Goal: wst_7b4fcbb5f2384f31b6c3, "Collect 10000 dollars of settled cash within 30 days using little up-front capital". Created 2026-10-28. Target set 2026-11-03. Due 2026-12-09 (16 days left as of 2026-11-23).
- Metric: SETTLED_CASH ≥ $10,000, verified on the ledger. This means cash collected and usable, not revenue booked.
- Ledger so far: $0.
- Capital ceiling: $3,000 total. At most $375 tied up before any money comes in. At most $750 newly tied up per week. Owner hours: 0.
- Owner's words: "Budget around 2000 to 3000 dollars, not fixed. Spend little until money comes in, then spread it over the month. At most about 375 dollars initial outlay on any one arrangement and about 750 dollars tied up before proof."
- Authority: research only. "No commercial grant: Brain may research here but may not spend, contact or publish." CONTACT_BUYER, QUOTE_AND_INVOICE and ACCEPT_PAYMENT are not granted. No billing provider (Stripe) is connected.
- The goal also excludes WEBSITE_REPAIR and DOMAIN_SPECULATION.

## Latest plan reading
- Reading gpr_7f5449d0d203428494f9 at 2026-11-23T18:27:43Z.
- The candidate composed of these six arrangements first appeared in reading gpr_598357627812493da442 at 2026-11-22T05:13:32Z.
- Planner verdict: NOT_VIABLE. Acceptance status: CANDIDATE_ONLY / IMPROVEMENT_REQUIRED.
- Planner's reason for "not viable": no performer is established for any opening; the work is read as the owner's at 1–40 hours a deal, against 0 owner hours allowed.
- Acceptance shortfalls stated by Brain:
  1. "the best combination counts money from arr_6f3b7a404ca5, arr_2637d8e20ca9, whose price nobody has established; an unknown price is not evidence of reach"
  2. "this Brain has too few finished accepted plans (under 10) to calibrate a success rate"
  3. "the 97.95% is share of scenarios covered, not a probability"
  4. A required independent model challenge has not answered.

## The candidate: six "constructed" arrangements (Brain composed these; nobody found them as live requests)

| id | Buyer as Brain states it | Price used | Direct cost used | Net per deal | Volume swept | Conversion swept | Cash days | Net p10 / p50 / p90 |
|---|---|---|---|---|---|---|---|---|
| arr_6f3b7a404ca5 | "GitHub Inc is the payer — its bug bounty page publishes rewards of $10,000 or more…" | $10,000 (E) | $355 (E) | $9,645 | 1–200 repeats (unknown) | 0–8% (unknown) | 3.87 d (E) | $365 / $52,445 / $3,509,824 |
| arr_7c86bd58f732 | "domain buyer or seller — what this buyer pays per unit of work" | $75 (E) | $3.88 | $71.12 | 1–200 repeats | 0–8% | 3.87 d | $2.34 / $387 / $25,981 |
| arr_f3a27dfbcc1d | "small business operators — what this buyer pays per unit of work" | $9 (E) | $0.47 | $8.53 | 1–200 repeats | 0–8% | 3.87 d | $0.31 / $46.41 / $3,114 |
| arr_213ac85cdf75 | domain buyer or seller (same as above) | $75 (E) | $3.88 | $71.12 | 1–200 repeats | 0–8% | 8–21 d (unknown) | $0 / $39.66 / $18,121 |
| arr_96aa6549da5c | small business operators (same) | $9 (E) | $0.47 | $8.53 | 1–200 repeats | 0–8% | 8–21 d | $0 / $4.76 / $2,172 |
| arr_2637d8e20ca9 | domain buyer or seller | $75 (E) | $3.88 | $71.12 | 1 one-off | 0–8% | 8–21 d | $0 / $0.12 / $9.74 |

(E = "estimated from evidence" in Brain's labelling; "?" = unknown, swept.)

For every one of the six, Brain records: no way to reach the buyer (channel UNKNOWN), no specific offer, nobody named to fulfil it.

Combined portfolio: net p10 / p50 / p90 = $368 / $10,000 / $10,000, capped at the $10,000 gap. Capital $0.

The demand model per leg uses a reply rate of 0.076 and a close rate of 0.260, both marked "not established". Contacts per day 10–930. For arr_6f3b7a404ca5: contacted p50 4,314; interested 33 / 209 / 534; deals 4 / 27 / 94; revenue $35,074 / $268,901 / $947,001 (p10 / p50 / p90).

Arrangement arr_6f3b7a404ca5's offer text is "programming for 'Deliver exactly what the published request asks for Software Advice analyzed data from 4 4…'". It is a presale: the buyer pays for a slot in a shared run, refunded if the run does not fill. Delivery is by Brain's spreadsheet renderer (PRODUCE_SPREADSHEET). Brain itself notes this contradicts the buyer's terms: GitHub "pays in arrears… won by competitive award".

## Source claims behind the prices (as stored, accepted)
- clm_5e038810b7a945728e2f: "GitHub Inc pays $10,000 per slot for a critical finding in its public bug bounty program." Source: Tech Times, 2026-07-27, https://www.techtimes.com/articles/321650/20260727/github-bug-bounty-cuts-public-payouts-half-hides-top-rates-invite-only-tier.htm. Excerpt: "As of July 27, 2026, GitHub's public bug bounty program pays fixed amounts: $250 for low-severity findings, $2,000 for medium, $5,000 for high, and $10,000 for critical."
- clm_39c873b617d846da8292: GitHub's own bug bounty page (https://bounty.github.com/about): the program has run since 2014-01-30 and accepts vulnerability submissions via HackerOne.
- clm_36a246dfddcf4b1ebccc: "Software Advice analyzed data from 4,415 field service management buyers in the last year." Source: softwareadvice.com HVAC comparison (archive.org). This is the text that got spliced into the GitHub arrangement's offer.
- Opening cop_4521ad95cb104405a33e (GitHub bug bounty as found): payer "GitHub … pays researchers through its public and private bug bounty programs; suppliers reach it by submitting a vulnerability report via HackerOne". Price $250. Capital tied up $10,000 (P). Brain's own model of this found opening nets $0.25.
- $75: clm_cbc36da6673c4b7581fc, NameExperts (domain broker): "commission-only brokers charge … 10-30%, flat-fee-plus-commission brokers charge 10-20% plus a service fee 'often $75-$500'". https://nameexperts.com/blog/domain-broker-fees/
- $9: the "small business operators" buyer comes from claims that spreadsheet-template buyers are primarily small business operators (sellramp.com, template.net). The exact $9 source claim was not isolated in the probe.

## How the "98%" is computed (from Brain's code, server/services/goals/portfolio.ts)
- Monte Carlo over 2,000 "worlds" (PORTFOLIO_WORLDS).
- In each world, every leg independently draws price, days to cash, reply rate, close rate, direct cost, volume cap and contacts per day:
  - A value with no evidence is drawn uniformly over its range ("RANGE").
  - Unestablished prices are clipped at the range centre ("unfavourable" side).
- contacted = contacts/day × share × selling days; interested ~ Poisson(contacted × reply); deals ~ Binomial(interested, close), capped by volume; cash = deals × price.
- "Reach" = the share of the 2,000 worlds whose summed settled cash ≥ $10,000. Brain labels it "COVERAGE" and states it is "coverage of assumed inputs, not a probability".
- Reported reach is 0.98, from a reconstruction baseline of 0.987. Brain's "adverse" 10th-percentile outcome is $32,266, with expected $55,772 and upper $77,450. The portfolio-level net p10 is $368. These figures come from different parts of the planner and are not mutually consistent.
- Sensitivity, as Brain reports it, is dominated by arr_6f3b7a404ca5 across its range: direct cost swings the plan mean by $136,698, price by $102,382, volume by $74,515 and reply rate by $54,876.
