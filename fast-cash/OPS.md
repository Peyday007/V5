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

- **Last check:** 2026-10-20 00:22Z. Production is serving fb5675f.
- **Scope:** PR #237/#238 widened what Brain delivers. It now also takes data entry, document conversion, client CSV/Excel processing and simple graphics such as logos and brand identity. It also accepts other currencies, converted at Freelancer's own rate. See `docs/FREELANCER-OPERATION.md`.
- **Operation:** runs unattended on Brain's tick.
  - 33 scans so far, the last at 23:58Z.
  - 1565 jobs screened: 1558 rejected with reasons, 3 withdrawn and 4 PREPARED.
  - The 4 PREPARED bids are not sent; Brain cannot bid yet:
    - Freelancer 40772671, "Social Media Text Data Entry": about USD 180;
    - 40775802, "PDF Text to Word": about USD 161;
    - 40774101, "Logo Concepts for Creative Brand Names": about USD 170;
    - 40776694, "Complete Brand Identity Design for a Modern Skincare Brand": USD 193.
  - Top rejection reasons: budget below the minimum (742), too many bids already (579), hourly work (397), calls or meetings (381), posted too long ago (358), video, audio or animation (294).
- **Acting is blocked** on two owner steps:
  - Freelancer account plus token: `FREELANCER_OAUTH_TOKEN` NOT_CONNECTED;
  - commercial grant: ABSENT.
- **Offers in front of buyers:** none. **Money:** USD 0.
- **Last alert digest:** freelancer-not-connected, commercial-grant-absent (pushed once, 06:25Z; not repeated while unchanged).
