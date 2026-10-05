/**
 * The vocabulary of a deal before and around the agreement: what the buyer
 * said, what was agreed, and what a finished deal taught. The obligation an
 * agreement creates — its work, delivery, acceptance and refunds — is
 * `cashFulfillment.ts`; the ownership matrix is docs/POST-SALE.md.
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

export const OUTCOME_KINDS = [
  'CONTACT_RESULT',
  'OFFERED_PRICE',
  'ACCEPTED_PRICE',
  'TIME_TO_AGREEMENT',
  'FULFILLMENT_DURATION',
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
