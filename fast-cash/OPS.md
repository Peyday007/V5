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

- **Last check:** 2026-10-20 10:05Z. Production is serving feb5351, which includes PR #243 and PR #245.
- **Scope:** PR #237/#238 widened what Brain delivers. It now also takes data entry, document conversion, client CSV/Excel processing and simple graphics such as logos and brand identity. It also accepts other currencies, converted at Freelancer's own rate. See `docs/FREELANCER-OPERATION.md`.
- **Operation:** runs unattended on Brain's tick.
  - 49 scans so far, the last at 08:58Z.
  - 1887 jobs screened: 1878 rejected with reasons, 6 withdrawn and 3 PREPARED.
  - The 3 PREPARED bids are not sent; Brain cannot bid yet:
    - Freelancer 40772671, "Social Media Text Data Entry": about USD 180;
    - 40775802, "PDF Text to Word": about USD 161;
    - 40777245, "ISO 27001 Certification Partner Needed": wrongly prepared; see below.
  - 40776882 (the factory post) was withdrawn after PR #243 deployed, as expected.
  - Top rejection reasons: budget below the minimum (930), too many bids already (693), hourly work (478), calls or meetings (453), posted too long ago (401).
- **Screen defect, fixed:**
  - 40777245 was prepared at INR 75000, about USD 792, three times the USD 250 bid ceiling. When a client's minimum budget is above the ceiling, the price was set to that minimum, and the screen never checked.
  - The job is also certification work, which needs an accredited body to audit the client.
  - PR #245, https://github.com/Peyday007/V5/pull/245, merged as feb5351. The screen now refuses both. Deploy 39400539889 released it.
  - The next scan re-screens and withdraws the job; the next check-in confirms it.
  - Harmless meanwhile: no bid can be sent while the account is not connected.
- **Release-gate note (not Freelancer):** Deploy 39400539889 passed every check before the restart (261/261). After the restart, one of 280 checks failed: the scenario engine's "reproduce" check answered 422. The same check had passed on the same image before the restart. That belongs to the scenario engine, and the image is serving.
- **Acting is blocked** on two owner steps:
  - Freelancer account plus token: `FREELANCER_OAUTH_TOKEN` NOT_CONNECTED;
  - commercial grant: ABSENT.
- **Offers in front of buyers:** none. **Money:** USD 0.
- **Last alert digest:** freelancer-not-connected, commercial-grant-absent (pushed once, 06:25Z; not repeated while unchanged).
