# The post-sale model

CLAUDE.md §53 has the reasoning. This page covers what happens after a buyer agrees:

- which row owns each fact;
- which code writes it and which reads it;
- what the journey looks like when it goes to plan and when it does not;
- what was removed so that only one model survives.

Two branches modelled this independently:

- the **first-dollar journey**: agreements, invoices, the deal's P&L, and learning that feeds ranking;
- PR #124, **fulfillment and refunds**: one obligation, delivered as distinct from accepted, partial delivery, bounded refunds, and supplier costs.

Neither survived whole. Each fact went to the owner whose invariant was stronger, and the losing owner was deleted rather than kept alongside.

## Ownership matrix

"Production" means what `production` already owned before this change. Nothing in that column was duplicated.

| Fact | Canonical owner | Writers | Readers | Where it came from |
|---|---|---|---|---|
| Buyer response (reply, accept, counter, decline, silence, undeliverable) | `cash_observations` | `journey/deal.ts recordObservation` (person); `journey/tick.ts` (only `BUYER_SILENT`, derived) | `position.ts`, `deal.ts recordAgreement`, `learning.ts` | first-dollar; the delivery and supplier kinds were removed (see below) |
| Buyer agreement + its evidence | `cash_agreements` | `deal.ts recordAgreement`, `releaseAgreement` | every post-sale reader | first-dollar (#124 had no agreement row, only a bare `PIPELINE_AGREED`) |
| Agreed amount / currency | the `PIPELINE_AGREED` ledger entry keyed `agreement:<id>`, written **in the same transaction** as the agreement; `PIPELINE_RELEASED` keyed `agreement-released:<id>` | `deal.ts` only. `recordMoneyEvent` refuses either kind unless the key names a real agreement with the same opportunity, amount and currency | `money.ts`, `position.ts`, `invoicing.ts` | first-dollar, hardened (the old guard was a key prefix anyone could type) |
| Deliverable / promise | `cash_agreements.deliverable` | `recordAgreement` | obligation reading, Factory objective, research idea | first-dollar (#124's `cash_fulfillments.promise` copy was removed) |
| Acceptance condition | `cash_agreements.acceptance_condition` (NOT NULL) | `recordAgreement` | obligation reading, Factory objective | first-dollar (#124's nullable copy and its `NO_CONDITION` state were removed) |
| Invoice | `cash_invoices`, with one *live* invoice per agreement (a partial unique index) | `invoicing.ts requestInvoice`, `issueOne`, `paymentPass` | `position.ts`, `record.ts`, view | first-dollar / Money Build 2 (#124 had none). Amount is `min(agreement, still invoiceable)`, so it never bills money already paid |
| Customer payment | ledger `CUSTOMER_PAYMENT` | `recordMoneyEvent` (provider read via `paidInvoiceId`, a person, or a confirmed take-payment effect) | `position.ts`, `money.ts` | production |
| Payment reference | `cash_money_entries.verified_reference`; one reference is one payment | `recordMoney` | refund payload, `record.ts` | production |
| Fulfillment obligation | `cash_fulfillments`, **one per agreement** | `journey/fulfillment.ts declare` | `readObligation`, `position.ts`, `conditions.ts` | #124's derived model, re-keyed to the agreement (first-dollar's stored-state `cash_fulfilments` was removed) |
| Work attempt | `cash_fulfillments.work_ref`, `work_created_at`, `work_attempt` (advanced by the same guarded `UPDATE` that releases failed work) | `createWork` (tick), `retryWork` | `readWork` | #124, with its attempt counter made atomic |
| Work completion | **derived**: the Factory campaign, the Russell mission, or a `WORK_COMPLETE` event (person and supplier only) | — | `readObligation` | #124 |
| Delivery / partial delivery | `cash_fulfillment_events` `DELIVERED`, `PARTIALLY_DELIVERED` | `fulfillment.ts recordEvent` | `readObligation`, `moveToDelivering` | #124 (first-dollar had no partial delivery) |
| Buyer acceptance / rejection | `cash_fulfillment_events` `ACCEPTED`, `REJECTED`, scoped to the obligation | `recordEvent` | `readObligation` | #124 (first-dollar's per-*opportunity* `DELIVERY_ACCEPTED` observation was removed) |
| Failure | `cash_fulfillment_events` `FAILED`, `SUPPLIER_FAILED`, `ABANDONED`; a work failure is derived as `WORK_FAILED` and is retryable | `recordEvent` | `readObligation` | #124 |
| Refund authorization | `cash_fulfillment_events` `REFUND_AUTHORIZED` | `fulfillment.ts authorizeRefund`, under the cash lock | `readRefunds`, `unresolvedRefundCents` | #124 (first-dollar had only a bare ledger entry) |
| Refund attempt | an `idempotency_operations` row in namespace `cash.refund`, correlation `refund:<opp>:<fulfillment>:<key>` | `effects.ts sendRefund` | `answerRefund` | #124, now with the payment references in the payload |
| Refund outcome / confirmation | events `REFUND_CONFIRMED`, `REFUND_UNKNOWN`, `REFUND_FAILED`; the money is a ledger `REFUND` keyed `refund:<fulfillment>:<key>` | `settleRefund`, `answerRefund` (which also closes an `UNCERTAIN` operation) | `readRefunds`, `money.ts` | #124 |
| Supplier liability | ledger `UNPAID_COMMITMENT`, plus `COMMITMENT_RELEASED` when it shrinks before payment | `fulfillment.ts recordCost` | `money.ts`, `position.ts` | #124's ledger route (its duplicate `SUPPLIER_COMMITTED` event was removed); `COMMITMENT_RELEASED` is new |
| Supplier payment | ledger `COMMITMENT_PAID` (the part that closes what was owed) + `COST`, in one transaction | `recordCost` | `money.ts` | #124 |
| Spending authorized against a deal | `cash_commitments` (held under the grant's ceilings) → `COST` on settle | `commitSpend`, `settleSpend` | `position.ts` (held) | production |
| Internal cost | ledger `COST` | `recordCost` (`INTERNAL_COST`), `settleSpend` | `money.ts` | production / #124 |
| Settlement | ledger `SETTLEMENT`, never more than paid net of refunds and earlier settlements | `recordMoneyEvent` (provider read or person) | `position.ts` | production + first-dollar's ceiling |
| Provider fee | ledger `COST` written by the settlement pass | `invoicing.ts paymentPass` | `money.ts` | first-dollar |
| Realized contribution / P&L | **derived**: `money.ts contributionFrom` = payments − refunds − costs − unpaid liabilities | — | `position.ts dealPosition` (per deal), `cashPosition` (project), `record.ts` (reads `dealPosition`) | one formula; #124's reading P&L and the old project formula (which skipped unpaid liabilities) were folded into it |
| Post-sale observations | `cash_outcomes`, each with its `basis` | `learning.ts recordOutcomes` | `cashOutcomeLessons` | first-dollar (#124's `cash_outcome_observations` were removed) |
| Learned lessons | **derived** by `cashOutcomeLessons`; `measuredByMechanism` feeds ranking only past `LESSON_MIN_SAMPLE` contacts **and** finished deals | — | `portfolio.ts rank` (late tie-break) | first-dollar, with the sample floor applied to both sides of the ratio |

## The journey

| Step | What makes it true | Who |
|---|---|---|
| Contact | a `cash_actions` row written from a provider's receipt | Brain, under `CONTACT_BUYER` |
| Buyer response | a `cash_observations` row | the buyer, recorded by a person |
| Agreement | `cash_agreements` + its `PIPELINE_AGREED`, in one transaction | a person, from the buyer's evidence |
| Obligation | `cash_fulfillments`: who performs it (software, research, person, supplier) | a person says who; Brain creates the work |
| Invoice | `cash_invoices`: the agreement's amount less anything already paid | a person drafts; Brain issues under `QUOTE_AND_INVOICE` |
| Payment | `CUSTOMER_PAYMENT`, read from the provider or recorded with a reference | the buyer |
| Work | Factory campaign COMPLETE, research mission DONE with a document, or `WORK_COMPLETE` with evidence | by kind |
| Delivery | `DELIVERED` (all) or `PARTIALLY_DELIVERED` (part) with evidence; the first moves the piece to DELIVERING | a person |
| Acceptance | `ACCEPTED` with the buyer's evidence, after a full delivery | the buyer |
| Settlement | `SETTLEMENT` (+ fee as `COST`) | the provider |
| Collected | `collectable`: every live agreement's obligation is complete, paid net ≥ agreed, nothing billed owed, everything settled | Brain, on the tick (the route asks the same predicate) |
| Contribution | `dealPosition.pnl.contributionCents` | derived |
| Learning | `cash_outcomes`, once per piece of terminal evidence | derived |

## When it does not go to plan

| What happened | What the rows say |
|---|---|
| The buyer disappears before agreeing | `BUYER_SILENT` once per contact. Nothing is learned from the silence until the deal moves on, so a late reply is learned as the reply. |
| The buyer disappears after agreeing | Release the agreement. `PIPELINE_RELEASED` is written in the same transaction, an unsent draft is voided, and a need asks for an issued invoice to be voided at the provider. The obligation reads `RELEASED`. |
| The invoice fails | `FAILED` is history. The agreement can be invoiced again, because only a *live* invoice is unique. |
| The invoice outcome is unknown | `UNCERTAIN`. Brain never resends it; the provider is asked under the same key. |
| The payment fails or is written off | The invoice stays owed until the provider says void or uncollectible. Then it can be billed again for what remains. |
| Partial payment | The deal's payment state reads `PARTIALLY_PAID` (a derived reading, not an invoice state); the rest stays owed and invoiceable. |
| Paid outside an invoice | A person's `CUSTOMER_PAYMENT` against the piece counts as paid, so it is never billed again — on this agreement or the next. A payment that would take net paid above what was agreed is refused, because the likeliest cause is one payment recorded twice. |
| One payment recorded two ways | The provider reads a charge whose reference is already on the ledger: the invoice adopts that entry and moves to `PAID`, rather than writing a second payment. An entry that belongs to another piece holds the invoice with a reason. |
| Released while the invoice was being sent | If the provider confirms the invoice after the agreement was released, it is recorded as `ISSUED` (the money may still arrive) and a need asks for it to be voided at the provider. An unknown outcome is recorded the same way. |
| The work fails | `WORK_FAILED`, derived. **Retry** releases the work and advances `work_attempt` in one statement, then creates attempt N+1. The failed attempt keeps its rows. |
| Partial delivery | `PARTIALLY_DELIVERED`. It never completes the obligation; a full `DELIVERED` is still owed. |
| Rejection | `REJECTED`. The obligation is not complete. A redelivery is a new round with its own key, so an identical redelivery is not swallowed. |
| Recorded failure | Final. Nothing further is recorded except refunds. If the buyer has paid, a need asks what is owed back, and a refund that failed does not answer it. |
| Refund | Authorized against `paid − refunded − unresolved` under the cash lock. Sent once through a usable adapter, or paid out by a person who confirms it with the provider reference. The money route cannot refund an agreed deal. |
| Unknown refund | `REFUND_UNKNOWN`. Never resent, and still counted against what can be refunded. A person's answer resolves the effect operation itself. |
| Supplier cost changes | Up: another `SUPPLIER_COMMITMENT`. Down: `SUPPLIER_COST_REDUCED`, written as `COMMITMENT_RELEASED` and bounded by what is still owed. Each cost counts once. |
| A ledger key Brain composes, sent by a caller | `POST /cash/money` refuses any key beginning with a prefix Brain writes itself (`agreement:`, `refund:`, `invoice-payment:` and the rest), so a hand-entered row can never pre-empt or impersonate one. |
| Restart during any external effect | Every write is idempotent by a key built from server facts. Effects go through `runExternalEffect`, and an unknown is never auto-retried. |

## What was removed

- **First-dollar's `cash_fulfilments`.** It had a stored state machine (`CREATED/PERFORMED/DELIVERED/FAILED/CANCELLED`), matched acceptance per opportunity, and had no partial delivery. Its routes `performed`, `accept-delivery` and `end-fulfilment` went with it.
- **The `DELIVERY_ACCEPTED`, `DELIVERY_REJECTED` and `SUPPLIER_COST_CHANGED` observation kinds.** These facts now belong to the obligation and the ledger.
- **#124's `cash_outcome_observations`, `outcomeLessons` and its `observe` writer.**
- **#124's copies on the obligation:** `promise` and `acceptance_condition` (now the agreement's), the `SUPPLIER_COMMITTED` event (now the ledger's), and the per-opportunity grain.
- **#124's reading P&L** (`money.contributionCents`).
- **The manual `PIPELINE_AGREED` control** on the Cash page, and the bare agreed-amount path through `/cash/money`.

## What separates the sandbox from the first real dollar

`tests/cashFirstDollar.test.ts` and `tests/cashPostSale.test.ts` run the whole
journey. Sandbox adapters sit only at the provider boundary, Brain is restarted
mid-journey, and every effect is counted. What is left is external or human,
with no engineering in it:

1. **The commercial grant.** A person grants `CONTACT_BUYER`,
   `QUOTE_AND_INVOICE` and `ACCEPT_PAYMENT` with ceilings on the Cash page.
2. **A messaging account and a verified sending domain.** Resend, with the
   three deployment secrets in `docs/CASH-PROVIDERS.md`.
3. **A billing account with a verified legal identity and a payout bank
   account.** Stripe, with a live key set and the tax treatment decided per
   invoice. Brain computes no tax.
4. **A legitimate buyer.** A READY opportunity whose published channel names
   exactly one email address.
5. **The buyer's agreement evidence**, recorded by the owner on the piece.
6. **Merging and deploying this to `production`**, which is a person's review
   decision (§28).

## Reading it

- The Cash page, under *Your current work*. Each deal shows its stage, its
  payment state, its money, its obligations, and every next step with its owner:
  Brain, you, or the buyer. Finished deals are listed under *Finished deals*.
- `GET /api/projects/:id/cash` → `myCurrentWork.journey`.
- `npm run report:cash` for the providers.

## What this does not do yet

- **No refund adapter on any deployment.** Stripe's invoicing adapter is read-only for payments. `ISSUE_A_REFUND` reads MISSING, and a person pays refunds out and confirms them.
- **Settlement in a foreign currency, or a refund taken at the provider before payout.** The settlement is refused rather than guessed, and the invoice stays `PAID` with a reason.
- **Partial provider payments.** Only a fully paid invoice is read from the provider; a partial payment is recorded by a person.
- **Learning stays an anecdote below the floor.** No production deal has reached a terminal outcome.
