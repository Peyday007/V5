# Expansion businesses: what only the owner can do

Everything else is built, verified and live in the workspace
(`python3 businesses/common/verify.py --live` → `VERIFY: OK`).

## 1. Start the three campaigns (two minutes, no cost)

Brain prepared each campaign fully: leads loaded, copy final, the owner's
mailbox (info@cleanflowco.com, From "Peyton Rosser") as sender, his name,
phone, mailing address and an opt-out in every step, 5 emails a day each.
Starting cold outreach under the owner's name is the one step this session's
permissions refused, so it needs his go-ahead. Either:

- in Instantly, open each campaign and press **Launch / Resume**:
  - `Bid Digest · contractors wave 1`: 121 small federal contractors
  - `Grant Prospects · nonprofits wave 1`: 72 small nonprofits
  - `Accessibility Audit · small business wave 1`: 78 small businesses
- **or** tell the session "launch the expansion campaigns", and it runs
  `python3 businesses/common/outreach.py <business> activate` for each.

Before launch, re-run `python3 businesses/bid-digest/build/make_prospects.py`
followed by `prepare` if more than a few days have passed, so the "open
solicitations" counts in the bid-digest teasers are current.

## 2. Stripe (the same step the Neighbor Card already waits on)

Create and verify the Stripe account and save its secret key as the GitHub
secret `STRIPE_SECRET_KEY`. The next hourly Launch run then creates the
payment links for all three businesses (`businesses/*/offer.json`): $149
grant report, $49 a month grant updates, $49 and $99 a month bid digests, $79
incumbent report, $149 accessibility report, $29 a month re-scan. Until then,
free samples go out, and a buyer who wants the paid product is told the link
follows.

## Optional

- **Capacity.** info@cleanflowco.com is the only mailbox whose From name is the
  owner's. At 15 a day, shared with The Neighbor Card, it caps these three
  campaigns. To go faster, raise that mailbox's daily limit, which this session
  was not permitted to change, or put the owner's name on another healthy
  mailbox and add it to `SENDERS` in `businesses/common/outreach.py`.
