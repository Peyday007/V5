/**
 * External effects, and the four different promises they can honestly be given.
 *
 * The temptation with a file like this is to call everything "idempotent" and
 * move on. That word would be doing four different jobs, three of which it
 * cannot do, and the failure it hides is the expensive kind: an effect that
 * happened twice because a timeout was read as "it did not happen".
 *
 * A timeout is not evidence. A connection reset after the request was written
 * is not evidence. An error response from a provider that already accepted the
 * work is not evidence. The only evidence is a receipt, or the provider's own
 * answer when asked.
 *
 * So an adapter must declare which of these it is:
 *
 *   EXTERNAL_IDEMPOTENT     The provider takes a key and de-duplicates on it.
 *                           One stable key across every retry and attempt, and
 *                           a repeat returns the original receipt. This is the
 *                           only class where "retry freely" is true.
 *
 *   EXTERNAL_RECONCILABLE   No key, but the provider can be asked what it
 *                           already did. After an ambiguous send we ask,
 *                           and attach the answer instead of resending.
 *
 *   EXTERNAL_OPAQUE         Neither. One automated attempt. If the outcome is
 *                           unknown it stays unknown, the operation stops at
 *                           UNCERTAIN, and a person decides. Nothing here will
 *                           ever resend it automatically, and that is the
 *                           feature rather than a limitation.
 *
 * Step 6 connects no provider. These contracts exist so that Step 8's worker
 * and anything after it has to state which class it belongs to before it can
 * perform an effect at all.
 */
import crypto from 'node:crypto';
import type { EffectClass, EffectFailureCategory } from '../../domain/types.ts';

/** What came back, classified — never the raw provider response. */
export type SendOutcome =
  | {
      kind: 'CONFIRMED';
      /** The provider's own identifier for what it did. */
      receiptRef: string;
      /** Safe metadata only: ids and classifications, never headers or bodies. */
      receiptMeta?: Record<string, unknown>;
    }
  | {
      kind: 'REJECTED';
      category: EffectFailureCategory;
      /** True when the provider definitely did nothing and a retry is safe. */
      retryable: boolean;
      detail?: string;
    }
  | {
      /**
       * The send left, and what happened to it is unknown.
       *
       * This is not a failure. Reporting it as one is the bug this whole file
       * exists to prevent.
       */
      kind: 'UNCERTAIN';
      reason: string;
    };

/** What the provider says it already did, when it can be asked. */
export type ReconcileOutcome =
  | { kind: 'FOUND'; receiptRef: string; receiptMeta?: Record<string, unknown> }
  | { kind: 'ABSENT' }
  | { kind: 'INCONCLUSIVE'; reason: string };

export interface EffectRequest {
  /** The stable provider key. Absent for classes that cannot use one. */
  providerKey: string | null;
  /** The business identity of the intended effect, for reconciliation. */
  businessId: string;
  payload: Record<string, unknown>;
}

export interface EffectAdapter {
  name: string;
  effectClass: EffectClass;
  /** Which operation namespace this adapter serves. */
  namespace: string;

  /**
   * The provider's key format, when it has one.
   *
   * `maxLength` matters: a provider that silently truncates keys de-duplicates
   * on a prefix, which is a different guarantee from the one it advertises.
   */
  providerKeyLimit?: number;

  /** Reject anything that is not a valid request for this effect, before sending. */
  validate(payload: unknown): Record<string, unknown>;

  /** Which fields of the payload are part of the operation's identity. */
  fingerprintInputs(payload: Record<string, unknown>): unknown;

  send(request: EffectRequest): Promise<SendOutcome>;

  /** Present iff the class is EXTERNAL_RECONCILABLE. */
  reconcile?(businessId: string): Promise<ReconcileOutcome>;

  /** Strip anything unsafe before a receipt is stored. */
  redactReceipt?(meta: Record<string, unknown>): Record<string, unknown>;
}

export class AdapterContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterContractError';
  }
}

/**
 * Refuse an adapter whose declaration does not match its shape.
 *
 * A class of `EXTERNAL_RECONCILABLE` with no `reconcile` is a promise the
 * engine would make on its behalf and be unable to keep — better refused at
 * registration than discovered during an incident.
 */
export function assertAdapterContract(adapter: EffectAdapter): EffectAdapter {
  if (adapter.effectClass === 'EXTERNAL_RECONCILABLE' && !adapter.reconcile) {
    throw new AdapterContractError(
      `${adapter.name} declares itself reconcilable but provides no way to reconcile.`,
    );
  }
  if (adapter.effectClass === 'EXTERNAL_OPAQUE' && adapter.reconcile) {
    throw new AdapterContractError(
      `${adapter.name} declares itself opaque but provides a reconcile method. ` +
        'If it can be reconciled, it is not opaque.',
    );
  }
  if (adapter.effectClass === 'EXTERNAL_IDEMPOTENT' && !adapter.providerKeyLimit) {
    throw new AdapterContractError(
      `${adapter.name} claims native idempotency but does not state its key limit. ` +
        'A provider that truncates keys de-duplicates on a prefix.',
    );
  }
  if (!adapter.effectClass.startsWith('EXTERNAL_')) {
    throw new AdapterContractError(`${adapter.name} is not an external effect adapter.`);
  }
  return adapter;
}

/**
 * The key the provider sees.
 *
 * Derived from the logical effect identity — the operation, which is stable —
 * and never from the attempt, the lease, the fencing generation, the worker or
 * the request. Every one of those differs on the retry, and a provider key that
 * differs on the retry de-duplicates nothing at all. That is the single most
 * common way a system with idempotency keys still double-charges.
 */
export function deriveProviderKey(input: {
  adapter: EffectAdapter;
  operationId: string;
  businessId: string;
}): string | null {
  if (input.adapter.effectClass !== 'EXTERNAL_IDEMPOTENT') return null;
  const digest = crypto
    .createHash('sha256')
    .update(`pk:v1:${input.adapter.name}:${input.operationId}:${input.businessId}`, 'utf8')
    .digest('hex');
  const limit = input.adapter.providerKeyLimit ?? 64;
  return digest.slice(0, Math.max(16, Math.min(limit, digest.length)));
}

/* ------------------------------------------------------------------------- */
/* Registry                                                                   */
/* ------------------------------------------------------------------------- */

const ADAPTERS = new Map<string, EffectAdapter>();

export function registerAdapter(adapter: EffectAdapter): void {
  ADAPTERS.set(adapter.name, assertAdapterContract(adapter));
}

export function getAdapter(name: string): EffectAdapter | null {
  return ADAPTERS.get(name) ?? null;
}

export function listAdapters(): EffectAdapter[] {
  return [...ADAPTERS.values()];
}

/** For tests, which register throwaway adapters and must not leak them. */
export function clearAdapters(): void {
  ADAPTERS.clear();
}
