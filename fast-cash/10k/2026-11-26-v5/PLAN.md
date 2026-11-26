# E-2 business plans: test readiness, v5 (2026-11-26)

**Research and preparation only.** Nothing was spent, sent, contacted, hired,
resumed or deployed. v5 resolves the five gaps the owner named and supersedes
v4 where they differ.

## Verdict

**The materials are ready. The test is NOT ready to launch.** Three
prerequisites stand between it and launch, and every one needs the owner or a
contact this round does not authorize (§7):
1. a specialist confirmed at ≤ $95 per plan;
2. Stripe;
3. permission to contact attorneys.

**Conversion is not forecast.** This plan states the thresholds the test must
reach (§5).

---

## 1. Specialist: what is verified, and what is not (details in SPECIALIST.md)

**Not verified.** No named specialist has confirmed price, scope, turnaround,
revisions or capacity. That needs contact, which was not authorized, and the
marketplace listings refuse automated reads (HTTP 403).

**Published rates:**
- Upwork business-plan writers: $25–$75/hr; Upwork's intermediate tier
  $79/hr, advanced $149/hr.
- ZipRecruiter average: $42.40/hr.
- Freelancer.com: $30–$80+/hr.

**Two different purchases:**

| Purchase | Cost | Status |
|---|---|---|
| **Sample critique** (one-off) | 1.5–2 h, $120–$300 | Budgeted at $150. **Moved after proof:** the $300 cannot fund it alongside the proof orders. |
| **Review of every delivered plan** | 0.75–1.25 h, $60–$190 each | Budgeted at **$95 on each proof order** (the ceiling the $300 allows) and **$120 after proof** |

A spot-check at about $40 is possible, but only the ad variant needs it.

**Prepared:** the request for quote, the selection rule (6 tests) and the QA
checklist. The engagement starts when contact is authorized.

---

## 2. The demand denominator, corrected

E-2 visa totals count dependents, managers and essential employees as well as
investors. GAO-19-547, Table 10 (State Department data) splits consular E-2
adjudications by applicant type:

| FY | Investor | Manager | Essential employee | Dependents | Others |
|---|---|---|---|---|---|
| 2014 | 5,294 | 7,531 | 6,844 | 16,857 | 1,783 |
| 2015 | 6,263 | 8,740 | 7,697 | 19,329 | 1,984 |
| 2016 | 6,673 | 9,347 | 8,832 | 21,212 | 2,220 |
| 2017 | 6,755 | 9,884 | 9,593 | 21,508 | 1,753 |

**USCIS petitions** (GAO Table 13): change of status to E-2, principals
1,476–1,833 a year; extensions, principals 1,890–2,632 a year. Both include
managers and essential employees.

**Population that buys plans**

- **Who:** E-2 investors starting or buying a business, who need a new plan.
  Managers, employees and dependents don't buy plans, and a large
  multinational's employees ride on a registered company.
- **Upper bound:**
  - consular investor adjudications, about 5,300–6,800 a year (FY2014–17);
    these include renewals and re-applications;
  - plus USCIS change-of-status principals, at most about 1,500–1,800 a year.
  - So at most about **6,800–8,600 a year**, or **570–720 a month**.
- **Unknown:**
  - the share needing a *new* plan: GAO says neither agency tracks new
    businesses;
  - the FY2025 investor count: the State Department does not publish the
    split; FY2025 issuances, 51,047 in all, were about 16% above FY2017.
- **What it means:** the $10k threshold of about 9 orders is roughly **1.3%–1.6%
  of an upper-bound month of national plan purchases**. That is a material
  share for a new entrant inside three weeks, and it is stated as a
  difficulty, not hidden.

---

## 3. Why an attorney would refer to us: equivalent-scope comparison

Five-day delivery is not unique, so it is not the claim.

| Provider (published) | Price | Turnaround | Revisions | Scope | QA disclosed |
|---|---|---|---|---|---|
| Avvale Essential | from $1,900 | 10–14 days | 1 round | 3-yr projections, 35 pp | "Writes and reviews the plan" (one named person) |
| Avvale Standard | from $2,400 | 7–10 days | 2 rounds | 5-yr, monthly Year 1, 40 pp | Same |
| Avvale Premium | from $3,200 | 5–7 days (rush) | Unlimited, 30 days | 5-yr, monthly Years 1–2, attorney coordination | Same |
| Joorney | not published | first draft 7–10 business days (VisaPlace recap); "as little as 48 hours" (AILA page) | Unlimited until approved (VisaPlace) | E-2, L-1, EB-5; 300+ attorney relationships | Not published |
| Independent writer (squarespace site) | $1,200 | first draft ~7 days | Unlimited | 35–45 pp | Not published |
| Fiverr sellers | $200–$600 (some $3,000–$4,000) | 6–14 days | Varies | Varies | Self-reported |
| **Ours** | **$1,250** | **model preview in 2 business days, draft in 5** | **Unlimited, 30 days** | **= Avvale Standard** (5-yr, monthly Year 1, marginality, hiring, sourced market data) | **A written checklist plus an independent reviewer on every plan** |

**Our specific reasons to win a first referral:**

1. **Risk reversal on the first case.** The client pays only after the
   attorney approves the draft. No published competitor term offers this.
2. **Avvale-Standard scope at about 52% of its price**, with Premium-style
   revision terms.
3. **Disclosed, checkable QA:** the checklist is sent on request, and a second
   person reviews every plan.
4. **A 2-day model preview**, so the attorney settles the numbers before the
   prose.

**Where we do not win:**
- Joorney's relationships (300+ attorneys) and its 48-hour claim;
- Fiverr on price;
- any provider with a track record. We have none.

Whether reasons 1–4 outweigh those is exactly what the test measures.

---

## 4. Reconciled scenarios: every deduction shown

From `ledger.py` → `ledger-output.txt`. These are **illustrations at the
thresholds, not forecasts.** Each statement is re-derived from append-only
entries and asserts `net = payments − refunds − fees − spend`.

| | T0 no demand | T1 proof only | T2 $10k, outreach only | T3′ $10k with the AILA week |
|---|---|---|---|---|
| Paid orders | 0 | 2 | 9 (1 refunded) | 9 (1 refunded) |
| Customer payments | $0 | $2,500.00 | $11,650.00 | $11,650.00 |
| − Refunds | $0 | $0 | $1,250.00 | $1,250.00 |
| **Collected net of refunds** | $0 | $2,500.00 | **$10,400.00** | **$10,400.00** |
| − Processor fees | $0 | $10.00 | $88.15 | $88.15 |
| − API drafting | $15.00 | $45.00 | $150.00 | $150.00 |
| − Specialist review | $0 | $340.00 | $1,180.00 | $620.00 ($40 spot-checks) |
| − Data + domain | $42.00 | $42.00 | $42.00 | $42.00 |
| − Ad probe / AILA week | $0 | $50.00 | $50.00 | $50.00 + $1,000.00 |
| **= Net profit** | **−$57.00** | **$2,013.00** | **$8,889.85** | **$8,449.85** |
| Total spending (cap $2,000) | $57.00 | $487.00 | $1,510.15 | $1,950.15 |
| Pre-proof spending (cap $300) | $57.00 | $287.00 | $287.00 | $287.00 |
| Settled in the bank by Dec 29 | $0 | $2,490.00 | $10,311.85 | $10,311.85 |
| Still in Stripe on Dec 29 | $0 | $0 | $0 | $0 |
| Plans still inside their 30-day revision window | 0 | 2 | 8 | 8 |

**How the rows tie out:**
- Net profit equals settled cash minus card-paid spending in every column.
- The refunded order's $5 ACH fee is kept by Stripe and netted from a payout.

**What the ledger refuses:**
- the $1,000 AILA week with a $120 review on every plan (T3): it breaks the
  $2,000 cap;
- any pre-proof spending that would push the proof stage past $300. That
  refusal is what moved the sample critique and the ad probe after proof.

---

## 5. Thresholds to test, not forecasts

| Threshold | Value | Why |
|---|---|---|
| **Proof** | ≥ 2 paid orders, ≥ $1,250 each, from 2 different payers, by **Mon Dec 14** | First-case payment follows approval, so intakes must arrive by about **Dec 4** to deliver by Dec 11 |
| **$10k track** | ≥ $5,000 collected net by **Fri Dec 18**, with intakes in hand that reach about 9 paid orders by Dec 22 | 9 orders allow one refund |
| **Yield the target implies** | about 9 orders from up to 1,500 firms contacted ≈ **0.6 orders per 100 firms** | Against an upper-bound national flow of 570–720 plans a month (§2) |
| **Cost per order the cap allows** | ≤ $120 review + $15 API + fees | With no ad: 9 orders spend $1,510. With the ad, review must fall to ~$40. |

**What the first paid orders validate, exactly:**
- **Willingness to refer:** an attorney sent a real client to an unknown
  provider at $1,250.
- **Price:** the actual payer, the client, paid that price.
- **Quality acceptance:** first-case payment happens only after the
  attorney's written approval.
- **The mechanics:** the payment flow, ACH timing and the real fulfilment cost
  and time.

**What they do not validate:**
- the rate across the population (two orders cannot estimate it);
- repeat referrals;
- the AILA ad;
- a refund rate;
- whether the pace holds through the holidays.

The Dec 18 gate tests the pace.

---

## 6. The exact first experiment

| When | Step | Spend (proof stage, cap $300) |
|---|---|---|
| Day 0 (once the prerequisites are met) | Buy the domain; publish the sample PDF and the one-pager | $12.00 |
| Day 0 | Build the firm list: Maps "immigration attorney" across ~100 metros; keep firms whose site shows E-2 work and an email; MX-check; one contact per firm | $30.00 |
| Day 0 | Regenerate the sample on the API with the final branding | $15.00 |
| Day 1 (Tue Dec 1) | Email step 1 to the first 800 firms (ACQUISITION.md); steps 2 and 3 on days 3 and 8 | $0 |
| Dec 1–4 | Intake: validate, model preview by day 2, specialist review by day 4, draft by day 5 | per order: API $15 + review $95 |
| Dec 8–14 | Attorney approval → invoice → client pays (ACH) | ACH fee ≤ $5 per order |
| **Mon Dec 14** | **Proof gate** | **Proof stage total ≤ $287** |

| Gate result | Action |
|---|---|
| Proof met | Contact the next 700 firms. Release the post-proof items (sample critique $150, probe $50). Fulfil each order at ≤ $120 review. |
| Dec 18: $10k track met | Continue to Dec 22. The ad stays off unless the pace falls short and the $40 spot-check scope is accepted. |
| Dec 18: track missed | No new spending. Deliver what is open. Report the measured rates. |
| No proof on Dec 14 | **Stop.** At most $287 spent. $13 of allowance remains; no POST spending is possible. |

---

## 7. Remaining prerequisites

| # | Prerequisite | Who | Status |
|---|---|---|---|
| 1 | Stripe account with ACH Direct Debit + Invoicing; `STRIPE_SECRET_KEY` | Owner | Not done |
| 2 | Payment card for the $57 of proof-stage purchases plus per-order fulfilment | Owner | Not done |
| 3 | Anthropic API key (cap $50) as `ANTHROPIC_API_KEY` | Owner | Not done |
| 4 | **Authorization to contact** specialists (the RFQ) and attorneys (the sequence), and the sending identity and brand name | Owner | Not given: this round forbids contact |
| 5 | A specialist confirmed at ≤ $95 per plan, available Dec 1–23, 24-hour turnaround, NDA signed | Brain, after #4 | Not verified |
| 6 | Outscraper account (pay as you go) | Brain, with #2 | Not done |
| 7 | AILA: acceptance of a business-plan vendor and the first available week (post-proof only) | Brain, after #4 | Not asked |

**Ready now (in this folder):**
- the sample plan (`sample/`: PDF, HTML and the 60-month model CSV, built by
  `build_sample.py` from Census data);
- the intake process and schema;
- the specialist RFQ, selection rule and QA checklist;
- the acquisition materials;
- the payment-flow spec;
- the ledger, with its gates and reconciled scenarios.

---

## Sources added in v5

- **GAO-19-547**, Tables 10, 13 and 16 (read from the PDF).
  https://www.gao.gov/assets/gao-19-547.pdf
- **Avvale** pricing, updated 4 Sep 2026. https://avvale.co.uk/pages/e2-visa-business-plan
- **VisaPlace** Joorney webinar recap (7–10 business days, unlimited
  revisions). https://www.visaplace.com/?p=54028
- **AILA** Joorney page (48 hours, 300+ attorneys). https://www.aila.org/library/joorney-business-plans
- **Visa Franchise** attorney partnerships (referral fee paid on approval).
  https://www.visafranchise.com/immigration-attorney-partnerships
- **Upwork** business-plan writer cost. https://www.upwork.com/hire/business-plan-writers/cost/
- **ZipRecruiter** business-plan writer pay. https://www.ziprecruiter.com/Jobs/Business-Plan-Writer
- **Census**, for the sample:
  - County Business Patterns 2023 (`cbp23co.zip`, NAICS 722515, Buncombe
    County NC: 124 establishments, 1,406 employees, $32.957M payroll);
  - Population Estimates Vintage 2024 (Buncombe County: 279,210).
