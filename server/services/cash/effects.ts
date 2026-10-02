/**
 * Performing a commercial action, through the machinery invariants 25 and 26
 * actually require.
 *
 * `advanceWithinAuthority` used to treat `SEND_A_MESSAGE` reading `PRESENT` as
 * permission to write a `cash_actions` row saying Brain had reached the payer —
 * with no message sent and no call into `server/services/effects`. §30 says
 * this version does not itself contact a buyer; the moment an integration made
 * the capability read `PRESENT`, that sentence would have become false while
 * every row still read healthy.
 *
 * So `PRESENT` means "a real effect adapter is registered for this operation"
 * (`capabilities.ts`), and this module is the one place such an operation is
 * actually performed. It is `runExternalEffect` and nothing beside it: no
 * second way to send, no claim recorded ahead of a receipt.
 *
 *   CONFIRMED / RECONCILED / REPLAYED   The provider's own answer. The caller
 *                                       may record the action, carrying the
 *                                       receipt as its reference.
 *   UNCERTAIN                           The send left and what happened to it
 *                                       is unknown. No action is recorded, and
 *                                       the caller must not resend against the
 *                                       same attempt — which `runExternalEffect`
 *                                       already refuses to do on its own. A
 *                                       person settles it (`resolve.ts`).
 *   FAILED                              The provider is authoritative that
 *                                       nothing happened. No action.
 *
 * ---------------------------------------------------------------------------
 * Three actions, one shape
 * ---------------------------------------------------------------------------
 *
 * Reaching a buyer was the only commercial action Brain could ever perform,
 * so issuing an invoice and taking a payment read `MISSING` with `read: null`
 * — there was nothing they *could* read. They have the identical contract
 * now: an operation namespace, the capability it makes `PRESENT`, and a
 * payload boundary an adapter validates. No adapter for either is registered
 * on any deployment of this Brain, so both still read `MISSING`; what changed
 * is that registering a real integration is the whole of what it would take,
 * rather than a code change somebody has to remember to make.
 *
 * ---------------------------------------------------------------------------
 * Which opportunity an operation was for
 * ---------------------------------------------------------------------------
 *
 * An operation's key is stored only as a digest, so it cannot be read back to
 * learn which opportunity and which occurrence it was performed for. That made
 * an UNCERTAIN contact a row nothing on the Cash page could find: the only way
 * to settle it was the console-only `/operations/:id/resolve` with an id
 * somebody assembled by hand. So every commercial operation carries a
 * correlation id Brain composes — `cash:<opportunity>:<action>:<occurrence>`
 * — from the same server facts as its key, and `commercialOperationsFor` reads
 * it back. It identifies; it never authorizes: the opportunity is re-read and
 * re-authorized by whoever acts on it.
 */
import { listAdapters, type EffectAdapter } from '../effects/adapter.ts';
import { runExternalEffect, type ExternalOutcome } from '../effects/external.ts';
import type { OperationNamespace } from '../effects/engine.ts';
import { operationsByCorrelation } from '../../repos/idempotency.ts';
import type { IdempotencyOperation } from '../../domain/types.ts';

/** The commercial actions Brain can be connected to perform itself. */
export const PERFORMABLE_ACTIONS = ['CONTACT_BUYER', 'QUOTE_AND_INVOICE', 'ACCEPT_PAYMENT'] as const;
export type PerformableAction = (typeof PERFORMABLE_ACTIONS)[number];

export interface CommercialEffect {
  action: PerformableAction;
  namespace: OperationNamespace;
  /** The capability a registered adapter for this namespace makes `PRESENT`. */
  capability: string;
  /** What it is, in the words a person reads on the page. */
  doing: string;
}

/**
 * `PROJECT` scope rather than `PRINCIPAL` for every one of them: Brain is the
 * only caller, and the business identity — the opportunity, the action and
 * which occurrence this is — is already unique within the project, so two
 * calls for the same attempt are one intent to join rather than two to keep
 * apart.
 */
export const COMMERCIAL_EFFECTS: Readonly<Record<PerformableAction, CommercialEffect>> =
  Object.freeze({
    CONTACT_BUYER: {
      action: 'CONTACT_BUYER',
      namespace: {
        name: 'cash.contact_buyer',
        version: 1,
        principalScope: 'PROJECT',
        retention: 'PERMANENT',
      },
      capability: 'SEND_A_MESSAGE',
      doing: 'reaching the buyer',
    },
    QUOTE_AND_INVOICE: {
      action: 'QUOTE_AND_INVOICE',
      namespace: {
        name: 'cash.issue_invoice',
        version: 1,
        principalScope: 'PROJECT',
        retention: 'PERMANENT',
      },
      capability: 'ISSUE_AN_INVOICE',
      doing: 'issuing the invoice',
    },
    ACCEPT_PAYMENT: {
      action: 'ACCEPT_PAYMENT',
      namespace: {
        name: 'cash.take_payment',
        version: 1,
        principalScope: 'PROJECT',
        retention: 'PERMANENT',
      },
      capability: 'TAKE_A_PAYMENT',
      doing: 'taking the payment',
    },
  });

/** Kept by name: the first of the three, and what existing callers import. */
export const CONTACT_BUYER_NAMESPACE: OperationNamespace = COMMERCIAL_EFFECTS.CONTACT_BUYER.namespace;

const NAMESPACES = PERFORMABLE_ACTIONS.map((one) => COMMERCIAL_EFFECTS[one].namespace.name);

export function isPerformable(action: string): action is PerformableAction {
  return (PERFORMABLE_ACTIONS as readonly string[]).includes(action);
}

/** Brain acting on its own account, never a person and never a worker. */
function principalIdFor(action: PerformableAction): string {
  // The contact's principal is unchanged from before this module served three
  // actions, so an operation already reserved under it is still found.
  return action === 'CONTACT_BUYER' ? 'cash-contact-buyer' : `cash-${action.toLowerCase()}`;
}

/**
 * The adapter registered for this action's operation, or none.
 *
 * An adapter declares which operation namespace it serves; this is the one
 * place that declaration is read back, so `capabilities.ts` and this module
 * cannot disagree about whether a real integration exists.
 */
export function adapterFor(action: PerformableAction): EffectAdapter | null {
  const name = COMMERCIAL_EFFECTS[action].namespace.name;
  return listAdapters().find((one) => one.namespace === name) ?? null;
}

export function contactBuyerAdapter(): EffectAdapter | null {
  return adapterFor('CONTACT_BUYER');
}

/**
 * The idempotency key for one attempt, built from server facts only.
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
export function commercialEffectKey(
  action: PerformableAction,
  opportunityId: string,
  occurrence: string,
  retry = 0,
): string {
  const stem = action === 'CONTACT_BUYER' ? 'contact-buyer' : action.toLowerCase().replace(/_/g, '-');
  // A retry is a new key only after a person established that the earlier
  // attempt did not happen (`resolve`), so it is never a resend of an unknown.
  return `${stem}.${opportunityId}.${occurrence}${retry > 0 ? `.${retry}` : ''}`;
}

export function contactBuyerKey(opportunityId: string, occurrence: string): string {
  return commercialEffectKey('CONTACT_BUYER', opportunityId, occurrence);
}

/** See the module header: identifies, never authorizes. */
export function effectCorrelation(
  opportunityId: string,
  action: PerformableAction,
  occurrence: string,
  retry = 0,
): string {
  return `cash:${opportunityId}:${action}:${occurrence}${retry > 0 ? `:${retry}` : ''}`;
}

export interface CommercialOperation {
  operation: IdempotencyOperation;
  opportunityId: string;
  action: PerformableAction;
  occurrence: string;
  /** Zero for the first attempt at this occurrence. */
  retry: number;
}

function parseCorrelation(value: string | null): Omit<CommercialOperation, 'operation'> | null {
  if (!value) return null;
  const parts = value.split(':');
  if ((parts.length !== 4 && parts.length !== 5) || parts[0] !== 'cash') return null;
  const [, opportunityId, action, occurrence, retryText] = parts as [
    string,
    string,
    string,
    string,
    string | undefined,
  ];
  if (!isPerformable(action) || !opportunityId || !occurrence) return null;
  const retry = retryText === undefined ? 0 : Number(retryText);
  if (!Number.isInteger(retry) || retry < 0) return null;
  return { opportunityId, action, occurrence, retry };
}

/**
 * Every commercial operation Brain has performed for one opportunity, newest
 * first, with what each was for read back from its correlation.
 */
export async function commercialOperationsFor(
  projectId: string,
  opportunityId: string,
): Promise<CommercialOperation[]> {
  const rows = await operationsByCorrelation({
    projectId,
    namespaces: NAMESPACES,
    correlationPrefix: `cash:${opportunityId}:`,
  });
  const out: CommercialOperation[] = [];
  for (const operation of rows) {
    const parsed = parseCorrelation(operation.correlationId);
    if (!parsed || parsed.opportunityId !== opportunityId) continue;
    out.push({ operation, ...parsed });
  }
  return out;
}

export interface CommercialEffectRequest {
  action: PerformableAction;
  projectId: string;
  opportunityId: string;
  /** Which occurrence this is: actions on the record for this piece, plus one. */
  occurrence: string;
  /** How many earlier attempts at this occurrence a person closed as not having happened. */
  retry?: number;
  /** What the adapter is handed. Its own `validate` decides what is a request. */
  payload: Record<string, unknown>;
}

/**
 * Actually perform the action, and report what the provider says happened.
 *
 * Throws only when no adapter is registered — which `capabilities.ts` is
 * responsible for refusing before this is ever called, so reaching this throw
 * means the two disagreed about what "present" means, and that is a defect to
 * surface rather than a withheld capability to report.
 */
export async function sendCommercialEffect(input: CommercialEffectRequest): Promise<ExternalOutcome> {
  const effect = COMMERCIAL_EFFECTS[input.action];
  const adapter = adapterFor(input.action);
  if (!adapter) {
    throw new Error(
      `No effect adapter is registered for "${effect.namespace.name}", so ` +
        `${effect.capability} should not have read PRESENT.`,
    );
  }
  return await runExternalEffect({
    adapter,
    namespace: effect.namespace,
    projectId: input.projectId,
    key: commercialEffectKey(input.action, input.opportunityId, input.occurrence, input.retry ?? 0),
    businessId: input.opportunityId,
    payload: input.payload,
    principalType: 'SYSTEM',
    principalId: principalIdFor(input.action),
    correlationId: effectCorrelation(
      input.opportunityId,
      input.action,
      input.occurrence,
      input.retry ?? 0,
    ),
  });
}

/** The receipt an outcome carries, or null when it carries none. */
export function receiptOf(outcome: ExternalOutcome): string | null {
  switch (outcome.status) {
    case 'CONFIRMED':
    case 'RECONCILED':
      return outcome.receiptRef;
    case 'REPLAYED':
      return outcome.operation.resultRef ?? outcome.operation.id;
    default:
      return null;
  }
}

export interface ContactBuyerRequest {
  /** The occurrence this attempt is for. See `commercialEffectKey`. */
  occurrence: string;
  projectId: string;
  opportunityId: string;
  payer: string;
  channel: string;
}

/** Reaching the buyer, kept as its own entry point for the tick. */
export async function sendContactBuyer(input: ContactBuyerRequest): Promise<ExternalOutcome> {
  return await sendCommercialEffect({
    action: 'CONTACT_BUYER',
    projectId: input.projectId,
    opportunityId: input.opportunityId,
    occurrence: input.occurrence,
    payload: { payer: input.payer, channel: input.channel },
  });
}
