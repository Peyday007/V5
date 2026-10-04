/**
 * Reaching a buyer, through the machinery invariants 25 and 26 actually require.
 *
 * `advanceWithinAuthority` used to treat `SEND_A_MESSAGE` reading `PRESENT` as
 * permission to write a `cash_actions` row saying Brain had reached the payer —
 * with no message sent and no call into `server/services/effects`. §30 says
 * this version does not itself contact a buyer; the moment an integration made
 * the capability read `PRESENT`, that sentence would have become false while
 * every row still read healthy.
 *
 * So `PRESENT` is redefined to mean "a real effect adapter is registered for
 * this operation" (`capabilities.ts`), and this module is the one place that
 * operation is actually performed. It is `runExternalEffect` and nothing
 * beside it: no second way to send, no claim recorded ahead of a receipt.
 *
 *   CONFIRMED / RECONCILED / REPLAYED   The provider's own answer. The caller
 *                                       may record the action, carrying the
 *                                       receipt as its reference.
 *   UNCERTAIN                           The send left and what happened to it
 *                                       is unknown. No action is recorded, no
 *                                       execution begins, and the caller must
 *                                       not resend against the same attempt —
 *                                       which `runExternalEffect` already
 *                                       refuses to do on its own.
 *   FAILED                              The provider is authoritative that
 *                                       nothing happened. No action, no
 *                                       execution.
 */
import { listAdapters, type EffectAdapter } from '../effects/adapter.ts';
import { runExternalEffect, type ExternalOutcome } from '../effects/external.ts';
import type { OperationNamespace } from '../effects/engine.ts';

/**
 * The operation this Brain performs when it reaches a buyer on its own
 * account.
 *
 * `PROJECT` scope rather than `PRINCIPAL`: Brain is the only caller, and the
 * business identity — the opportunity, the action and which occurrence this
 * is — is already unique within the project, so two calls for the same
 * attempt are one intent to join rather than two to keep apart.
 */
export const CONTACT_BUYER_NAMESPACE: OperationNamespace = {
  name: 'cash.contact_buyer',
  version: 1,
  principalScope: 'PROJECT',
  retention: 'PERMANENT',
};

/** Brain acting on its own account, never a person and never a worker. */
const PRINCIPAL_ID = 'cash-contact-buyer';

/**
 * The adapter registered for this operation, or none.
 *
 * An adapter declares which operation namespace it serves; this is the one
 * place that declaration is read back, so `capabilities.ts` and this module
 * cannot disagree about whether a real integration exists.
 */
export function contactBuyerAdapter(): EffectAdapter | null {
  return adapterFor(CONTACT_BUYER_NAMESPACE);
}

/**
 * The adapter registered for an operation, or none.
 *
 * An adapter's own `name` is how it is registered (`getAdapter` looks it up
 * that way); its `namespace` is which operation it serves, which is what this
 * asks about — so the registry is scanned by namespace rather than guessed at
 * by name.
 */
function adapterFor(namespace: OperationNamespace): EffectAdapter | null {
  return listAdapters().find((one) => one.namespace === namespace.name) ?? null;
}

/**
 * Whether an operation can actually be performed now: an adapter is
 * registered for it **and** that adapter's own configuration reads usable.
 *
 * Both halves, because registration says which provider was chosen and
 * `health` says whether its key and settings are present *now* — a deployment
 * whose secret was removed still has the adapter registered, and must not read
 * as able to send. A test double with no `health` is usable by being
 * registered, which is the only kind of adapter that lacks one.
 */
export function usableAdapter(namespace: OperationNamespace): EffectAdapter | null {
  const adapter = adapterFor(namespace);
  if (!adapter) return null;
  if (adapter.health && !adapter.health().usable) return null;
  return adapter;
}

/** Why an operation is or is not usable, in words that name no secret. */
export function adapterStatus(namespace: OperationNamespace): {
  adapter: string | null;
  usable: boolean;
  reason: string;
} {
  const adapter = adapterFor(namespace);
  if (!adapter) {
    return { adapter: null, usable: false, reason: 'No provider adapter is registered for this.' };
  }
  const health = adapter.health ? adapter.health() : { usable: true, reason: 'registered' };
  return { adapter: adapter.name, usable: health.usable, reason: health.reason };
}

/**
 * The idempotency key for one contact attempt, built from server facts only.
 *
 * An idempotency key may hold only letters, digits and `. _ ~ -`
 * (`assertValidKey`), which `cash_actions.request_key`'s colon-separated form
 * (`actionKey`) does not satisfy — the two keys answer different questions and
 * are built differently on purpose. Stable across a retry of the same
 * unresolved attempt: the occurrence is how many actions already exist for
 * this opportunity, and nothing is recorded there until the provider has
 * answered, so the same key finds the same reservation instead of starting a
 * second one.
 */
export function contactBuyerKey(opportunityId: string, occurrence: string): string {
  return `contact-buyer.${opportunityId}.${occurrence}`;
}

export interface ContactBuyerRequest {
  /** The stable idempotency key for this attempt. See `contactBuyerKey`. */
  key: string;
  projectId: string;
  opportunityId: string;
  payer: string;
  channel: string;
  /**
   * The message, composed from the card by `outreach.ts` — never by the
   * adapter, and never by a model. One address, read from the channel the
   * buyer published.
   */
  message: { to: string; subject: string; text: string };
}

/**
 * Actually try to reach the buyer, and report what the provider says happened.
 *
 * Throws only when no adapter is registered — which `capabilities.ts` is
 * responsible for refusing before this is ever called, so reaching this throw
 * means the two disagreed about what "present" means, and that is a defect to
 * surface rather than a withheld capability to report.
 */
export async function sendContactBuyer(input: ContactBuyerRequest): Promise<ExternalOutcome> {
  const adapter = usableAdapter(CONTACT_BUYER_NAMESPACE);
  if (!adapter) {
    throw new Error(
      `No effect adapter is registered for "${CONTACT_BUYER_NAMESPACE.name}", so ` +
        'SEND_A_MESSAGE should not have read PRESENT.',
    );
  }
  return await runExternalEffect({
    adapter,
    namespace: CONTACT_BUYER_NAMESPACE,
    projectId: input.projectId,
    key: input.key,
    businessId: input.opportunityId,
    payload: {
      requestKey: input.key,
      payer: input.payer,
      channel: input.channel,
      to: input.message.to,
      subject: input.message.subject,
      text: input.message.text,
    },
    principalType: 'SYSTEM',
    principalId: PRINCIPAL_ID,
  });
}

/* ------------------------------------------------------------------------- */
/* Issuing an invoice                                                         */
/* ------------------------------------------------------------------------- */

/**
 * The operation of issuing one invoice for one agreed amount.
 *
 * Its business identity is Brain's own `cash_invoices` row id, which exists
 * before anything is sent and is the one value the provider can be asked about
 * afterwards (`metadata[brain_invoice]`). That is what makes the adapter
 * reconcilable rather than opaque.
 */
export const ISSUE_INVOICE_NAMESPACE: OperationNamespace = {
  name: 'cash.issue_invoice',
  version: 1,
  principalScope: 'PROJECT',
  retention: 'PERMANENT',
};

export function issueInvoiceKey(invoiceId: string): string {
  return `issue-invoice.${invoiceId}`;
}

export interface IssueInvoiceRequest {
  projectId: string;
  invoiceId: string;
  amountCents: number;
  currency: string;
  customerEmail: string;
  customerName: string;
  taxTreatment: string;
  dueDate: string;
  description: string;
}

export async function sendIssueInvoice(input: IssueInvoiceRequest): Promise<ExternalOutcome> {
  const adapter = usableAdapter(ISSUE_INVOICE_NAMESPACE);
  if (!adapter) {
    throw new Error(
      `No usable effect adapter is registered for "${ISSUE_INVOICE_NAMESPACE.name}", so ` +
        'ISSUE_AN_INVOICE should not have read PRESENT.',
    );
  }
  return await runExternalEffect({
    adapter,
    namespace: ISSUE_INVOICE_NAMESPACE,
    projectId: input.projectId,
    // One invoice row is one invoice, for ever: the key is the row.
    key: issueInvoiceKey(input.invoiceId),
    businessId: input.invoiceId,
    payload: {
      amountCents: input.amountCents,
      currency: input.currency,
      customerEmail: input.customerEmail,
      customerName: input.customerName,
      taxTreatment: input.taxTreatment,
      dueDate: input.dueDate,
      description: input.description,
    },
    principalType: 'SYSTEM',
    principalId: 'cash-issue-invoice',
  });
}
