# Commercial sprint, 2026-10-16: the first paid order

## The buyer request

- **Where:** Freelancer.com project **40771060**, "Office Automation & Date Formatting"
  <https://www.freelancer.com/projects/excel-vba/Office-Automation-Date-Formatting>
- **Posted:** 2026-10-16 10:24:19 UTC (`time_submitted` from Freelancer's public API).
- **Status:** `active` / `open` when re-read at about 20:30 UTC on 2026-10-16. It
  had 55 bids averaging ₹21,212, and bidding is open for 7 days.
- **Budget:** fixed price, ₹12,500–37,500 (about $131–394 at 95.10 INR/USD).
- **Buyer:** the API hides the employer's identity, country and payment
  verification. **Check them on the page before bidding** (see "Owner action").
- **Requirements, verbatim in substance:** sweep the files the team works
  with each week, find every date, and force it into DD-MM-YYYY. Dates sit in
  spreadsheet cells, column headers and text inside strings. The buyer wants a
  one-click or scheduled routine that covers both existing and future files, a
  short set-up guide for colleagues, the script, usage instructions and a
  changelog. Any technology is fine if it runs on a typical office PC.
- **Acceptance condition (from the brief):** every detected date in their
  spreadsheets and text reports comes out as DD-MM-YYYY. It works one-click or
  on a schedule, and colleagues can roll it out from the guide without coding.

## Why this one (short comparison of today's open requests)

| Request (Freelancer, 2026-10-16) | Budget | Bids | Verdict |
|---|---|---|---|
| **40771060 Date formatting automation** | ₹12.5–37.5k | 55 | **Chosen.** Self-contained and needs no third-party accounts. A preview is possible today and delivery fits in 1–3 days. |
| 40771200 Numeric data cleaning | $30–250 | 92 | Needs the buyer's SQL Server and an Agent job, so more setup and a lower budget. |
| 40771512 Supplier-portal scraper → Sheets | $250–750 | 323 | Needs login to two third-party portals. The 323 bids make the field crowded, and success depends on a full weekly cycle. |
| 40771639 Website content scraping | $30–250 | 256 | Crowded and low value. |
| 40771264 Gas-accounting automation | ₹600–1.5k | 21 | Budget is out of proportion to scope. |

Reddit (r/forhire, r/slavelabour) and Upwork refuse automated reads from this
environment, so those channels were not checked. No existing sales assets or
buyer conversations exist in this repository.

## What we deliver, when, for what

- **Deliverable:** a Python tool with a double-click launcher and an optional
  Windows Task Scheduler entry. It covers .xlsx/.xls/.csv/.txt, plus .docx if
  needed. Real date cells keep their value and get DD-MM-YYYY display, so
  formulas keep working. Text dates become real dates. Dates embedded in
  strings are rewritten in place. Identifiers, versions and phone numbers are
  left alone. Every change is logged. The handover includes a set-up guide, a
  changelog and a dry run on copies of the buyer's own files.
- **When:** a first version within 24 h of receiving sample files, and the
  finished handover within 3 days.
- **Price:** **₹18,500 fixed** (≈ $195), below the ₹21,212 average bid. Proposed
  milestones: ₹9,250 on award (escrowed), then ₹9,250 on acceptance.

## Costs and margin

| | ₹ | ≈ $ |
|---|---|---|
| Bid price | 18,500 | 194.5 |
| Freelancer fee (10% of fixed price, min $5) | −1,850 | −19.5 |
| Direct delivery costs: no paid inference, licences or subcontractor (Python and the libraries are free; work runs in the existing Claude subscription) | 0 | 0 |
| Withdrawal (PayPal or Express withdrawal, $1) | ≈ −95 | −1.0 |
| **Net to us** | **≈ 16,555** | **≈ 174** |

Effort is about 4–6 hours of build, tuning on their files, and support. No
subcontractor is needed.

## Sample / proof

`preview/` holds a working preview of the detection rules only. It does not
include the folder sweep, the launcher, the scheduler, the guide or tuning on
the buyer's files, so the paid job is not done unpaid. The preview contains:

- `make_sample.py`, which builds an **invented** messy workbook and report.
  This is not customer data.
- `normalize_preview.py`, the rules.
- `sample_before.xlsx` / `sample_after.xlsx`, `sample_report_before.txt` /
  `sample_report_after.txt`, and `change_log.txt`. The before/after files show
  real date cells reformatted without becoming text, and text dates converted.
  They also show invoice ids, version numbers and a "Build 4.10.2026" tag left
  alone, and an ambiguous 03/04/2026 logged.

Send these to the buyer in Freelancer chat once they reply.

## Payment route

The route is Freelancer.com milestone payments: the buyer funds the escrowed
milestone on award, and we release work against it. Withdrawal goes to
PayPal/Payoneer for $1. No other payment route is needed.

## Owner action (one step, Peyton)

Brain cannot log in to Freelancer, hold its balance, or send a bid. So:

1. Sign in to Freelancer.com. Create a free account if needed. Bidding is free,
   with 6 bids/month on the free plan.
2. Bidding requires holding a **$20 minimum account balance**. That is a
   deposit kept in the account, not a fee. Add it only if you authorize it.
3. Open the project URL above. Check that it is still open and that the
   employer shows **Payment verified**. If not, skip it, and the second choice
   is 40771200.
4. Place a bid of **₹18,500**, delivery **3 days**, with the text of `BID.txt`
   pasted verbatim (1,432 characters). Add the two milestones above.

When the buyer replies in chat, forward their message and sample files into
this session. The build starts immediately.
