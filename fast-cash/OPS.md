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

- **Last check:** 2026-10-19 15:46Z. Production is serving 62104d6.
- **Operation:** the Freelancer operation runs unattended on Brain's tick.
  - 18 scans so far, the last at 15:16Z.
  - 567 jobs screened: 566 rejected with reasons and 1 withdrawn, Freelancer 40775349.
  - Top rejection reasons: not a desk-research request (488), no research category (388), priced in INR (225), media or design (204), calls or meetings (161), software (159). That farm business plan needed financial models and 3D work. It was prepared by the first scan and withdrawn automatically once the fixed screen shipped.
  - No job currently passes. That is honest: research-report work priced in USD that needs nobody's labour is scarce on Freelancer. Brain keeps scanning every 30 minutes.
- **Acting is blocked** on two owner steps:
  - Freelancer account plus token: `FREELANCER_OAUTH_TOKEN` NOT_CONNECTED;
  - commercial grant: ABSENT.
- **Offers in front of buyers:** none. **Money:** USD 0.
- **Last alert digest:** freelancer-not-connected, commercial-grant-absent (pushed once, 06:25Z; not repeated while unchanged).
