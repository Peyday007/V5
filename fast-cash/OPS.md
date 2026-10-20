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

- **Last check:** 2026-10-20 15:00Z. Production serves a296bf8, released by Deploy 39433491987 at about 14:20Z.
- **Outage, restored:** Brain stopped answering at 13:25Z. The database was overloaded, the machine stayed up but failed every health check, and Fly does not restart a machine for that. The a296bf8 release restarted it. /healthz has answered 200 since.
- **Research capacity fix, live:** PR #246 (a43b033). The discovery grant's concurrency grows with the research surfaces on record and never drops below 6. It now reads 13; it was 6.
- **Operation:** runs unattended.
  - 57 scans so far, the last at 14:10Z.
  - 2091 jobs screened: 2081 rejected with reasons, 8 withdrawn and 2 PREPARED.
  - The 2 PREPARED bids are not sent:
    - Freelancer 40775802, "PDF Text to Word": about USD 161;
    - 40777786, "PDF-to-Word Conversion -- 2": about USD 193.
  - 40777245 (ISO 27001) was withdrawn by the PR #245 screen, as expected.
- **Acting is blocked** on two owner steps:
  - Freelancer account plus token: `FREELANCER_OAUTH_TOKEN` NOT_CONNECTED;
  - commercial grant: ABSENT.
  - The messaging and billing providers are also MISSING.
- **Offers in front of buyers:** none. **Money:** USD 0.
- **Last alert digest:** freelancer-not-connected, commercial-grant-absent (pushed once, 06:25Z; not repeated while unchanged).
