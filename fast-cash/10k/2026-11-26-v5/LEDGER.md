# Ledger design

The implementation and its tests-by-scenario are in `ledger.py`; the output is
`ledger-output.txt`.

## Principles

- **Append-only.** An entry is never edited or deleted. A correction is a new
  entry.
- **Derived, not stored.** Every figure is computed from the entries: revenue,
  refunds, fees, spending, caps, gates, settlement and open obligations.
- **Spending includes processor fees.** Customer receipts never raise the cap,
  and refunds never lower the spending counters.

## Entry

`date, kind, amount ≥ 0, ref, phase, category`

| kind | Sign in net | Notes |
|---|---|---|
| CUSTOMER_PAYMENT | + | category ach / card; ref = order id |
| REFUND | − | the fee is not returned |
| PROCESSOR_FEE | − (spending) | counts toward both caps; before proof, toward the $300 |
| SPEND | − (spending) | phase PRE or POST; category domain / data / api / review / probe / ads; receipt ref |
| PAYOUT | settlement only | cash reaching the bank; not revenue |
| OBLIGATION_OPEN / OBLIGATION_CLOSE | 0 | delivery and the 30-day revision window per order |
| DISPUTE_HOLD *(spec)* | 0 | excludes the payment from gate counts until resolved |

## Invariants (checked on every append; a violating entry is refused)

1. Sum of PRE spending plus fees before proof ≤ $300, over the whole window
   and across every route and attempt.
2. Sum of all spending plus all fees ≤ $2,000.
3. A POST entry is refused before the proof date exists.
4. `net = payments − refunds − fees − spend`, re-derived in every statement.
5. `settled_by(d)` = payouts on or before d, less fees Stripe kept on
   refunded orders. `payments − refunds − fees − settled` = what is still in
   Stripe.

## Gates computed from the ledger

| Gate | Rule |
|---|---|
| **Proof** | ≥ 2 CUSTOMER_PAYMENT entries from ≥ 2 distinct payers by Dec 14, each ≥ $1,250, not refunded or disputed. Sets `proof_at`. |
| **$10k track** | (payments − refunds) by Dec 18 ≥ $5,000. That pace needs a firm count of about 9 paid orders by Dec 22. |
| **Ad release** | Allowed only if spending + $1,000 + projected fulfilment of the orders still needed ≤ $2,000. At a $120 review it never passes at the $10k threshold (ledger T3), so it requires the $40 spot-check scope. |
| **Stop** | No proof by Dec 14 → no POST spending is ever possible. |

## Mapping to Brain

Brain's own ledger is append-only by invariant 37 ("no money figure that is
not derived from an append-only entry"). When this runs inside Brain, each
kind maps to Brain's existing ledger rows for the goal: payments to
SETTLED_CASH on success, and spending to debit entries capped by the goal's
ceilings. Until then, `ledger.py` is the reference implementation and test.
