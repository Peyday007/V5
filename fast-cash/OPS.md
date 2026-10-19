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

- **Last check:** 2026-10-19 06:20Z, session-assisted. The scheduled check-in runs at :17 every 3 hours.
- **Operation:** the Freelancer operation has been live on production since revision 37aec59, unattended on Brain's tick.
  - First scan, 06:01Z: read 300 open jobs, rejected 299 with reasons, prepared 1.
  - That one was a farm business plan the screen should have refused. The fix (PR #234) withdraws it.
- **Top rejection reasons:**
  - 254 do not ask for desk research;
  - 119 are priced in INR;
  - 84 are media or design;
  - 80 need software.
- **Acting is blocked** on two owner steps:
  - Freelancer account plus token: `FREELANCER_OAUTH_TOKEN` NOT_CONNECTED;
  - commercial grant: ABSENT.
- **Offers in front of buyers:** none. Brain sends bids once both are in place.
- **Money:** USD 0.
- **Discovery:** the research fleet is running, alongside the operation's own scans every 30 minutes.
- **Last alert digest:** freelancer-not-connected, commercial-grant-absent.
