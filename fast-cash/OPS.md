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

- **Last check:** 2026-10-19 18:46Z. Production is serving fd50716. A Deploy of df3cf8f was still running at 18:46Z.
- **Scope widened.** Another session (PR #238) widened what Brain can deliver beyond research reports. It now also takes data entry, document conversion and client CSV/Excel processing. It also accepts other currencies, converted at Freelancer's own rate. See `docs/FREELANCER-OPERATION.md`.
- **Operation:** runs unattended on Brain's tick.
  - 24 scans so far, the last at 18:33Z.
  - 1196 jobs screened: 1191 rejected with reasons, 1 withdrawn and 4 PREPARED.
  - The 4 PREPARED bids are not sent; Brain cannot bid yet. They are Freelancer 40773783, 40772671, 40772623 and 40775802.
  - The large figures shown for three of them are INR, not USD. For example, INR 17043 is about USD 205.
  - 40772623 requires the work to be done by hand. The fix in 36d3c4a, deploying in df3cf8f, withdraws it on the next scan.
  - Top rejection reasons: budget below the minimum (549), too many bids already (390), calls or meetings (308), hourly work (305), posted too long ago (264), ongoing work (203).
- **Acting is blocked** on two owner steps:
  - Freelancer account plus token: `FREELANCER_OAUTH_TOKEN` NOT_CONNECTED;
  - commercial grant: ABSENT.
- **Offers in front of buyers:** none. **Money:** USD 0.
- **Last alert digest:** freelancer-not-connected, commercial-grant-absent (pushed once, 06:25Z; not repeated while unchanged).
