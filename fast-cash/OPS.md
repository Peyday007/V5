# Fast Cash: live operation

Brain keeps this file current. A scheduled check-in rewrites it every 3 hours.
It always shows the owner's action list first.

## Your actions (one sitting, about 30 minutes)

1. **Freelancer account.** This unlocks both prepared bids.
   1. Sign up at https://www.freelancer.com/signup.
   2. Verify your email and phone.
   3. Put USD 20 on the balance (Dashboard → Deposit Funds). Freelancer publishes this as the minimum balance needed to bid. It stays your money.
2. **Bid 1: Freelancer 40774287 "Precise Entry From PDFs"** (budget INR 12,500–37,500, 37 bids).
   - Open https://www.freelancer.com/projects/data-cleansing/precise-entry-from-pdfs and choose **Bid**.
   - Paste the proposal from Brain → Cash → Decisions → *Prepared by Brain, not sent*, at INR 16,000.
   - Who delivers: you key the data, or you share the PDFs with Brain in a session and it keys them. That route is session-assisted.
3. **Bid 2 (only if you or a builder can deliver a WordPress site):** Freelancer 40771439 "WordPress Portfolio Site Build" ($250–750, 218 bids).
   - The proposal is prepared in the same place.
   - Skip it if nobody can build the site.
4. **Gumroad listing: Sudoku Interior Vol. 1, $7.**
   - Sign up at https://app.gumroad.com/signup.
   - New product → Digital product. Paste the copy from `fast-cash/LAUNCH-SUDOKU.md` (the PDFs: `npm run puzzle-book -- --volume v1 --count 100 --out out/` and again with `--layout large-print`) and upload both PDFs, both manifests and the two images. Publish.
   - Then Settings → Payments: add a payout method. Gumroad pays out from a $100 balance.
5. **Brain → More → Puzzles.** Record that you read the sample, so Sudoku can move into Cash.
6. **Reply once** with your Freelancer username, which bids you placed, and the Gumroad product URL.

**Not needed for Monday:**
- a Brain commercial grant;
- Resend or Stripe keys.

No prepared offer goes out by email, so none of those would put an offer in front of these buyers.

## What happens after (no action from you unless it says so)

- **Freelancer award:** you accept it, the client funds a milestone, the work is delivered, and the client releases the milestone. Freelancer keeps 10% or USD 5. Withdrawal needs Freelancer identity verification. This is a person's step, and Freelancer will ask for it.
- **Gumroad sale:** record it in Brain → Cash → *Record a payment received*, with the sale id as the reference.
- **Brain cannot read your Freelancer messages or Gumroad sales** without a token. It reports bid status from the public API, and you relay replies.
  - Optional later: a Freelancer API token and a Gumroad access token would let Brain watch both unattended.
  - Having Brain *place* bids itself would also need a Freelancer bid integration, which does not exist yet.

## State

<!-- The check-in replaces everything below. -->

- **Last check:** 2026-10-19 04:20Z, session-assisted. The scheduled check-in runs at :17 every 3 hours, bound to session session_01KZfTUmskWgvuNKdQDMKrPb.
- **Leads:**
  - Freelancer 40774287: OPEN, 37 bids, average INR 18,165.
  - Freelancer 40771439: OPEN, 218 bids, average USD 386.
- **Prepared in Brain, not sent:**
  - cpd_a4835774b81f46aab4e6 (cop_9b9c7aacd6ba42a7ba2a);
  - cpd_e713a020eca445b2af0b (cop_bce75bb8197849ddaa0b).
- **Offers in front of buyers:** none yet. Every one waits on your actions 1–4.
- **Discovery, unattended:**
  - Brain's tick and the research fleet are running: 4,705 sessions started in 7 days, 1,748 accepted completions.
  - Fired Routines filed 169 claims from readable routes. 449 fragments in the last week were blocked by the surfaces' own network access.
- **Portfolio:**
  - 307 openings: 252 signals, 54 candidates, 1 READY.
  - The READY piece is a Copart broker listing at USD -795 and is not worth pursuing.
- **Money:** USD 0. The commercial grant is ABSENT, and no messaging or billing provider is set. Neither is needed for the current offers.
- **Last alert digest:** 8674746cac4dccf3, with open blockers: owner-freelancer-account, owner-gumroad-listing, owner-puzzle-read.
