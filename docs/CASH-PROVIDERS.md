# Commercial providers: messaging, invoices, payments

CLAUDE.md §53 is the reasoning. This is the setup.

## What each one does

| Area | Capability | Provider | What Brain does once connected |
|---|---|---|---|
| Messaging | `SEND_A_MESSAGE` | Resend | Writes one email to the single address a READY opportunity's buyer published, with the card's offer, price and an opt-out. Only under `CONTACT_BUYER` authority, at most three per tick. |
| Invoices | `ISSUE_AN_INVOICE` | Stripe | Issues and sends an invoice a person requested, for the amount recorded as `PIPELINE_AGREED`. Only under `QUOTE_AND_INVOICE` authority. |
| Payments | `TAKE_A_PAYMENT` | Stripe | The invoice's hosted page takes the payment. Brain reads Stripe and records `CUSTOMER_PAYMENT` when paid (under `ACCEPT_PAYMENT`) and `SETTLEMENT` + the fee as `COST` when the funds are available. |

## Status

```
npm run report:cash                # COMMERCIAL PROVIDERS: CONNECTED / MISSING + next action
npm run report:cash -- --probe     # also asks each provider whether it accepts the key (sends nothing)
GET /api/projects/:id/cash/providers
```

## Connecting — the owner's decisions

1. **Messaging.** Create a Resend account, verify the sending domain, create an
   API key (a sending-only key is enough), then on the deployment:

   ```
   flyctl secrets set BRAIN_MESSAGING_PROVIDER=resend \
     RESEND_API_KEY=re_... \
     BRAIN_MESSAGING_FROM='Your Name <you@your-verified-domain>'
   ```

2. **Invoices and payments.** Create a Stripe account. Start with the **test**
   key; switch to the live key only after a test invoice has gone through
   paid → settled in `cash-report`:

   ```
   flyctl secrets set BRAIN_BILLING_PROVIDER=stripe STRIPE_SECRET_KEY=sk_test_...
   ```

   A restricted key (`rk_...`) needs write access to Customers, Invoices and
   Invoice Items, and read access to Charges and Balance Transactions.

3. **Authority.** The standing commercial authority on the project must allow
   `CONTACT_BUYER`, `QUOTE_AND_INVOICE` and `ACCEPT_PAYMENT` respectively. A
   connected provider without the authority does nothing.

Setting a secret restarts the machine, which is what registers the provider.
Removing one makes the capability read MISSING on the next tick.

## Requesting an invoice

```
POST /api/projects/:projectId/cash/opportunities/:opportunityId/invoice
{ "customerName": "...", "customerEmail": "...",
  "taxTreatment": "NO_TAX_CHARGED" | "TAX_EXEMPT" | "REVERSE_CHARGE",
  "dueDate": "YYYY-MM-DD", "pipelineEntryId": "cme_... (only if several are agreed)" }
```

The amount and currency come from the `PIPELINE_AGREED` entry. An invoice that
must charge tax is issued outside Brain — Brain does not compute tax.

## When the outcome is unknown

- **Email**: a timeout or a 5xx leaves the send UNCERTAIN with an open need.
  Brain never resends it. Check Resend's dashboard and record what happened.
- **Invoice**: Brain searches Stripe for `metadata['brain_invoice']` on every
  tick and records the invoice when Stripe shows it. It never creates a second.

## Not built in this version

No inbound email reading (a buyer's "no thanks" is recorded by a person), no
webhooks (payment state is read on the tick, at most every five minutes per
invoice), no tax calculation, no refunds, and no provider other than Resend and
Stripe.
