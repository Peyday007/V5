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

- **Last check:** 2026-10-19 21:20Z. Production is serving 5916707. That release (#239) went out, though its Deploy run reported a failure after release; that run was not this campaign's.
- **Scope:** PR #237/#238 widened what Brain delivers. It now also takes data entry, document conversion, client CSV/Excel processing and simple graphics such as logos. It also accepts other currencies, converted at Freelancer's own rate. See `docs/FREELANCER-OPERATION.md`.
- **Operation:** runs unattended on Brain's tick.
  - 28 scans so far, the last at 20:52Z.
  - 1499 jobs screened: 1493 rejected with reasons, 3 withdrawn and 3 PREPARED.
  - The 3 PREPARED bids are not sent; Brain cannot bid yet:
    - Freelancer 40772671, "Social Media Text Data Entry": INR 17043, about USD 180;
    - 40775802, "PDF Text to Word": INR 15256, about USD 161;
    - 40774101, "Logo Concepts for Creative Brand Names": INR 16125, about USD 170.
  - Withdrawn automatically on re-screen:
    - 40772623, which requires the work done by hand;
    - 40773783, which already has 61 bids.
  - Top rejection reasons: budget below the minimum (714), too many bids already (548), hourly work (382), calls or meetings (371), posted too long ago (344), video, audio or animation (282).
- **Acting is blocked** on two owner steps:
  - Freelancer account plus token: `FREELANCER_OAUTH_TOKEN` NOT_CONNECTED;
  - commercial grant: ABSENT.
- **Offers in front of buyers:** none. **Money:** USD 0.
- **Last alert digest:** freelancer-not-connected, commercial-grant-absent (pushed once, 06:25Z; not repeated while unchanged).
