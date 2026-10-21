# The rolling city mailer

One printed mailer per city. Each one has 16 ad slots at $500, one business per
category. Brain sells one city at a time, and the moment the last slot sells it
opens the next queued city by itself. Any city works.

| per city | figure |
|---|---|
| slots | 16 × $500 = **$8,000** |
| print + mail (estimate) | **~$3,000** |
| net if full | **~$5,000** |
| lead target | ~500 businesses |

All four can be overridden per city when it is queued.

## What Brain does by itself (every Cash tick)

- Opens the next `QUEUED` city whenever none is `SELLING`. Only one city sells
  at a time, enforced by a partial unique index.
- Marks a city `FULL` once its slots are sold, then opens the next one.
- Writes one outreach email per business lead and **holds** it.
- Withdraws held drafts for a category that has already sold, and for any
  business that declined or opted out.

## What it never does by itself

- **Send email.** Every draft stays `HELD` until the owner is up and decides how
  to send. Resend, Brain's only messaging adapter, does not permit cold email,
  so sending will likely go through the owner's own cold-email tool. Drafts can
  be exported from `GET …/cash/mailer/cities/:id/outreach`.
- **Spend money.** A `FULL` city waits for a person to approve its print run
  (`approve-print`). That approval records a decision; it does not place the
  order.
- **Invent a sale.** A slot exists only once a payment reference is recorded
  against a lead. Recording the same payment twice still counts as one slot.

## Doors (ADMIN, a person)

```
GET  /api/projects/:id/cash/mailer                          the board
POST /api/projects/:id/cash/mailer/cities                   { city, region, slotCount?, slotPriceCents?, printCostCents?, leadTarget? }
POST /api/projects/:id/cash/mailer/cities/:cityId/leads     { leads: [{ businessName, category, email, sourceUrl? }] }
GET  /api/projects/:id/cash/mailer/cities/:cityId/outreach  held drafts
POST /api/projects/:id/cash/mailer/cities/:cityId/sales     { leadId, paymentRef, amountCents? }
POST /api/projects/:id/cash/mailer/leads/:leadId/response   { response: DECLINED | OPTED_OUT }
POST /api/projects/:id/cash/mailer/cities/:cityId/approve-print
POST /api/projects/:id/cash/mailer/cities/:cityId/mailed
```

## Not built yet

- **Automatic lead sourcing.** Brain does not yet find the ~500 businesses
  itself. Leads come in through the leads door (a CSV, or a list Brain
  researches), and the board says when a city is short of leads.
- **Sending**, as above.
- **Ledger entries.** Slot revenue is read from slot rows and is not yet
  written to `cash_money_entries`. Until it is, the board's figures are not part
  of the sprint's money position.
- **A screen.** The board is an API read for now.
