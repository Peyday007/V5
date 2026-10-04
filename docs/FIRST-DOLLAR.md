# The first-dollar journey

CLAUDE.md §53 is the reasoning. This is how one opportunity travels from
discovery to collected, fulfilled, reconciled revenue, which row says each
step happened, and what still separates the sandbox from real money.

## The journey, and what makes each step true

| Step | What makes it true (a row, never a button) | Who does it |
|---|---|---|
| Discover → qualify → READY | The tier and the card (`tier.ts`, `card.ts`), answered by research (Money Build 3). | Brain |
| Contact | A `cash_actions` row written only from a messaging provider's receipt. The payload carries the exact message and its version (`offer-<sha256>`) and the effect key as the provider's Idempotency-Key. At most three buyers per pass. | Brain, under `CONTACT_BUYER` |
| Buyer response | A `cash_observations` row: a closed kind, a source and a reference somebody can check. `BUYER_SILENT` is derived by the tick after seven days, never typed. | The buyer (recorded by a person or a provider) |
| Agreement | A `cash_agreements` row with amount, deliverable, acceptance condition and evidence (signed agreement, written acceptance, purchase order or provider record). It writes the one `PIPELINE_AGREED` entry itself. A bare agreed amount is refused. | A person, from the buyer's evidence |
| Invoice | A `cash_invoices` row (Money Build 2) drafted with the terms only a person holds (who is billed, tax treatment, due date). The amount is the agreement's. Issued once, under `issueInvoiceKey(row)`, whether by the tick or a press. | A person drafts it; Brain issues it, under `QUOTE_AND_INVOICE` |
| Payment | `CUSTOMER_PAYMENT`, from the provider saying the invoice was paid, or recorded by a person with a reference. One reference is one payment. Pending is never cash. | The buyer; Brain reads it |
| Fulfilment | A `cash_fulfilments` row naming the work in the machinery that does it: a Russell idea, a Factory change request, a cash job, a supplier commitment, or work outside Brain. `PERFORMED` is read from Brain's own rows (a mission `DONE`, a campaign `COMPLETE`). Work done outside Brain needs recorded evidence. `DELIVERED` needs the buyer's `DELIVERY_ACCEPTED`. The first fulfilment moves the piece to `DELIVERING`. | Brain or a person, by path; the buyer accepts |
| Settlement | `SETTLEMENT`, from the provider saying the funds are available (plus the fee as `COST`), or recorded with a payout reference. It can never exceed what was paid. | The provider; Brain reads it |
| Collected | Derived on the tick when every live agreement is paid, nothing billed is owed, the payment has settled and the work was accepted (`collectable`). The same predicate guards the *Money is in* route. | Brain |
| P&L | `dealPosition`: agreed, invoiced, paid, refunds, settled, unsettled, costs, owed commitments, held commitments, contribution, owed by the buyer, still invoiceable. Every figure comes from the ledger, and each cost counts once. | Derived |
| Learning | `cash_outcomes`: contact result, offered and accepted price, time to agreement, fulfilment duration, actual cost, refund, realized contribution, failure reason. Each row carries its basis. Lessons are grouped by mechanism and channel with the sample shown. Below three contacts a lesson is labelled an anecdote. Ranking uses it only as a late tie-break past that floor. | Derived |

## When it does not go to plan

| What happened | What the rows say |
|---|---|
| The buyer never answers | `BUYER_SILENT`, once per contact. The next step is the owner's: follow up or let it go. |
| The contact bounces or is refused | Nothing is recorded as done. The piece stays READY and a need keeps the provider's reason. |
| The buyer goes quiet after agreeing | *Release* the agreement. That writes `PIPELINE_RELEASED`, voids an unsent draft, and raises a need to void an issued invoice at the provider. |
| The payment fails or is written off | The invoice stays `ISSUED` (owed) until the provider says `void`/`uncollectible`, then the agreement is invoiceable again. |
| The provider's outcome is unknown | `UNCERTAIN`, never resent. The provider is asked under the same key, and a person can settle it from the page. |
| Partial delivery | Release the whole agreement, then record a new one for the part. No row is edited. |
| Refund | `REFUND`, never more than was paid. A refunded deal is not collectable. |
| The work fails or is rejected | The fulfilment is `FAILED` with its reason. A new fulfilment is a new row. |
| A supplier's cost changes | `SUPPLIER_COST_CHANGED` is recorded. Spending more than was held needs a second commitment, and each cost is counted once. |

## What separates the sandbox from the first real dollar

The acceptance (`tests/cashFirstDollar.test.ts`) runs the whole journey with
sandbox adapters only at the provider boundary, restarts Brain twice, and
counts every effect. What is left is external or human, with no engineering
in it:

1. **The commercial grant.** A person grants `CONTACT_BUYER`,
   `QUOTE_AND_INVOICE` and `ACCEPT_PAYMENT` with ceilings on the Cash page.
2. **A messaging account and a verified sending domain.** Resend, with the
   three deployment secrets in `docs/CASH-PROVIDERS.md`. The domain should be
   one the owner may lawfully send commercial email from.
3. **A billing account with a verified legal identity and a payout bank
   account.** Stripe, with the business verified, a live key set, and the
   tax treatment decided per invoice. Brain computes no tax.
4. **A legitimate buyer.** A READY opportunity whose published channel names
   exactly one email address, from a buyer who can lawfully be contacted.
5. **The buyer's agreement evidence**, recorded by the owner on the piece.
6. **Merging and deploying this train to `production`.** That is a person's
   review decision (§28).

## Reading it

- The Cash page, under *Your current work*. For each deal it shows the stage,
  the payment state, the money, and every next step with its owner: Brain,
  you, or the buyer.
- `GET /api/projects/:id/cash` → `myCurrentWork.journey`.
- `npm run report:cash` for the providers.
