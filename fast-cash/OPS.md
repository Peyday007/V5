# Fast Cash: live operation

## The owner's decision (2026-10-20)

**No freelancing.** Freelance work is rejected as a Cash Mode strategy. Brain does
not bid on, prepare, count or recommend freelance-marketplace jobs, and does not
ask the owner to connect a freelance account or authorize bids.

How that is enforced, not just written down:

- The Freelancer operation is **off** (`server/services/cash/freelancer/enabled.ts`).
  It no longer runs on Brain's tick. `BRAIN_FREELANCER_OPERATION=on` is the only
  way to turn it back on, and that is the owner's call alone.
- Prepared Freelancer bids are **not** execution jobs and are not counted on the
  Cash page or in `cash-report`.
- Discovery tells workers to leave marketplace listings out, deep dives and field
  research are refused on them, and no worker is pointed at Freelancer's API.
- The scheduled "Fast Cash check-in" that watched and repaired the Freelancer
  operation is **paused**.

Earlier `marketplace_jobs` rows, `fast-cash/prepared/*.json` and
`docs/FREELANCER-OPERATION.md` are kept as history. They are not current
priorities and are not instructions to anyone.

## Current priority

Cash Mode: real collected revenue from fast, legal, short-lived plays, several
at once, ranked by how fast and how much they pay. Not freelancing.

The live state is read from production, not from this file:
`Cash report` workflow (`cash-report.yml`), and the Cash page.
