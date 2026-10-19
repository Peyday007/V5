# The Freelancer operation

Brain runs a research-report service on Freelancer.com end to end: it finds the jobs, bids, does the work, delivers it and collects the payment. The owner connects the account, completes Freelancer's identity checks and approves the limits. Nothing in the loop is the owner's labour.

Code: `server/services/cash/freelancer/`. Table: `marketplace_jobs` (migration `122_marketplace_jobs.sql`, pg `113_marketplace_jobs.sql`). It runs as a pass on the durable Russell tick for every project with an ACTIVE USD cash sprint.

## The loop

| Step | Performed by | Needs |
|---|---|---|
| **Discover** | Brain. Every 30 minutes it reads open jobs through Freelancer's public API. | Nothing. It runs today. |
| **Screen** | Brain, deterministically (`screen.ts`). | Nothing. |
| **Bid** | Brain, through Step 6's effects engine. | Owner's account token, plus a commercial grant with CONTACT_BUYER |
| **Watch** | Brain reads its bids and the client's messages. | Token |
| **Start** | Brain accepts the award, requests the milestone and tells the client. It then opens a research goal on the brief, and the research fleet does the work unattended (§52). | Token, plus QUOTE_AND_INVOICE |
| **Deliver** | When the goal's packet is COMPLETE with a filed, audited document, Brain attaches the report and requests the milestone release. | Token |
| **Collect** | When the milestone clears, Brain records a CUSTOMER_PAYMENT in the ledger, with the milestone id as its reference. | Token, plus ACCEPT_PAYMENT |

The screen accepts only fixed-price USD jobs that explicitly ask for desk research. It rejects, and records why:
- calls, meetings or presence;
- files the client sends, which Brain cannot receive yet;
- access to the client's systems;
- academic work done for a student;
- media or design;
- contacting people on the client's behalf;
- professional credentials;
- running software;
- content writing;
- paid Wikipedia editing.

It fails toward rejection. A missed job costs a bid; a won job nobody can deliver costs a refund and the account's standing.

**Effects.** A bid is EXTERNAL_RECONCILABLE: after an unknown outcome Brain asks Freelancer whether this account already bid, and never bids twice. Messages, award acceptance and milestones are EXTERNAL_OPAQUE: one attempt each, and an unknown outcome is never resent.

**If research cannot deliver.** When the research fails, parks for a person, or runs out of time, Brain tells the client it will not ask for payment and marks the job FULFILMENT_FAILED.

**Limits** (`operate.ts` `LIMITS`, a reviewed constant):
- 5 bids a day;
- 2 jobs at once;
- at most USD 250 a bid;
- no spending at all.

## Owner setup

1. **Freelancer account** at https://www.freelancer.com/signup.
   - Verify email and phone.
   - Complete the identity verification Freelancer asks for. Withdrawals need it.
   - Fill in the profile: a display name, and a headline such as "Research reports from public sources".
2. **Membership.** Freelancer's free plan includes a limited number of bids a month. Brain reads the remaining bids after connection and reports when they run out. Buying a membership is a spending decision and stays the owner's.
3. **API token.**
   - At https://accounts.freelancer.com/settings/develop, create an app.
   - Generate an access token for your own account with the basic and advanced (write) scopes.
4. **Give the token to Brain.** At https://fly.io/apps/northline-brain/secrets, add the secret `FREELANCER_OAUTH_TOKEN` with the token as its value. Fly restarts the machine to apply it, and Brain reads it on the next tick. No code deploy is needed.
5. **Approve the commercial grant** in Brain → Cash → *What Brain is allowed to do*:
   - allowed actions: CONTACT_BUYER, QUOTE_AND_INVOICE, ACCEPT_PAYMENT;
   - money ceilings: 0;
   - concurrency: 2.

After that, nothing else is the owner's. Payouts land in the Freelancer balance, and withdrawing them is the owner's, under Freelancer's own checks.

## Known gaps

- **Free-form client messages are recorded, not answered.** Each one appears as `MARKETPLACE_MESSAGE_RECEIVED` on the sprint's history and in the cash report. Brain sends only its own status messages: started, delivered, unable.
- **Client files cannot be received.** Jobs that need them are rejected rather than bid on.
- **USD only.** The sprint's ledger is in USD and Brain does not choose an exchange rate, so jobs in other currencies are rejected.

## Reading it

`cash-report.yml` prints a **MARKETPLACE** section with:
- jobs by state;
- why jobs were rejected;
- the last scan;
- whether an account is connected;
- every bid, award, delivery, payment and client message.
