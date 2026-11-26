# $10,000 collected in 30 days, ≤ $2,000 spent: plan v4 (2026-11-26)

**Planning only.** Nothing was bought, sent, hired, resumed or deployed.

**Files in this folder:**
- `PLAN.md` (this file)
- `model.py` and `model-output.txt`: the arithmetic
- `SOURCES.md`: every external figure, with its limits

Rerun the model with:

```
python3 -I fast-cash/10k/2026-11-26-v4/model.py
```

**What changed from v3, as the owner ordered:**
- Every rate taken from the owner's Instantly campaigns is gone.
- None of the owner's offers, prospects or audiences is used.
- Spending is treated as a tool.
- The route below was found from outside evidence.

---

## 8. First: a supported plan, or an experiment?

**This is an experiment that can show, by Dec 9–10, whether $10k is
reachable. It is not a supported $10k plan.**

| Supported by external evidence | Not supported: no evidence exists yet |
|---|---|
| Buyers exist: 51,047 E-2 visas in FY2025, and each new E-2 business needs a plan | Whether immigration attorneys buy from a **new** AI-drafted, specialist-checked provider, and how many |
| Buyers pay $1,500–$3,500 per plan; about $1,000 when a law firm organizes it | Click and order rates from a paid AILA newsletter ad |
| Attorneys use outside writers: Joorney is listed on AILA's site | Whether attorneys accept a plan produced this way without major rework |
| A priced, targeted channel to these buyers: AILA8 at $1,000 a week, 16,000 recipients, 38% open (vendor figures) | Whether the AILA ad can be booked and run before Dec 18 |
| Fulfilment cost is low and known: Opus 5.5 API about $15 a plan; Stripe ACH ≤ $5 | — |
| Margin fits the cap: about $73 per order after the first two | — |

The model shows $10k in the base and upside scenarios, but those rest on
**assumed** conversion rates. The conservative scenario collects about $800.
The test below replaces the assumptions with measurements before anything over
$300 is spent.

---

## 1. The route

**Brand-new: business plans for immigration and lending, written with AI and
checked by a specialist.**

- **The product.** A USCIS/consular-ready **E-2 treaty-investor business
  plan**. Later SKUs for the same buyers: L-1A new-office plans and SBA loan
  plans. Each plan includes:
  - business description, investment and source-of-funds narrative;
  - local market and competitor analysis;
  - a marginality argument;
  - a 5-year hiring plan with titles and salaries;
  - 5-year P&L, cash flow, balance sheet and break-even.

  Delivered as editable Word and PDF in **5 business days**, with 2 revision
  rounds.
- **Two prices, both paid upfront:**
  - **$1,250 partner rate** for attorney-referred clients. The client pays us
    directly by Stripe invoice (ACH or card). The attorney receives no fee
    and no markup, which keeps clear of the bar rules on fee-sharing and
    referral payments.
  - **$1,650 direct** to applicants.
- **Why it beats the alternatives on the evidence** (model section A): it is
  the only route where every one of these is true at once:
  - an outside-evidenced price of $1,000+;
  - a buyer who must have the product to file;
  - a priced, targeted channel to the people who order it;
  - fulfilment cost under 10% of price;
  - no physical work and no owner hours.

### Strategies compared (model section A)

$10k at an average order of $1,370 needs about 7.3 orders. Fulfilment leaves
$1,256 of room under the cap, so **CAC must stay at or below about $157 an
order**.

| Spending strategy | What the money buys | Evidence | Result |
|---|---|---|---|
| Generic paid search | Clicks | Business-services cost per lead $103.54 (LocaliQ 2025) | CAC $345–$518. **Does not fit.** Visa terms are also restricted under Google's Oct 2026 policy. |
| Lead marketplace (Bark) | Responses to buyer requests | $2.35 a credit × 10–15 credits; 5 pros per lead | CAC $118–$352 at assumed hire rates. **Does not fit**, and it is freelance work. |
| Upwork proposals | Bids on posted jobs | $2.25–$3.75 a proposal, 3–8% win (vendor), 0–15% fee, 14-day release | CAC $165–$262 including the fee. **Does not fit** at this price, and **the owner rejected freelance work on 2026-10-20 (§76)**. |
| Paid social, consumer digital gifts | Impressions | Needs ROAS ≥ 5.9; benchmarks sit near 2 | **Does not fit** |
| Co-op postcard (earlier plan) | Print + postage | Vendor drop about $2,309 | **Over the cap** before any revenue |
| **Purchased attorney data + outreach** | **Verified contacts at ~$0.02–0.05 each** | Outscraper $3/1k + enrichment | CAC is near $0 cash. **Conversion unknown**: break-even below. |
| **AILA8 newsletter week, after proof** | **A targeted reach of ~6,100 opens** | AILA kit: $1,000, 16,000 recipients, 38% open | $1,000 ÷ 7.3 orders = $137 CAC if it carries the whole target. **Conversion unknown.** |
| Contract specialist reviewer | Plan quality | ~$80/hr (assumed; to be quoted) | Removes the refund and reputation risk of AI-only drafts |

### Resources

- **Drafting runs on the Anthropic API**, Opus 5.5 at $4 input / $20 output
  per million tokens, about $15 a plan. That avoids depending on the Claude
  routines reserved for Brain (§84).
- **Moving a routine onto this work** would save about $15 a plan, so about
  $110 at target. The owner can order it; the plan does not need it.

### Capabilities: unavailable versus obtainable within budget

| Capability | Status |
|---|---|
| Stripe account | Unavailable until the owner creates it; $0 |
| A payment card to make the purchases | Unavailable until the owner supplies one |
| Anthropic API key | Obtainable: pay as you go; Brain's integration is built but not selected |
| Attorney contact data | Obtainable: Outscraper, about $70 |
| Specialist reviewer | Obtainable: a contractor, about $80/hr |
| AILA ads | Obtainable post-proof for $1,000. Lead time unknown; confirm on day 1 |
| Sending infrastructure | Available: Brain's existing Instantly sending accounts, used only as infrastructure, under the new brand's reply-to domain |

---

## 2. Why customers would buy this offer

**Attorneys.** An E-2 filing cannot go in without a credible plan. Attorneys
already send plans to outside writers. Their pain is turnaround and cost,
which they pass to the client:
- **5 business days** against the 2–3 weeks common in the market (to be
  confirmed);
- **$1,250**, at the bottom of the $1,500–$3,500 band;
- a **free sample plan** (a fictional business) they can judge before
  referring anyone;
- a **specialist-reviewed** financial model.

**Applicants.** Price and speed, with the attorney kept in the loop.

**What we never promise:** visa approval or legal advice.

---

## 3. The loop: acquisition → payment → fulfilment

1. **Acquire.**
   - Buy Google Maps records for "immigration attorney / lawyer" in the top
     ~100 US metros (about 15,000 records).
   - Enrich them with emails; keep firms with business-immigration or E-2
     pages.
   - MX-check each address. Target 1,500 delivered contacts.
2. **Pitch.** A 3-step email:
   - 5-day E-2 plans at $1,250 for your clients;
   - a sample-plan link;
   - a one-click intake form.
3. **Qualify.** The intake form collects:
   - treaty country;
   - business type and location;
   - investment amount and source of funds;
   - filing or interview date.
4. **Sale.** A Stripe invoice to the payer (ACH or card), paid in full before
   work starts.
5. **Fulfil.**
   - Brain researches the market and builds the 5-year model with its own
     calculation tools.
   - The Opus 5.5 API drafts the plan.
   - Brain's checklist verifies every E-2 element.
   - The specialist reviews plans #1–2 in full, then spot-checks later ones.
6. **Deliver** on day 5. Up to 2 revision rounds.
7. **Refund** if the attorney rejects the plan with reasons within 14 days.
8. **Feedback.** Each order's source, time to pay, revisions and refunds go
   back into `model.py`. The gates read measured values only.

---

## 4. Spending: up to $300 before proof, up to $2,000 overall

### Before proof ($267 of $300; the remaining $33 stays available)

| Expense | What it buys | Price and timing | Bottleneck removed | Expected contribution and evidence |
|---|---|---|---|---|
| Domain | Brand, reply-to, intake page | ~$12, paid day 1 | Credibility, deliverability | Standard |
| Contact data | ~15k Maps records + emails → ~1,500 verified attorneys | $3/1k + $3–14/1k ≈ $70, prepaid | **Reach to the ordering buyer** | Published price (secondhand). The number of usable leads is inferred. |
| API run for the sample plan | One full fictional E-2 plan | ~$15, metered | Something to show before the first sale | API prices |
| Specialist critique of the sample | 1.5 h review, fixes applied | ~$120 (assumed $80/hr), on delivery | **Quality risk:** the main driver of refunds | Market practice; quote first |
| Search-ad probe | ~5–10 clicks on non-visa terms | $50, daily billing | Tests **ad approval under the Oct 2026 policy** and real CPC | Benchmark CPC $5.26; related terms $2–$5 |

### After proof (only from the gates in §6; hard total $2,000 including all fees)

| Expense | What it buys | Price | When it is released |
|---|---|---|---|
| Fulfilment per order | API $15 + spot-check $40 (first two: $120) + fees (~$18 average) | ~$73 an order | Automatically with each paid order |
| **AILA8 week** | 5 sends to 16,000 recipients | $1,000 | Only if outreach pace falls short **and** the cap can still fund the remaining orders **and** AILA confirms a run date by Dec 18 |
| Search ads | Clicks on non-visa terms | ≤ $200 | Only if the probe shows approval and CPC ≤ $6. Stop at CAC > $150. |
| More data | More metros or firms | ≤ $50 | If the verified contacts run out |

The model shows how the cap binds: it can fund about **21.6 orders without the
AILA week, but only 7.9 with it**. So the ad is bought only when the measured
pace says it is needed.

---

## 5. Quantitative evidence, unknowns and break-evens

**Required:** 7.3 orders at a $1,370 average.

**Supported inputs** (SOURCES.md): demand, price, channel reach, unit costs.

**Unknown, the decisive ones:**

1. **Attorney interest rate** after 3 emails. Break-even with 1,500 contacts:
   - 0.84% if 50% of interested attorneys order 1.2 plans each;
   - 0.56% if 60% order 1.5 each.
2. **AILA8 click × intake × paid.** About 3% of opens clicking, 10% intake
   and 40% paid gives about 7.3 orders. At 1%, 10% and 40% it gives about
   2.4 (model section C).
3. **Attorney acceptance of the plan quality.** Measured on plan #1.

| Scenario | Inputs (all conversion values ASSUMED) | Customer payments | Refunds | Spending | Net | In bank by Dec 29 |
|---|---|---|---|---|---|---|
| Conservative | 1,000 contacts, 0.2% interest, 30% order; no ad | $797 | $120 | $356 | $322 | ~$300 |
| Base | 1,500, 0.6%, 50%, ×1.2; ad bought (CTR 3%, intake 10%, paid 40%) | $10,733 | $1,073 | $1,998 | $7,661 | ~$5,900 |
| Upside | 2,500, 1.5%, 60%, ×1.5; ad not needed; **the cap binds at 21.5 orders** | $29,506 | $1,475 | $1,998 | $26,033 | ~$26,000 |

**Obligations after day 30:** revision rounds on delivered plans. Their cost
is already provisioned in fulfilment.

---

## 6. The paid-demand test and the gates that follow

- **Test window:** Mon Nov 30 to Wed Dec 9.
- **Spend:** $267 (above). The remaining $33 is the only reserve if the test
  needs revising.

**Proof, by Dec 9:**
- **at least 2 paid orders**, each ≥ $1,250, from **2 different payers**;
- **and** plan #1 delivered with no major-rework request from its attorney.

Only payment and acceptance count. Sample requests are tracked as leading
indicators, not proof.

**What proof validates:**
- the price;
- that attorneys refer to an unknown provider;
- that the product is good enough.

**What proof leaves open:** pace, and AILA ad performance.

| Result on Dec 9 | Action |
|---|---|
| ≥ 2 paid orders + accepted plan | **Continue.** Fulfilment spend flows with orders. **Dec 10 ad gate:** buy the AILA8 week only if measured outreach pace projects < 7.3 orders by Dec 22, the cap still covers them, and AILA can run it by Dec 18. |
| ≥ 3 paid by Dec 11 at the measured pace | **$10k track.** Expand data (≤ $50); no ad needed if the pace holds. |
| 0–1 paid, but ≥ 4 sample or intake requests | **Revise once**: first-case pilot at $995, pay-on-delivery for attorneys with ≥ 2 E-2 cases a year. Uses $0 of the remaining $33. Re-test Dec 10–15. |
| 0 paid and < 3 sample requests from ≥ 1,000 delivered | **Stop the route.** At most $267 spent. No other route may reset the allowance; $33 remains. |
| Dec 16: cumulative payments < $4,000 and no ad bought | $10k is unreachable this window. No new spending; deliver what is open. |

---

## 7. 30-day schedule and cash flow (day 1 = Mon Nov 30, day 30 = Tue Dec 29)

| Dates | Work | Checkpoint |
|---|---|---|
| Nov 27–29 (before day 1) | Owner: Stripe, payment card, Anthropic API key. Brain: buy the domain, build the intake page. | Stripe live |
| Nov 30 – Dec 2 | Buy data; verify 1,500 attorneys. Generate the sample plan; the specialist critiques it; fixes applied. Run the ad probe. Ask AILA for the earliest AILA8 slot. | Sample accepted by the specialist; ad approved or refused |
| Dec 2–9 | 3-step outreach; same-day intake answers; invoices; plans delivered in 5 days | ≥ 2 paid (gate) |
| Dec 10 | Gates | Continue, revise or stop |
| Dec 10–18 | Scale outreach; the AILA week if bought (target run Dec 14–18) | Payments ≥ $4,000 by Dec 16 |
| Dec 19–23 | Last orders before the holidays; deliveries | — |
| Dec 24–29 | Deliver, revise, refund if due | Final figures from Stripe and the ledger |

**Dated cash flow** for base and upside: model section D.
- **Base:** $2,740 in by Dec 9 → $1,000 ad booked Dec 10 → $10,733
  cumulative by Dec 23. Spend $1,998; ~$5,900 in the bank by Dec 29; the rest
  in early January.

---

## Owner actions (exact)

1. **Stripe.**
   - Register at https://dashboard.stripe.com/register and verify identity
     and bank.
   - Turn on ACH Direct Debit and Invoicing.
   - Save the secret key as `STRIPE_SECRET_KEY` at
     https://github.com/Peyday007/V5/settings/secrets/actions.
2. **Payment card.** Approve one card for the pre-proof purchases (domain,
   data, API, reviewer, probe; ≤ $300 total) and for later purchases only
   through the gates.
3. **Anthropic API key.**
   - Create one at https://console.anthropic.com with a $50 credit cap.
   - Save it as the GitHub secret `ANTHROPIC_API_KEY`.
   - Select the provider for this work.
4. **Approve** this route and its limits by telling a Brain session:
   *"Run the v4 E-2 business-plan test with the $300/$2,000 limits."*
   - This also covers sending under the new brand from Brain's sending
     infrastructure.
   - Optionally, reallocate one Claude routine instead of the API.
5. **Nothing physical.** About 1 hour in total; no calls with customers.

---

## Brain capabilities used in this round

- **Anthropic pricing** (claude-api skill): fulfilment cost.
- **Integrations** (previous reads): Stripe missing, Anthropic provider built
  but not selected, sending infrastructure available.
- **PDF extraction** in this container: read the AILA media kit.
- **Brain's records** (`docs/ARCHITECTURE-RECORD.md` §76, §84): the owner's
  rejection of freelance work and the routine reservation.
- **The model:** written and run here.

No Instantly campaign data was used.
