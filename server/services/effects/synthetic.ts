/**
 * Synthetic providers, for proving the contracts without connecting one.
 *
 * These exist because the interesting behaviour of an external effect is what
 * happens when it goes wrong in a specific way at a specific moment, and no
 * real provider can be asked to lose a response on cue. Each adapter here can
 * be told exactly how to misbehave.
 *
 * **They are not reachable from any route.** Nothing registers them at boot,
 * and no HTTP surface can select an adapter by name. They are registered by
 * tests, and by the hosted verification script, which runs inside the container
 * as a server-side program rather than through the API. That is deliberate: a
 * production endpoint that could invoke a synthetic effect would be a test
 * backdoor, and the brief forbids one.
 */
import crypto from 'node:crypto';
import { registerAdapter, type EffectAdapter, type ReconcileOutcome, type SendOutcome } from './adapter.ts';

/** How the provider should misbehave on the next send. */
export type Fault =
  | 'NONE'
  /** Accepts the work and then the response is lost. */
  | 'ACCEPT_THEN_LOSE_RESPONSE'
  /** The connection dies before the provider ever sees it. */
  | 'NEVER_ARRIVES'
  /** A definite, retryable refusal — the provider did nothing. */
  | 'REJECT_RETRYABLE'
  /** A definite, permanent refusal. */
  | 'REJECT_TERMINAL'
  /** The send throws, which is ambiguous by definition. */
  | 'THROW'
  /** Returns a receipt that makes no sense. */
  | 'MALFORMED_RECEIPT';

interface ProviderState {
  /** What the provider believes it has done, by key or business id. */
  ledger: Map<string, string>;
  fault: Fault;
  sends: number;
  /** Keys the provider was handed, in order, so a test can check stability. */
  keysSeen: string[];
}

const STATE = new Map<string, ProviderState>();

function stateOf(name: string): ProviderState {
  let found = STATE.get(name);
  if (!found) {
    found = { ledger: new Map(), fault: 'NONE', sends: 0, keysSeen: [] };
    STATE.set(name, found);
  }
  return found;
}

export function setFault(adapterName: string, fault: Fault): void {
  stateOf(adapterName).fault = fault;
}

export function providerLedger(adapterName: string): Map<string, string> {
  return stateOf(adapterName).ledger;
}

export function keysSeenBy(adapterName: string): string[] {
  return [...stateOf(adapterName).keysSeen];
}

export function sendCount(adapterName: string): number {
  return stateOf(adapterName).sends;
}

export function resetSynthetic(): void {
  STATE.clear();
}

function validatePayload(payload: unknown): Record<string, unknown> {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('A synthetic effect payload must be an object.');
  }
  const record = payload as Record<string, unknown>;
  const note = record['note'];
  if (note !== undefined && typeof note !== 'string') {
    throw new Error('"note" must be a string when present.');
  }
  return note === undefined ? {} : { note };
}

function receiptFor(id: string): string {
  return `rcpt_${crypto.createHash('sha256').update(id).digest('hex').slice(0, 16)}`;
}

/** Apply the configured fault, or perform the effect. `null` means proceed. */
function faultOutcome(state: ProviderState): SendOutcome | null {
  switch (state.fault) {
    case 'NEVER_ARRIVES':
      // Ambiguous from the caller's side — which is the honest classification,
      // even though we happen to know here that nothing arrived.
      return { kind: 'UNCERTAIN', reason: 'the connection closed before a response' };
    case 'ACCEPT_THEN_LOSE_RESPONSE':
      return null; // recorded in the ledger below, then reported uncertain
    case 'REJECT_RETRYABLE':
      return {
        kind: 'REJECTED',
        category: 'DEPENDENCY_UNAVAILABLE',
        retryable: true,
        detail: 'the provider was busy and did nothing',
      };
    case 'REJECT_TERMINAL':
      return {
        kind: 'REJECTED',
        category: 'PROVIDER_REJECTED',
        retryable: false,
        detail: 'the provider refused this permanently',
      };
    case 'THROW':
      throw new Error('socket hang up');
    default:
      return null;
  }
}

/* ------------------------------------------------------------------------- */
/* A provider with native idempotency                                         */
/* ------------------------------------------------------------------------- */

export const NATIVE_IDEMPOTENT = 'synthetic.native-idempotent';

export const nativeIdempotentAdapter: EffectAdapter = {
  name: NATIVE_IDEMPOTENT,
  effectClass: 'EXTERNAL_IDEMPOTENT',
  namespace: 'test.external.native',
  providerKeyLimit: 64,
  validate: validatePayload,
  fingerprintInputs: (payload) => payload,
  async send(request): Promise<SendOutcome> {
    const state = stateOf(NATIVE_IDEMPOTENT);
    state.sends += 1;
    const key = request.providerKey;
    if (!key) throw new Error('A native-idempotent provider was called without a key.');
    state.keysSeen.push(key);

    // The whole point: a repeat of the same key returns the original receipt
    // and performs nothing.
    const already = state.ledger.get(key);
    if (already) return { kind: 'CONFIRMED', receiptRef: already, receiptMeta: { replayed: true } };

    const fault = faultOutcome(state);
    if (fault) return fault;

    const receipt = receiptFor(key);
    state.ledger.set(key, receipt);
    if (state.fault === 'ACCEPT_THEN_LOSE_RESPONSE') {
      return { kind: 'UNCERTAIN', reason: 'the response was lost after the provider accepted it' };
    }
    if (state.fault === 'MALFORMED_RECEIPT') {
      return { kind: 'CONFIRMED', receiptRef: '', receiptMeta: { nonsense: true } };
    }
    return { kind: 'CONFIRMED', receiptRef: receipt, receiptMeta: { first: true } };
  },
  redactReceipt: (meta) => {
    // Whatever a provider sends back, only the fields we understand are kept.
    const { replayed, first } = meta as { replayed?: unknown; first?: unknown };
    return { replayed: replayed === true, first: first === true };
  },
};

/* ------------------------------------------------------------------------- */
/* A provider with no key, but an authoritative answer                        */
/* ------------------------------------------------------------------------- */

export const RECONCILABLE = 'synthetic.reconcilable';

export const reconcilableAdapter: EffectAdapter = {
  name: RECONCILABLE,
  effectClass: 'EXTERNAL_RECONCILABLE',
  namespace: 'test.external.reconcilable',
  validate: validatePayload,
  fingerprintInputs: (payload) => payload,
  async send(request): Promise<SendOutcome> {
    const state = stateOf(RECONCILABLE);
    state.sends += 1;
    const fault = faultOutcome(state);
    if (fault) return fault;

    const receipt = receiptFor(request.businessId);
    // Recorded against the business id, because that is the only identity this
    // provider understands.
    state.ledger.set(request.businessId, receipt);
    if (state.fault === 'ACCEPT_THEN_LOSE_RESPONSE') {
      return { kind: 'UNCERTAIN', reason: 'the response was lost after the provider accepted it' };
    }
    return { kind: 'CONFIRMED', receiptRef: receipt };
  },
  async reconcile(businessId): Promise<ReconcileOutcome> {
    const found = stateOf(RECONCILABLE).ledger.get(businessId);
    // Asking is not sending, so this is always safe to do after an ambiguous
    // outcome — which is exactly what makes this class reconcilable.
    return found ? { kind: 'FOUND', receiptRef: found } : { kind: 'ABSENT' };
  },
};

/* ------------------------------------------------------------------------- */
/* A provider that can neither de-duplicate nor be asked                      */
/* ------------------------------------------------------------------------- */

export const OPAQUE = 'synthetic.opaque';

export const opaqueAdapter: EffectAdapter = {
  name: OPAQUE,
  effectClass: 'EXTERNAL_OPAQUE',
  namespace: 'test.external.opaque',
  validate: validatePayload,
  fingerprintInputs: (payload) => payload,
  async send(request): Promise<SendOutcome> {
    const state = stateOf(OPAQUE);
    state.sends += 1;
    const fault = faultOutcome(state);
    if (fault) return fault;

    const receipt = receiptFor(`${request.businessId}:${state.sends}`);
    state.ledger.set(`${request.businessId}#${state.sends}`, receipt);
    if (state.fault === 'ACCEPT_THEN_LOSE_RESPONSE') {
      // The effect happened. Nobody can prove it. This is the case the whole
      // UNCERTAIN state exists for.
      return { kind: 'UNCERTAIN', reason: 'the response was lost after the provider accepted it' };
    }
    return { kind: 'CONFIRMED', receiptRef: receipt };
  },
  // Deliberately no `reconcile`. Adding one would make it a different class,
  // and `assertAdapterContract` refuses an opaque adapter that has one.
};

/** Register all three. Called by tests and by the hosted harness — never at boot. */
export function registerSyntheticAdapters(): void {
  registerAdapter(nativeIdempotentAdapter);
  registerAdapter(reconcilableAdapter);
  registerAdapter(opaqueAdapter);
}
