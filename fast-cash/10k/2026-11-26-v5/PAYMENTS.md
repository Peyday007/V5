# Payment flow specification

This is a specification: no Stripe account exists yet, and nothing here has
been built.

## Who pays what, and when

| Buyer | Price | Instrument | When payment is due | Work starts |
|---|---|---|---|---|
| A firm's **first** referred client | $1,250 | Stripe Invoice (ACH bank debit or card) to the client | On the attorney's written approval of the draft; net 3 days | At intake (we carry the risk) |
| Later referred clients of a firm that has paid once | $1,250 | Stripe Invoice (ACH or card) | At order | On payment |
| Direct applicant (after proof) | $1,650 | Stripe Payment Link (card or ACH) | At order | On payment |

**Rules:**
- No attorney is ever invoiced for a markup or paid anything.
- If an approved invoice is unpaid after 3 days: one reminder, then the
  revision service stops. The amount stays a receivable, not revenue.

## What "collected" means here

A payment counts toward the $10,000 when Stripe marks it succeeded
(`invoice.paid` / `charge.succeeded`), minus any refund. ACH debits stay
"processing" for up to about 4 business days; they count only once they have
succeeded.

## Fees (published Stripe US pricing)

- **Card:** 2.9% + $0.30. On $1,250 that is $36.55; on $1,650, $48.15.
- **ACH Direct Debit:** 0.8%, capped at $5.00.
- **Refunds:** Stripe does not return the original fee.
- **Disputes:** $15 fee if one occurs (not modelled; covered by the cap's
  headroom).

## Settlement

- **First payout:** 7–14 days after the first live payment. The ledger
  assumes 14.
- **After that:** card funds pay out on a rolling basis (~2 business days);
  ACH after the debit settles (~4 business days).
- **Destination:** the owner's bank account connected to Stripe.

## Refund policy (stated on every invoice)

- A full refund if the attorney of record declines to file the final plan,
  in writing with reasons, within 14 days of delivery and after the revision
  rounds.
- No refund for a denial by the consulate or USCIS: we never promise
  approval.
- Because the first order of each firm is paid only on approval, refunds are
  expected mainly on prepaid repeat or direct orders.

## Events to ledger mapping

Each Stripe event becomes one append-only ledger entry (LEDGER.md).

| Stripe event | Ledger entry |
|---|---|
| `invoice.paid` / `payment_intent.succeeded` | CUSTOMER_PAYMENT (category ach/card) |
| the payment's `balance_transaction` | PROCESSOR_FEE (the fee) |
| `charge.refunded` | REFUND (fee not reversed) |
| `payout.paid` | PAYOUT (settlement, not revenue) |
| `charge.dispute.created` | DISPUTE_HOLD (blocks the gate's use of that payment) |

Purchases on the owner's card (domain, data, API, reviewer, ads) are entered
as SPEND, with phase PRE or POST and a receipt reference.

## Setup the owner performs

- Create and verify the account.
- Settings → Payment methods: enable **ACH Direct Debit** and cards.
- Enable **Invoicing**.
- Add the bank account for payouts.
- Save the secret key as the GitHub secret `STRIPE_SECRET_KEY`.

Brain then creates:
- the invoice template, with the refund policy text;
- the $1,650 Payment Link;
- the webhook endpoint for the events above.
