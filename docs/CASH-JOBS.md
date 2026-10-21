# Cash execution jobs

How an opening moves from discovery to usable cash, and what Brain shows at
each step. The code is `server/services/cash/jobPipeline.ts`; CLAUDE.md §70 is
the reasoning.

## When a job exists

The cash `operate` pass prepares **one** job for an opening when:

- its tier is `QUALIFIED` or `READY_TO_TEST`, or it is `READY`; and
- it is not a duplicate, not past its published deadline, and its published
  price is not below its published capital exposure.

An opening already in `EXECUTING`, `DELIVERING` or `COLLECTED` always has a
job. A job is released (never deleted) when the opportunity is declined or
archived, is found to be a duplicate, or — while nothing was committed yet —
stops being actionable.

## Stages

| stage | means |
|---|---|
| Discovered | evidence; nothing says how we would be paid |
| Under qualification | a capture thesis exists; questions remain |
| Qualified, no job | qualified and refused a job — the reason is shown |
| Execution job prepared | Brain is still preparing the offer, buyer or evidence |
| Ready to execute, blocked | preparation done; the first external step waits on authority or a provider |
| Executing | the buyer was contacted, or Brain contacts them next pass |
| Buyer agreement obtained | an agreement with evidence is recorded |
| Delivered | delivery and acceptance are recorded |
| Payment received | paid, **not yet usable cash** |
| Funds settled and usable | settled through the provider or a verified reference |

## Tasks and executors

`offer` (Brain, from the card) · `buyer` and `evidence` (research fleet) ·
`fulfilment` when the card names inputs (supplier, needs `ENGAGE_CONTRACTOR`) ·
`contact` (provider, needs `CONTACT_BUYER` + `SEND_A_MESSAGE`) · `agree` (buyer)
· `deliver` · `collect` (provider when billing is connected, otherwise a person
records the payment with its reference).

## What unblocks what

- **No commercial authority:** grant it on Cash → *What Brain is allowed to
  do*. Preparation continues without it; nothing is contacted.
- **No messaging provider:** set `BRAIN_MESSAGING_PROVIDER=resend`,
  `RESEND_API_KEY`, `BRAIN_MESSAGING_FROM`. A person may send and record the
  contact meanwhile; Brain resumes by itself once it is set.
- **No billing provider:** set `BRAIN_BILLING_PROVIDER=stripe` and
  `STRIPE_SECRET_KEY`, or issue the invoice outside Brain and record the
  payment with its reference.

## Marketplace jobs

A Freelancer job the marketplace screen prepared is shown as an execution job
in the same stages (`marketplacePipeline.ts`): PREPARED is *ready, blocked*
until `FREELANCER_OAUTH_TOKEN` is set and the grant allows `CONTACT_BUYER`;
a sent bid is *executing*; an award is *agreed*; then delivered and paid. The
rows stay in `marketplace_jobs`; nothing is copied into `cash_jobs`.

## What is not researched

No deep dive, field question or monetization question is spent on a
marketplace listing, an opening closing within 72 hours, or an asset to buy
that deployable cash cannot cover (`worthResearching.ts`). Each lifts by
itself when its row changes.
