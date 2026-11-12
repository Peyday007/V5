# Expansion businesses (started 2026-11-11)

New lines of business, separate from the existing ones in `fast-cash/` (Neighbor
Card, Etsy puzzles, print-on-demand store, AI Dispatch, cleaning). Each one is
remote, delivered by Brain from free public data or free tools, sold by email
through the owner's Instantly workspace, and paid through Stripe Payment Links.

| folder | what we sell | who buys | data / tool it runs on |
|---|---|---|---|
| `grant-prospects/` | Grant prospect report, monthly new-opportunity update | small US nonprofits without a grant writer | ProPublica Nonprofit Explorer, IRS 990 data, Grants.gov API |
| `bid-digest/` | Weekly federal contract opportunity digest | small contractors selling to the federal government | SAM.gov public opportunities extract, USAspending API |
| `access-audit/` | Website accessibility (WCAG) audit report, monthly re-scan | small businesses with their own websites | Playwright + axe-core |

Each folder holds the README (buyer, evidence, price, economics, fulfillment,
kill/expand rules), `build/` (the generator that produces the product),
`samples/` (real outputs), `prospects.csv` (businesses whose own site publishes
the address, with the page it was read from), `campaign.py` (the outreach
sequence) and `offer.json` (the products and prices).

## How it runs

1. **Acquire.** `python3 businesses/common/outreach.py <business> prepare`
   loads the leads into a draft campaign, and `activate` starts it with the
   owner's mailing address in every message. Every first email carries a
   specific finding computed for that prospect, and offers a free sample.
2. **Answer.** `python3 businesses/common/operate.py pending` lists replies.
   `fulfill <business> <reply-id>` builds the sample for that person from their
   profile and sends it in the same thread. It refuses a thread already answered.
3. **Get paid.** The Launch workflow's Offers stage creates one Stripe Payment
   Link per product in `offer.json`, the hour after the owner's Stripe key is
   saved (`.launch-out/offer-links.json`).
4. **Measure.** `python3 businesses/common/outreach.py report` writes
   `businesses/STATUS.md` from Instantly's own counts: sent, replies, bounces,
   opt-outs. A business is kept when it reaches ≥2 positive replies per 100
   sends, and it is rewritten or retired below 1 per 200.

## Rules every business keeps

- One honest sender, the mailbox whose From name is the owner's own. The
  owner's name, phone and physical address and a plain opt-out are on every
  message (CAN-SPAM).
- Only addresses a business publishes itself, with the page recorded. A lead
  another campaign already holds is skipped. No list is bought or sold.
- No money is spent. The tools are free, and Stripe charges only on payment.
- No legal advice and no compliance guarantees: the audits state what
  automated testing cannot cover, and the grant reports promise no grant.
