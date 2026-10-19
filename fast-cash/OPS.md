# Fast Cash: live operation

Brain keeps this file current. A scheduled check-in rewrites it every 3 hours.
It always shows the owner's action list first.

## Your actions: connections and approvals only (about 20 minutes)

Brain finds the jobs, bids, does the work, delivers and collects. Its only limit is what it can deliver itself. These five steps let it act. Details are in `docs/FREELANCER-OPERATION.md`.

1. **Freelancer account** at https://www.freelancer.com/signup.
   - Verify email and phone.
   - Complete Freelancer's identity verification. Withdrawals need it.
   - Set a display name and the headline "Research reports from public sources".
2. **API token.**
   - At https://accounts.freelancer.com/settings/develop, create an app.
   - Generate an access token for your account with the basic and advanced (write) scopes.
3. **Give it to Brain.** At https://fly.io/apps/northline-brain/secrets, add the secret `FREELANCER_OAUTH_TOKEN`.
4. **Approve the limits** in Brain → Cash → *What Brain is allowed to do*:
   - allowed actions: CONTACT_BUYER, QUOTE_AND_INVOICE, ACCEPT_PAYMENT;
   - money ceilings: 0;
   - concurrency: 2.

   Brain's own limits on top of that: 5 bids a day, 2 jobs at once, at most USD 250 a bid, no spending.
5. **Membership: a spending decision, only if needed.** Freelancer's free plan has a monthly bid allowance. Brain reports when it runs out, and buying more is yours to decide.

Not needed: Resend, Stripe, Gumroad, or any work from you.

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
