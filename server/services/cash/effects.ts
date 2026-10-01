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
  // An adapter's own `name` is how it is registered (`getAdapter` looks it up
  // that way); its `namespace` is which operation it serves, which is what
  // this asks about — so the registry is scanned by namespace rather than
  // guessed at by name.
  return listAdapters().find((one) => one.namespace === CONTACT_BUYER_NAMESPACE.name) ?? null;
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
  const adapter = contactBuyerAdapter();
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
    payload: { payer: input.payer, channel: input.channel },
    principalType: 'SYSTEM',
    principalId: PRINCIPAL_ID,
  });
}
