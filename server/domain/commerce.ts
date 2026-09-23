/**
 * The commercial journey's vocabulary: what a demand test is, what a response
 * can be, what an obligation passes through, and what a payment provider can
 * say about an invoice.
 *
 * Every set here is closed and matched exactly, for the reason every other
 * vocabulary in Cash Mode is: a state somebody could spell differently is a
 * state two readers disagree about. The sets are also where the distinctions
 * the owner asked for live — interest is not an agreement, a sent offer is not
 * a sale, delivered work is not accepted work, and a payment promise is not
 * cash — because each pair is two members here rather than one.
 */

export const DEMAND_TEST_STATES = ['PREPARED', 'RUNNING', 'CONCLUDED', 'WITHDRAWN'] as const;
export type DemandTestState = (typeof DEMAND_TEST_STATES)[number];

export const DEMAND_VERDICTS = ['CONTINUE', 'CHANGE', 'STOP'] as const;
export type DemandVerdict = (typeof DEMAND_VERDICTS)[number];

export const RESPONSE_KINDS = [
  /** They want to hear more. Not an agreement, and never counted as one. */
  'INTEREST',
  'QUESTION',
  'OBJECTION',
  'DECLINED',
  /** They agreed to buy this scope at this price. The only thing that makes an obligation AGREED. */
  'AGREED_TO_BUY',
  'REVISION_REQUESTED',
  /** The buyer accepted what was delivered. The only thing that makes delivered work ACCEPTED. */
  'ACCEPTED_DELIVERY',
  'REJECTED_DELIVERY',
  /** They said they will pay. A promise; it moves no money figure at all. */
  'PAYMENT_PROMISED',
] as const;
export type ResponseKind = (typeof RESPONSE_KINDS)[number];

/** Response kinds that count as a positive answer to a demand test. */
export const INTERESTED_KINDS: readonly ResponseKind[] = Object.freeze([
  'INTEREST',
  'QUESTION',
  'AGREED_TO_BUY',
]);

export const OBLIGATION_STATES = [
  'OFFER_PREPARED',
  'OFFER_SENT',
  'AGREED',
  'IN_PRODUCTION',
  'DELIVERED',
  'REVISION_REQUESTED',
  'ACCEPTED',
  'CLOSED',
  'LOST',
  'CANCELLED',
] as const;
export type ObligationState = (typeof OBLIGATION_STATES)[number];

/** States in which we owe the buyer something or they owe us. */
export const LIVE_OBLIGATION_STATES: readonly ObligationState[] = Object.freeze([
  'OFFER_PREPARED',
  'OFFER_SENT',
  'AGREED',
  'IN_PRODUCTION',
  'DELIVERED',
  'REVISION_REQUESTED',
  'ACCEPTED',
]);

/** States reached only because a buyer agreed. Pipeline begins here, never earlier. */
export const AGREED_OBLIGATION_STATES: readonly ObligationState[] = Object.freeze([
  'AGREED',
  'IN_PRODUCTION',
  'DELIVERED',
  'REVISION_REQUESTED',
  'ACCEPTED',
  'CLOSED',
]);

/**
 * Where the work is produced.
 *
 * Each names machinery that already exists: the Software Factory for code, a
 * document or file Brain can produce for an artifact, a named person, or a
 * vendor engaged under `ENGAGE_CONTRACTOR`. There is no member meaning "it will
 * get done".
 */
export const DELIVERY_ROUTES = ['SOFTWARE_FACTORY', 'ARTIFACT', 'HUMAN', 'VENDOR'] as const;
export type DeliveryRoute = (typeof DELIVERY_ROUTES)[number];

/**
 * Who does the next thing. `CASH_ACTORS` plus the buyer, because much of a
 * commercial journey is genuinely waiting on the customer, and a waiting state
 * that could not name them would have to pretend the wait is ours.
 */
export const NEXT_STEP_OWNERS = ['BRAIN', 'OPERATOR', 'VENDOR', 'PERSON', 'BUYER'] as const;
export type NextStepOwner = (typeof NEXT_STEP_OWNERS)[number];

export const INVOICE_STATES = [
  'ISSUED',
  'PAYMENT_PENDING',
  'PAID',
  'SETTLED',
  'FAILED',
  'VOID',
  'REFUNDED',
] as const;
export type InvoiceState = (typeof INVOICE_STATES)[number];

/** Invoices nobody has finished with: money is still owed or still in flight. */
export const OPEN_INVOICE_STATES: readonly InvoiceState[] = Object.freeze([
  'ISSUED',
  'PAYMENT_PENDING',
  'PAID',
]);

/**
 * The legal moves of an invoice, as the provider reports them.
 *
 * `PAID` → `SETTLED` is the payout; `FAILED` is a declined or bounced payment
 * and may be retried by returning to `PAYMENT_PENDING`. Nothing moves an
 * invoice backwards from `SETTLED` except a refund, which is its own entry.
 */
export const INVOICE_TRANSITIONS: Readonly<Record<InvoiceState, readonly InvoiceState[]>> =
  Object.freeze({
    ISSUED: ['PAYMENT_PENDING', 'PAID', 'FAILED', 'VOID'],
    PAYMENT_PENDING: ['PAID', 'FAILED', 'VOID'],
    PAID: ['SETTLED', 'REFUNDED'],
    SETTLED: ['REFUNDED'],
    FAILED: ['PAYMENT_PENDING', 'PAID', 'VOID'],
    VOID: [],
    REFUNDED: [],
  });

export function isOneOf<T extends string>(set: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (set as readonly string[]).includes(value);
}

export interface CashDemandTest {
  id: string;
  projectId: string;
  opportunityId: string;
  ownerUserId: string;
  preparedBy: 'BRAIN' | 'PERSON';
  audience: string;
  channel: string;
  offer: string;
  priceCents: number | null;
  currency: string;
  maxContacts: number;
  maxSpendCents: number;
  windowEndsAt: string;
  continueIfAgreed: number;
  changeIfInterested: number;
  stopAfterContacts: number;
  draftMessage: string;
  /** Where every field above came from, so a reader can check the test was not invented. */
  basis: string;
  state: DemandTestState;
  verdict: DemandVerdict | null;
  verdictReason: string | null;
  startedAt: string | null;
  concludedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CashDemandContact {
  id: string;
  testId: string;
  projectId: string;
  opportunityId: string;
  actionId: string;
  recipient: string;
  sentAt: string;
  createdAt: string;
}

export interface CashResponse {
  id: string;
  projectId: string;
  opportunityId: string;
  testId: string | null;
  obligationId: string | null;
  respondent: string;
  kind: ResponseKind;
  channel: string;
  reference: string;
  excerpt: string;
  receivedAt: string;
  performedBy: 'BRAIN' | 'PERSON';
  recordedBy: string;
  requestKey: string;
  createdAt: string;
}

export interface CashObligation {
  id: string;
  projectId: string;
  opportunityId: string;
  testId: string | null;
  agreementResponseId: string | null;
  ownerUserId: string;
  buyer: string;
  scope: string;
  priceCents: number;
  currency: string;
  acceptanceConditions: string[];
  deliveryPlan: string;
  deliveryRoute: DeliveryRoute;
  requiredResources: string[];
  productionReference: string | null;
  deliverableReference: string | null;
  state: ObligationState;
  revisionCount: number;
  nextStep: string;
  nextStepOwner: NextStepOwner;
  nextStepDue: string | null;
  offerActionId: string | null;
  sentAt: string | null;
  agreedAt: string | null;
  deliveredAt: string | null;
  acceptedAt: string | null;
  closedAt: string | null;
  closeReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CashObligationEvent {
  id: string;
  obligationId: string;
  projectId: string;
  kind: string;
  fromState: ObligationState | null;
  toState: ObligationState;
  actorRef: string;
  evidence: Record<string, unknown>;
  createdAt: string;
}

export interface CashInvoice {
  id: string;
  projectId: string;
  obligationId: string;
  opportunityId: string;
  amountCents: number;
  currency: string;
  provider: string;
  providerReference: string;
  issuedActionId: string;
  state: InvoiceState;
  dueAt: string | null;
  paymentReference: string | null;
  paymentEntryId: string | null;
  settlementReference: string | null;
  settlementEntryId: string | null;
  fundsAvailableAt: string | null;
  stateReason: string | null;
  issuedAt: string;
  paidAt: string | null;
  settledAt: string | null;
  createdAt: string;
  updatedAt: string;
}
