# $10,000 collected in 30 days, at most $2,000 spent: decision plan, version 3

**Date:** 2026-11-26. **Status:** planning only. Nothing was sent, spent, hired,
resumed, merged or deployed.

**Files in this folder:**
- `PLAN.md` (this file)
- `model.py`, the model
- `model-output.txt`, its output
- `evidence.json`, live records aggregated with no personal data

Rerun the model with:

```
python3 -I fast-cash/10k/2026-11-26-v3/model.py
```

It supersedes `docs/CASH-10K-PLAN-2026-11-26.md` (v1, postcard) and the v2
accessibility plan (scratch only). §9 explains what changed and why.

---

## 1. Verdict and how strong the evidence is

**On the evidence available, $10,000 of customer payments in 30 days is not
supported by any route examined.**

**Strong evidence: low-ticket offers cannot reach it on this channel.**

- **The arithmetic** (model §2). The best engagement this workspace has ever
  recorded is 1.10% of contacted leads (Neighbor Card, 5 of 453). At that
  rate, with 2,500 leads and 20–35% of engaged buyers paying, $10k needs an
  average order of **$1,200–$2,200**.
- **The pooled history** of every other campaign is 0.065% (2 of 3,056). At
  that rate, $10k needs an average order above $20,000.

**Moderate evidence: the best route found tops out below $10k at observed
rates.** The recommended accessibility offers reach **$4.9k in customer
payments** even when engagement is the best ever observed and the paid rate
is a generous 35% (model §3). They reach about **$12.6k** only if a third
segment (sued businesses, which needs new access) engages at about 3%. That
is roughly three times anything recorded.

**No evidence at all on the decisive unknown:** whether engaged buyers pay
this seller. No payment link has ever been sent, because Stripe has never
been set up, and no order has ever been recorded.

**What this does not prove.** It does not show that no route exists. Routes
that need assets Brain has no record of (the owner's network, existing
customers, an audience) were not examined. So were channels the current
permissions do not allow. §10 lists what would change the verdict.

**So the plan is built around one decision-grade, $0 test.** Within 8
working days, the test shows which of three worlds this is:
- the target is unreachable;
- a few thousand dollars is reachable;
- the $10k track is open.

Every later dollar depends on that result.

---

## 2. The offer, buyer, channel, fulfilment and reason to buy

**Brand:** "Tabstop Accessibility Reports". The business already exists in
`businesses/access-audit/`.

| Arm | Buyer | Offer and price | Reason to buy now | How reached |
|---|---|---|---|---|
| **A. Agencies** | Small web design and marketing agencies that manage client websites | White-label automated WCAG 2.1/2.2 AA reports: **10 client sites $349, 40 sites $990**, delivered in 2 business days, with one free client-site report as the sample | Clients ask about ADA suits, which are up 27% in federal courts, 2024→2025 (Seyfarth: 3,117). Competing tools charge $29 a month per site (AllAccessible, PageAudit), so 40 sites costs $1,160 a month against $990 one-time here. | Cold email from the owner's Instantly workspace; leads from Brain's harvest (published addresses only, MX-checked) |
| **B. Small businesses** | Independent shops, practices, firms and lodging whose homepage Brain's scan finds 3 or more critical or serious issues on | **Audit Report $149** (10 pages, desktop and mobile, a fix for every issue). **Fix Kit $395** (report + 2 re-scans + fix order). The free homepage summary is the sample. | Their own site's exact counts, in the first email. Suits are rising. Overlays are discredited (FTC order against accessiBe, $1M, 2025). | Same |
| **C. Sued businesses** *(needs new access)* | Businesses named in website-accessibility suits in the last 90 days | **Remediation Evidence Pack $750**: 25 pages, fix list, 2 re-scans, before/after record | A live suit with dates | Same, with leads from CourtListener dockets (API needs an account: HTTP 401 observed) |

**Fulfilment.** Brain's generator (`node build/audit.mjs`):
- **Verified today.** A 5-page audit with PDF took **53 seconds** and found
  54 issues on W3C's test page.
- **Capacity** is about 30 full audits an hour per machine, so it is not a
  constraint.
- **Marginal cost** is $0: local Chromium and vendored axe-core, no paid
  models.
- **Quality control:** a report ships only if every requested page scanned
  (`couldNotScan` empty, or the page is listed and refunded pro rata). Counts
  are checked against `summary.json`.

**Honesty limits, stated on every report:**
- automated testing finds about 57% of issues (Deque, by issue volume);
- no legal advice, no compliance certificate.

**Payment.** Stripe Payment Links, card or ACH, paid in full before delivery.
- **Refunds:** a 7-day no-questions refund on any report.
- **No deposits.** A deposit proves a buyer will commit money at a price. It
  does not prove they will pay the balance. It also creates a delivery and
  refund liability while the money cannot be counted as kept. With 2-day
  delivery, full prepayment proves more and owes less.

---

## 3. The quantitative model

**Customer payments in the window** =
Σ over arms of **L** (leads delivered and contacted) × **e** (engaged per
lead) × **c** (paid, given engaged) × **w** (paid inside the window) × AOV.

Then: refunds = payments × **r**; Stripe fees = 2.9% + 30¢ per order. Bank
settlement lags payment (first payout 7–14 days after the first live payment,
then rolling).

### Inputs and their basis

| Quantity | Exact definition | Value or range | Basis | Source, sample, limits |
|---|---|---|---|---|
| **e**, engaged rate | Human replies asking for a sample, quote, call or buying detail ÷ unique new leads contacted, over a 3-step sequence | Conservative **0.065%** · Base **0.27%** · Upside **1.10%** | Conservative and upside **OBSERVED**. Base **INFERRED** (geometric midpoint, no direct evidence). | Instantly, read and hand-classified 2026-11-26 (`evidence.json`). Pooled non-postcard campaigns: 2 of 3,056 (Wilson 95%: 0.02–0.24%). Neighbor Card: 5 of 453 (0.47–2.56%). AI Dispatch, a findings-style "a few things we noticed" offer and the closest analog to this one: **0 of 385** (upper 0.99%). Instantly's own "interested" label overcounts: its 3 AI Dispatch "interested" are auto or support replies. **Not transferred blindly:** none of these campaigns sold audits. The range brackets the recommended copy, which follows the Neighbor Card's specific, priced, risk-reversed pattern. |
| **c**, paid given engaged | Engaged leads paying within 14 days of engaging | 10% · 20% · 35% | **ASSUMED** | No observation exists: zero payment links have ever been sent. Shown with break-evens in §5. |
| **L, arm A** | Agency leads with a published, MX-valid address, contacted Dec 1–18 | 150 · 400 · 1,000 | **INFERRED** | NAICS 5415 has 145,813 establishments (Census CBP 2023, from Brain's knowledge store). Brain's harvest kept 78 of 853 small-business candidates (9.1%). The agency-specific harvest rate is unmeasured. |
| **L, arm B** | Small-business leads (≥3 critical/serious issues, published email, MX-valid) | 600 · 1,500 · 3,000 | **INFERRED** | Same 9.1% harvest yield (853 → 412 scanned → 182 with email → 78 qualified). NAICS 4541 alone has 54,707 establishments. **Limit:** the Neighbor Card's local refill added 407 leads in 2 days, then 1–20 a day once its area was exhausted (OBSERVED). A national harvest is not exhausted the same way, but its throughput at 1,500+ leads is unmeasured. |
| **L, arm C** | Defendants from the last 90 days with a published business email | 300 · 600 · 900 | **INFERRED** | Seyfarth 3,117 federal suits in 2025 (~260 a month); UsableNet 5,114 including NY/CA state courts. A findable-email share of 40–70% is assumed. |
| Sending capacity | Delivered first-touch emails a day | Up to ~300 new leads a day (930 sends ÷ 3 steps) **with** multi-sender approval; **~15 a day under current permissions** | **OBSERVED** | Integrations: 12 of 18 accounts healthy, 930 a day. `businesses/OWNER-ACTIONS.md`: one owner-named mailbox at 15 a day, shared. |
| Delivery | 1 − bounce rate | 97–98.5% | **OBSERVED** | Neighbor Card MX-checked list: 19 of 1,274 bounced (1.5%). Unchecked lists: 9.7–40%. |
| AOV, arm A | Mean order | $670 (half $349, half $990) | Prices are the offer's; the mix is **ASSUMED** | — |
| AOV, arm B | Mean order | $223 (70% $149, 30% $395) | Mix **ASSUMED** | — |
| **w**, in window | Share of eventual orders paid by Dec 29 | 70% · 85% · 95% | **ASSUMED** | Instantly: 58% of replies come from the first email. The holiday slowdown starts about Dec 21. |
| **r**, refunds | Refunded share of payments | 10% · 7% · 5% | **ASSUMED** | 7-day guarantee |
| Fees | Stripe per order | $4.62 / $11.76 / $10.42 / $29.01 / $22.05 | **EXTERNAL** | stripe.com pricing: 2.9% + 30¢ |
| Settlement | First payout lag | 7–14 days, then rolling | **EXTERNAL** | Stripe docs and support |

### How the inputs depend on each other

- **One "offer-market fit / seller credibility" factor** moves e and c
  together. The conservative scenario takes both low and the upside takes
  both high. The sweep (model §5) draws them from one shared factor and does
  **not** treat them as independent.
- **Lead supply binds before sending capacity** once multi-sender approval
  exists.
- **Under current permissions, sending capacity binds absolutely:** about
  120 leads in 8 days.

### Results (model §3 and §8)

| Scenario | Arms A+B payments | + arm C (new access) | Basis |
|---|---|---|---|
| Conservative | **$11** | $21 | Pooled history for e; low c |
| Base | **$275** | $734 | Inferred middle e; c 20% |
| Upside | **$4,910** | **$12,605** | Best observed e for A+B; C at 3% engaged and 40% paid |

**Sweep over A+B only** (a spread, **not a probability**): 10th percentile
$65, median $368, 90th percentile $1,693, highest $5,110. No world in the
sweep reaches $10k.

---

## 4. Money in every scenario (day 30 = Tue Dec 29)

| | Conservative | Base | Upside (A+B) | Upside incl. C |
|---|---|---|---|---|
| Customer payments | $11 | $275 | $4,910 | $12,605 |
| Refunds | $1 | $19 | $246 | ~$630 |
| Stripe fees | $0 | $8 | $147 | ~$380 |
| Other spending | $0 | $50 (list verification, pre-proof allowance) | $50 | $50 + up to $600 released (§7) |
| **Total spending** | $0 | $58 | $197 | ≤ $1,030 |
| **Net profit** | ~$10 | ~$198 | ~$4,468 | ~$10,900 |
| **Settled to the bank by Dec 29** | $0 | ~$189 | ~$4,320 | ~$10,000 (the rest settles after day 30) |
| Open obligations after day 30 | none | Fix Kit and agency re-scans ($0 cost) | same | + Evidence Pack re-scans |

The week-by-week cash flow is in model §6. Spending stays far under $2,000
because fulfilment costs nothing. The cap only matters if released spend is
used (§7).

---

## 5. Sensitivity, and the thresholds for $10,000

**Required average order** at 2,500 leads (model §2):

| Engaged rate | Paid 20% | Paid 35% |
|---|---|---|
| 1.10% | $2,165 | $1,237 |
| 0.27% | $8,891 | $5,080 |

**The decision rests on three uncertain inputs, in this order:**

1. **c, paid given engaged.** It has never been observed. No price works if
   it is about 10% or below.
2. **e for arms A and C.** A and C are the only arms with an average order
   of $670 or more.
3. **L for agencies.** It is unmeasured at scale.

**$10k from arms A+B** (with 1,500 small-business leads) needs:
- engaged ≥ 2% and paid ≥ 35% with about **1,750 agency leads**; or
- engaged 3% and paid 35% with about 1,000 agency leads (model §4).

Both rates are above anything observed, and 1,750 agency leads is above the
inferred supply. **With arm C**, $10k needs C at about 3% engaged and 40%
paid, plus A and B at the best observed engagement.

---

## 6. The full loop and the 30-day schedule

**How the loop runs:**

1. **Acquisition.** Harvest, scan, take only published addresses, MX check,
   skip any lead already in the workspace.
2. **Qualification.** Small businesses: 3 or more critical or serious issues,
   independent business. Agencies: a portfolio page with 10 or more client
   sites.
3. **Sale.** First email with exact findings, the price and the guarantee.
   Engaged reply → free sample within 4 working hours → payment link.
4. **Payment.** Stripe → ledger entry.
5. **Fulfilment.** Generator, then automatic quality checks, then delivery
   within 2 business days.
6. **Follow-up.** Re-scans for the Fix Kit and agency packs, plus a renewal
   offer.
7. **Refunds.** Within 7 days, from Stripe.
8. **Feedback.** Instantly reply sync plus Stripe feed e, c and refunds into
   `model.py` daily. Gates (§7) read the measured values, not this table.

| Day | Date | Step | Status | Measure |
|---|---|---|---|---|
| 0 | by Sun Nov 29 | Owner actions 1–4 (§8) | **needs the owner** | Stripe live; launch authorized |
| 1 | Mon Nov 30 | Brain: add the $349, $990, $395 and $750 products to `offer.json`; the Launch run creates the links. Harvest and scan: ≥ 500 small-business and ≥ 200 agency leads. | executable once Stripe exists | leads qualified |
| 2 | Tue Dec 1 | **Test starts:** all three arms (C only if its access exists), ~150–300 new leads a day | needs launch authorization | delivered; bounce < 3% |
| 2–9 | Dec 1–10 | Same-day samples, payment links, delivery within 2 days | Brain | engaged, paid, refunded |
| **5** | **Fri Dec 4** | **Early check:** engagement per arm | Brain | e per arm |
| **9** | **Thu Dec 10** | **Proof gate** (§7) | Brain | orders, $, c |
| 10–18 | Dec 11–18 | Scale the winning arm(s); released spend per §7 | Brain | yield per lead |
| **16** | **Thu Dec 17** | **$10k-track gate** | Brain | cumulative $ |
| 19–22 | Dec 19–23 | Last sends Dec 18; answer replies; deliver | Brain | — |
| 23–30 | Dec 24–29 | Deliver open orders; refunds; count from the ledger and Stripe | Brain | final figures |

---

## 7. The pre-proof test and later spending gates

**Test.** All three arms at once, from Dec 1 to Dec 10, on ~1,500 delivered
leads: ~900 small business, ~400 agency, ~200 sued businesses if access
exists. Copy follows the Neighbor Card pattern:
- the buyer's specific findings;
- the price stated;
- a 7-day money-back guarantee;
- a free sample on reply.

**Spending:** $0 required, plus a $50 reserve for list verification if
bounces exceed 3%. Stripe fees on test sales count. **Pre-proof total ≤ $300,
all routes combined, for the whole window.**

**Under current permissions** (about 15 a day, one mailbox) only about 120
leads are reachable. Model §9: if engagement is truly the pooled 0.065%,
that sample shows nothing 92% of the time. **The test is only decision-grade
with multi-sender approval.**

**What the test can discriminate (model §9):**
- With 1,500 leads, best-campaign engagement gives about 17 engaged leads
  (zero has probability under 0.001).
- Zero orders from 16 engaged leads has probability 0.028 if c is 20%, so
  that result rules out c ≥ 20%.

| Result by Thu Dec 10 | Means | Action |
|---|---|---|
| **≥ 3 paid orders from ≥ 3 customers, ≥ $700, including ≥ 1 agency or sued-business order** | **Proof of demand:** paying buyers at a workable price; c measured | **Continue.** Release up to **$600** for a commission-weighted US caller to follow up engaged and agency leads (ZipRecruiter average $24.26/hr). Re-run the model on measured e and c. |
| Proof, **and** yield ≥ **$2.00 per delivered lead** (≥ $3,000 from 1,500 leads) | The $10k track is open | Also release up to **$400** for lead data if lead supply binds. Total spend cap $2,000 including fees. |
| ≥ 5 engaged, 0–2 paid | Interest without purchase: price or offer problem | **Revise once:** for example, agency 10-site $199 and a small-business report $99. Same $0 spend, same 300 allowance. Re-test Dec 11–16. |
| < 3 engaged from ≥ 1,000 delivered | Channel or list problem (engagement < 0.3%) | **Stop email for this offer.** The remaining allowance (≤ $250) may buy **one** phone test: ~10 hours of a US caller (~400 dials) on agencies. Proof rule is unchanged. If it fails, stop the route for the window. |
| **Dec 17:** cumulative payments < $2,500 | $10k unreachable this window | No new spending. Keep sending at $0 until Dec 18. Report the measured rates. |

**The allowance never resets.** A revised offer, a new arm or a different
channel draws on the same $300.

---

## 8. What the owner must do, exactly

1. **Stripe.**
   - Open https://dashboard.stripe.com/register.
   - Verify identity, bank and the public business details.
   - Go to Developers → API keys → reveal the **Secret key** (`sk_live_…`).
   - Save it at https://github.com/Peyday007/V5/settings/secrets/actions as
     `STRIPE_SECRET_KEY`.

   The next hourly Launch run creates the payment links. This is unavoidable:
   only the owner holds that identity.
2. **Authorize the outreach.** Tell a Brain session: *"Launch the Tabstop
   accessibility campaigns with all healthy senders, each under its own first
   name, per the 2026-11-26 v3 plan."* This replaces the single-mailbox rule
   in `businesses/access-audit/README.md` for this campaign, as was done for
   the Neighbor Card. Without it, the test is not decision-grade (§7).
3. **Grant the commercial permissions** in Russell → Needs You:
   CONTACT_BUYER, QUOTE_AND_INVOICE, ACCEPT_PAYMENT.
4. **Resume goal `wst_7b4fcbb5…`.** It was paused by the 2026-11-26 priority
   override; its record says it resumes when you are ready. Tell a session to
   resume it with this plan's limits: $2,000 total, $300 before proof.
5. *(Optional; enables arm C.)* Create a free account at
   https://www.courtlistener.com/sign-in/. Copy the API token from your
   profile and save it as the GitHub secret `COURTLISTENER_TOKEN`.

**Total owner time:** about 45–75 minutes on day 0, then nothing until the
Dec 29 report.

---

## 9. Alternatives examined, and why this one wins

| Route | Why not |
|---|---|
| **Neighbor Card co-op postcard** (v1) | The best measured engagement (1.1%), but it fails the cap. The owner's post-office drop must go to a vendor: M13 is $1,415 for 4,944 homes before print, about **$2,309** in total, over $2,000. The revenue ceiling is $6,380. The local pool is exhausted (407 leads in 2 days, then 1–20 a day), and 5 engaged leads cannot fill a 10-cell threshold. |
| Cleveland mailer, solo postcards, corporate gifts, dropshipping, commercial-cleaning brokerage | Pass-through or subcontracted costs count toward the $2,000, so they break it for $10k. Cleveland and cleaning engagement were also measured at 0.09% and 0.08%. |
| AI receptionist (AI Dispatch) | Measured 0 of 385 |
| Websites built for small businesses | Plausible average order, but it needs Claude routines, which the owner reserved for Brain (§84), so that fulfilment is unavailable |
| Grant reports, bid digests, puzzle packs, Etsy | Average order $3–$149 needs 67–3,000 sales. Model §2 rules them out. |
| Kits for postcard operators | High average order and zero cost, but the population is small (9x12 Tools sampled 76 operator sites). $10k would need a 5%+ purchase rate from cold email. |
| Paid search or ads before proof | CPC for this niche is unpublished. $300 buys too few clicks to measure a $149–990 purchase. |
| Government accessibility (Title II) | The deadlines moved to Apr 2027 and Apr 2028; procurement pays net-30, past the window |
| **v2 of this plan** (accessibility, small-business-led) | Superseded: v2 did not count the AI Dispatch 0-of-385 analog, lead supply, or current-permission capacity, and did not check average orders against the arithmetic |

**Why the recommendation wins.** It is the only route that meets all of these
at once:
- inside the cap;
- **verified**, zero-marginal-cost fulfilment (run today);
- no owner labour;
- prepaid within the window;
- two arms with average orders of $670–$750, the only kind the arithmetic
  allows;
- an 8-day, $0 test that tells the three worlds apart.

Its upside is still below $10k without arm C, and this plan says so.

**The loop that led here:**
- **v1:** postcard, measured demand, physical drop.
- **Cap applied:** postcard fails.
- **v2:** accessibility, fulfilment verified.
- **Challenge:** AI Dispatch analog 0 of 385, the local pool exhausted, the
  arithmetic forcing average orders of $1k or more.
- **v3:** agency and sued-business arms added, test-power check, permission
  dependency made explicit.

---

## 10. Brain capabilities used, and what would change the verdict

| Capability | What it contributed |
|---|---|
| Instantly via the proxy (`/campaigns/analytics`, `/overview`, `/emails`, `/leads/list`, `/campaigns/{id}`), read-only | Every engagement figure, hand-classified; first-step copy of each campaign; the Neighbor Card's daily lead additions (lead supply); sender counts |
| `brain_operator_integrations` | Stripe missing, Instantly 12/18 accounts at 930 a day, Google Places refused, Sellbird and browser agents connected |
| `brain_operator_goals` / `goal_plan` | Goal paused; planner verdict NEEDS_EVIDENCE, with proven facts supporting $0 |
| `brain_operator_knowledge` (Census store) | NAICS 4541 (54,707) and 5415 (145,813) buyer counts |
| `businesses/access-audit/build/audit.mjs` | Run twice: 48 and 54 issues; **53 seconds per 5-page report with PDF**. Fulfilment and capacity verified. |
| Access-audit prospecting records | Harvest yield 9.1% (853 → 78) |
| Neighbor Card kit and `research-coop-mailer.md` | Postcard costs; the 9x12 Tools operator sample (76 sites) |
| `npm run finish` | Deadline and ledger for this assignment |

**What would change the verdict:**
- **c ≥ 35% measured with e ≥ 2%** in arm A, or **e ≥ 3%** in arm C, in the
  Dec 1–10 test → the $10k track opens (§5).
- An asset Brain has no record of: a warm list of agency or business
  owners, past customers, an audience. That would raise e far above cold
  rates. Tell Brain if one exists.
- Lifting the §84 reservation would make higher-ticket fulfilment, such as
  built websites, available.
