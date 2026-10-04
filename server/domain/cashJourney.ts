/**
 * The vocabulary of the first-dollar journey: what was agreed, what was billed,
 * what the buyer said, whether the work was done, and what it taught.
 *
 * Every set here is closed and matched exactly, for §8's reason one domain
 * along: a buyer's reply, an agreement and a delivery are the facts that decide
 * whether money is owed, so none of them may be a free-text label somebody
 * matched with a substring.
 */

export const OBSERVATION_KINDS = [
  /** The buyer answered. Says nothing about whether they will pay. */
  'BUYER_REPLIED',
  /** The buyer accepted the offer as sent. Evidence for an agreement, not one. */
  'BUYER_ACCEPTED',
  /** The buyer proposed different terms; the amount is theirs. */
  'BUYER_COUNTERED',
  'BUYER_DECLINED',
  /** Derived by Brain: a contact with no reply inside the response window. */
  'BUYER_SILENT',
  /** The channel itself refused: a bounce, a closed inbox, a wrong number. */
  'CONTACT_UNDELIVERABLE',
  /** The buyer accepted the delivered work against the acceptance condition. */
  'DELIVERY_ACCEPTED',
  'DELIVERY_REJECTED',
  /** A supplier or contractor's price moved after it was committed against. */
  'SUPPLIER_COST_CHANGED',
] as const;
export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

export const OBSERVATION_SOURCES = ['PROVIDER', 'PERSON', 'BRAIN'] as const;
export type ObservationSource = (typeof OBSERVATION_SOURCES)[number];

export const AGREEMENT_EVIDENCE_KINDS = [
  'SIGNED_AGREEMENT',
  'WRITTEN_ACCEPTANCE',
  'PURCHASE_ORDER',
  'PROVIDER_RECORD',
] as const;
export type AgreementEvidenceKind = (typeof AGREEMENT_EVIDENCE_KINDS)[number];

export const AGREEMENT_STATES = ['AGREED', 'RELEASED'] as const;
export type AgreementState = (typeof AGREEMENT_STATES)[number];

export const FULFILMENT_PATHS = [
  'BRAIN_RESEARCH',
  'FACTORY_SOFTWARE',
  'PERSON',
  'CONTRACTOR',
  'SUPPLIER',
  'OTHER',
] as const;
export type FulfilmentPath = (typeof FULFILMENT_PATHS)[number];

export const FULFILMENT_WORK_KINDS = [
  'RUSSELL_CANDIDATE',
  'FACTORY_CHANGE_REQUEST',
  'CASH_JOB',
  'COMMITMENT',
  'EXTERNAL',
] as const;
export type FulfilmentWorkKind = (typeof FULFILMENT_WORK_KINDS)[number];

/**
 * Which existing machinery each path's work is held in.
 *
 * A `Record` over the whole union, so a path added later is a compile error
 * until somebody says where its work lives.
 */
export const WORK_KINDS_FOR_PATH: Readonly<Record<FulfilmentPath, readonly FulfilmentWorkKind[]>> = {
  BRAIN_RESEARCH: ['RUSSELL_CANDIDATE'],
  FACTORY_SOFTWARE: ['FACTORY_CHANGE_REQUEST'],
  PERSON: ['CASH_JOB', 'EXTERNAL'],
  CONTRACTOR: ['COMMITMENT', 'EXTERNAL'],
  SUPPLIER: ['COMMITMENT', 'EXTERNAL'],
  OTHER: ['EXTERNAL'],
};

export const FULFILMENT_STATES = ['CREATED', 'PERFORMED', 'DELIVERED', 'FAILED', 'CANCELLED'] as const;
export type FulfilmentState = (typeof FULFILMENT_STATES)[number];

export const OUTCOME_KINDS = [
  'CONTACT_RESULT',
  'OFFERED_PRICE',
  'ACCEPTED_PRICE',
  'TIME_TO_AGREEMENT',
  'FULFILMENT_DURATION',
  'ACTUAL_COST',
  'REFUNDED',
  'REALIZED_CONTRIBUTION',
  'FAILURE_REASON',
] as const;
export type OutcomeKind = (typeof OUTCOME_KINDS)[number];

export function isOneOf<T extends string>(set: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (set as readonly string[]).includes(value);
}

export interface CashObservation {
  id: string;
  projectId: string;
  opportunityId: string;
  kind: ObservationKind;
  source: ObservationSource;
  channel: string | null;
  evidenceRef: string;
  amountCents: number | null;
  currency: string | null;
  note: string | null;
  observedAt: string;
  recordedBy: string;
  requestKey: string;
  createdAt: string;
}

export interface CashAgreement {
  id: string;
  projectId: string;
  opportunityId: string;
  amountCents: number;
  currency: string;
  deliverable: string;
  acceptanceCondition: string;
  evidenceKind: AgreementEvidenceKind;
  evidenceRef: string;
  observationId: string | null;
  state: AgreementState;
  releasedReason: string | null;
  releasedBy: string | null;
  releasedAt: string | null;
  requestKey: string;
  recordedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CashFulfilment {
  id: string;
  projectId: string;
  opportunityId: string;
  agreementId: string;
  path: FulfilmentPath;
  workKind: FulfilmentWorkKind;
  workRef: string;
  commitmentId: string | null;
  state: FulfilmentState;
  performedEvidence: string | null;
  acceptedObservationId: string | null;
  acceptanceEvidence: string | null;
  stateReason: string | null;
  requestKey: string;
  createdBy: string;
  createdAt: string;
  performedAt: string | null;
  deliveredAt: string | null;
  endedAt: string | null;
  updatedAt: string;
}

export interface CashOutcome {
  id: string;
  projectId: string;
  opportunityId: string;
  kind: OutcomeKind;
  mechanism: string | null;
  channel: string | null;
  valueCents: number | null;
  valueMs: number | null;
  valueText: string | null;
  currency: string | null;
  basis: string;
  requestKey: string;
  createdAt: string;
}
