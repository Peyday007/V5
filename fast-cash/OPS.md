# Fast Cash: live operation

## The owner's decision (2026-10-20)

**No freelancing.** Freelance work is rejected as a Cash Mode strategy. Brain does
not bid on, prepare, count or recommend freelance-marketplace jobs, and does not
ask the owner to connect a freelance account or authorize bids.

How that is enforced, not just written down:

- The freelance-marketplace operation was **removed from the code** (2026-10-22).
  Nothing in Brain bids, delivers or collects on a marketplace.
- Discovery tells workers to leave marketplace listings out, deep dives and field
  research are refused on them, and openings filed from a listing before the rule
  are archived by Brain with their research stopped.

Earlier `marketplace_jobs` and `listing_retrievals` rows stay in the database as
history; no code reads them.

## Current priority

Cash Mode: real collected revenue from fast, legal, short-lived plays, several
at once, ranked by how fast and how much they pay. Not freelancing.

The live state is read from production, not from this file:
`Cash report` workflow (`cash-report.yml`), and the Cash page.
