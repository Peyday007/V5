# The Freelancer operation

> **Off (2026-10-20).** The owner rejected freelance work as a Cash Mode strategy. This operation does not run (`server/services/cash/freelancer/enabled.ts`); this document describes it as history. Do not follow its setup steps.

Brain runs a freelance service on Freelancer.com end to end. It finds jobs, bids, does the work, delivers it, answers the client, revises, and collects the payment. The owner connects the account, completes Freelancer's identity checks and approves the limits. Nothing in the loop is the owner's labour.

Code: `server/services/cash/freelancer/`, with the deliverable renderers and verifiers under `deliverables/`. Tables: `marketplace_jobs` (migration `122_marketplace_jobs.sql`, pg `113_marketplace_jobs.sql`) and `marketplace_deliverables` (`123_marketplace_deliverables.sql`, pg `114_marketplace_deliverables.sql`). The operation runs as a pass on the durable Russell tick for every project with an ACTIVE cash sprint.

## What Brain delivers

A job is accepted only for work Brain has **proved** it can produce on this machine. Each process renders a realistic sample of every kind, then re-reads and checks the bytes (`deliverables/capabilities.ts proveCapabilities`), and the screen reads that proof. Installing a tool does not unlock a category; a passing proof does. The proof is recorded once per process as `MARKETPLACE_CAPABILITIES_PROVED`.

| Category | What Brain sends | What is checked before it leaves |
|---|---|---|
| Research report | a filed, audited report (§52) | the evidence gate and all three audit roles |
| Spreadsheet | `.xlsx` with live formulas, number formats and charts | every formula evaluates, with no error value and no unsupported function; the workbook reopens |
| Business document | `.docx`, `.pdf`, `.md` | the text read back contains every heading; the tables and charts are present |
| Presentation | `.pptx` plus slide pictures | the slide count and titles match; text fits each slide; no slide renders blank |
| Data operation | `.csv`, `.xlsx`, `.json`, plus a change log | the client's own CSV/Excel run through declared steps; the result is re-derived independently and must match |
| Website | a `.zip` of static files | `index.html`, a title and a viewport are present; every local link resolves; scripts parse; no external script |
| Programming | a `.zip` with a README (JavaScript, TypeScript, Python, HTML/CSS, SQL) | the code parses (Python through `ast.parse`, never executed); no credential appears |
| Graphic design | `.svg`, `.png`, `.pdf` | the SVG is safe (no script, foreign object or external reference), renders, and is not blank |
| 3D model | `.obj`/`.mtl`, `.stl`, `.gltf`, plus a render | the geometry is closed and in bounds; the render is not blank. Primitive parts only. |

**The worker writes a specification and Brain writes the files.** A worker answers a `FREELANCE_DELIVERABLE_V1` bin with a JSON spec plus a message to the client. Brain validates the spec field by field, renders the files deterministically and verifies the bytes. Worker code is never run on the server. A failing check refuses the submission with the reasons. The worker corrects it within the same lease, and Brain opens up to four bins per job before giving up honestly.

## The loop

| Step | Performed by | Needs |
|---|---|---|
| **Discover** | Brain. Every 30 minutes it reads open jobs through Freelancer's public API, across 33 searches. | Nothing. It runs today. |
| **Screen** | Brain, deterministically (`screen.ts`, `classify.ts`, `economics.ts`). Rejected jobs seen again are re-screened, so a newly proved capability re-qualifies them (`MARKETPLACE_REQUALIFIED`). | Nothing. |
| **Bid** | Brain, through Step 6's effects engine, in the job's own currency. The proposal says the work is AI-assisted and checked. | Owner's account token, plus a commercial grant with CONTACT_BUYER |
| **Answer** | A client question on an open bid or a running job opens a reply bin. The worker drafts the answer, and Brain refuses contact details, off-platform terms and links. At most 3 replies per job. | Token |
| **Start** | Brain accepts the award, requests the milestone and tells the client. A research job opens a research goal. Any other job opens a deliverable bin; if it needs the client's files, Brain asks once and waits for them. | Token, plus QUOTE_AND_INVOICE |
| **Client files** | Brain downloads files the client attached (only from Freelancer hosts, at most 15 MB each), reads PDF, DOCX, XLSX, PPTX and text, and stores them with their hash. | Token |
| **Deliver** | Brain attaches the verified files, records the version, and requests the milestone release. | Token |
| **Revise** | A message after delivery that is not a plain thank-you reopens the job as a new version, with the previous spec and the client's words in the brief. At most 2 revisions. | Token |
| **Collect** | When the milestone clears, Brain records a CUSTOMER_PAYMENT, with the milestone id as its reference. A non-USD payment is converted at the rate Freelancer published for that currency, and the original amount and rate are kept in the note. | Token, plus ACCEPT_PAYMENT |

**What the screen accepts.** It is a fixed-price job that names a deliverable Brain has proved, with:
- a budget of at least USD 30;
- 60 bids or fewer;
- a description long enough to act on;
- an expected net of at least USD 20 after Freelancer's fee.

The fee is 10% or USD 5, whichever is greater, read from freelancer.com/feesandcharges on 2026-10-19 (`economics.ts FREELANCER_FEE`).

**What the screen rejects.** It rejects any job where any requested part needs work Brain cannot do, and records each reason:
- calls, meetings or presence;
- the client's systems, hosting or credentials;
- academic work for a student;
- video;
- contacting people, sales or lead generation;
- ongoing or hourly work;
- paid data services;
- an existing codebase;
- layout-faithful copies of scans;
- deadlines measured in hours;
- frameworks such as WordPress or PHP;
- mobile apps, CAD or electronics;
- 3D beyond primitive shapes;
- translation;
- content writing;
- anything the client says must not use AI.

It fails toward rejection. A missed job costs a bid. A won job nobody can deliver costs a refund and the account's standing.

**Effects.** A bid is EXTERNAL_RECONCILABLE: after an unknown outcome, Brain asks Freelancer whether this account already bid, and never bids twice. Messages, attachments, award acceptance and milestones are EXTERNAL_OPAQUE: one attempt each, keyed per job and purpose (`delivered-v<n>`, `reply:<message>`), and an unknown outcome is never resent.

**If the work cannot be delivered** — research fails, four bins are refused, or the deadline passes — Brain tells the client it will not ask for payment and marks the job FULFILMENT_FAILED.

**Limits** (`operate.ts LIMITS`, a reviewed constant):
- 5 bids a day;
- 2 jobs at once;
- at most USD 250 a bid;
- 3 replies per job;
- no spending at all.

Execution runs on the fixed-subscription fleet, so the extra cash cost per job is 0.

## Owner setup

1. **Freelancer account** at https://www.freelancer.com/signup.
   - Verify email and phone.
   - Complete the identity verification Freelancer asks for. Withdrawals need it.
   - Fill in the profile: a display name, and a headline such as "Spreadsheets, reports, data cleanup and research".
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

- **Unverified against the live API.** Sending attachments, reading thread files and reading messages are implemented against Freelancer's documented API and tested against a fake. None can be exercised until a token exists.
- **Images a client sends are not read.** If a job needs files and none of them can be read, Brain names the unreadable files to the client and asks for a readable format. The job waits until one arrives, or until its deadline fails it.
- **Client-file jobs are limited** to one at a time until a real one has been delivered.
- **3D is primitive shapes only**: boxes, cylinders, cones, spheres. Organic or detailed modelling is rejected.
- **Graphics are vector compositions.** Photo editing and illustration are rejected.

## Reading it

`cash-report.yml` prints a **MARKETPLACE** section with:
- separate counts: discovered, qualified, bids submitted, awarded, completed and payments collected;
- qualified jobs by category;
- the latest capability proof;
- re-qualifications, client files read, messages, replies and revisions;
- every deliverable version with its checks and files;
- why jobs were rejected;
- the last scan, and whether an account is connected;
- every bid, award, delivery and payment.
