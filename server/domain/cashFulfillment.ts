/**
 * The vocabulary of what happens after a buyer agrees.
 *
 * Kept in its own file rather than appended to `types.ts`, for the reason
 * `domain/factory.ts` gives: three workstreams are changing Cash Mode at once,
 * and the widest file in the repository is where they would collide.
 *
 * Every `*Row` type is the shape `migrations/104_cash_fulfillment.sql` holds,
 * every view type is what the repository hands upward, and
 * `repos/cashFulfillment.ts` is the only place the two meet.
 */

/**
 * How an obligation is performed.
 *
 * Closed, and each member names *who does the work* rather than what the work
 * is about, because that is what decides what Brain can create for it:
 *
 *   * `SOFTWARE` — the Software Factory builds it. Brain submits an objective;
 *     a person still approves it on Build.
 *   * `RESEARCH` — the research pipeline answers it. Brain captures an idea;
 *     the standing research authority decides whether it launches.
 *   * `PERSON` — somebody does it by hand. Brain creates nothing and tracks
 *     what is waiting and what proof closes it.
 *   * `SUPPLIER` — a contractor or supplier does it. Brain tracks their
 *     commitment, what it cost and the evidence they delivered.
 *
 * There is no member meaning "Brain does it directly". A capability Brain does
 * not have is a need, never a kind.
 */
export const FULFILLMENT_KINDS = ['SOFTWARE', 'RESEARCH', 'PERSON', 'SUPPLIER'] as const;
export type FulfillmentKind = (typeof FULFILLMENT_KINDS)[number];

/**
 * What can be recorded as having happened to an obligation.
 *
 * `WORK_COMPLETE` is accepted only for `PERSON` and `SUPPLIER` work. Software
 * and research completion is read from the Factory's and the pipeline's own
 * rows, because a worker saying "done" is not evidence (§27).
 */
export const FULFILLMENT_EVENT_KINDS = [
  'WORK_COMPLETE',
  'DELIVERED',
  'PARTIALLY_DELIVERED',
  'ACCEPTED',
  'REJECTED',
  'FAILED',
  'SUPPLIER_COMMITTED',
  'SUPPLIER_FAILED',
  'ABANDONED',
  'REFUND_AUTHORIZED',
  'REFUND_CONFIRMED',
  'REFUND_UNKNOWN',
  'REFUND_FAILED',
] as const;
export type FulfillmentEventKind = (typeof FULFILLMENT_EVENT_KINDS)[number];

/** The kinds a person records directly through the event route. */
export const RECORDABLE_FULFILLMENT_EVENTS = [
  'WORK_COMPLETE',
  'DELIVERED',
  'PARTIALLY_DELIVERED',
  'ACCEPTED',
  'REJECTED',
  'FAILED',
  'SUPPLIER_FAILED',
  'ABANDONED',
] as const satisfies readonly FulfillmentEventKind[];
export type RecordableFulfillmentEvent = (typeof RECORDABLE_FULFILLMENT_EVENTS)[number];

export const OUTCOME_OBSERVATION_KINDS = [
  'BUYER_RESPONSE',
  'AGREED_PRICE',
  'DELIVERY_TIME',
  'ACCEPTANCE',
  'ACTUAL_COST',
  'SUPPLIER_RELIABILITY',
  'REFUND_REASON',
  'REALIZED_CONTRIBUTION',
] as const;
export type OutcomeObservationKind = (typeof OUTCOME_OBSERVATION_KINDS)[number];

export const OUTCOMES = ['SUCCESS', 'FAILURE', 'REFUND'] as const;
export type Outcome = (typeof OUTCOMES)[number];

export interface CashFulfillmentRow {
  id: string;
  project_id: string;
  opportunity_id: string;
  kind: string;
  promise: string;
  performer: string;
  acceptance_condition: string | null;
  repository_remote: string | null;
  repository_root: string | null;
  base_branch: string | null;
  mutation_scope: string | null;
  supplier_name: string | null;
  work_ref: string | null;
  work_created_at: string | null;
  declared_by: string;
  created_at: string;
  updated_at: string;
}

export interface CashFulfillment {
  id: string;
  projectId: string;
  opportunityId: string;
  kind: FulfillmentKind;
  /** What was promised, in the words the agreement used. */
  promise: string;
  /** Who or what performs it. A name, never "somebody". */
  performer: string;
  /** What proves it landed. Null raises a need: acceptance cannot be judged without it. */
  acceptanceCondition: string | null;
  repositoryRemote: string | null;
  repositoryRoot: string | null;
  baseBranch: string | null;
  mutationScope: string[];
  supplierName: string | null;
  /** The Factory change request or Russell candidate created for it, once. */
  workRef: string | null;
  workCreatedAt: string | null;
  declaredBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CashFulfillmentEventRow {
  id: string;
  project_id: string;
  fulfillment_id: string;
  opportunity_id: string;
  kind: string;
  detail: string;
  evidence_ref: string | null;
  amount_cents: number | null;
  refund_key: string | null;
  recorded_by: string;
  request_key: string;
  created_at: string;
}

export interface CashFulfillmentEvent {
  id: string;
  projectId: string;
  fulfillmentId: string;
  opportunityId: string;
  kind: FulfillmentEventKind;
  detail: string;
  evidenceRef: string | null;
  amountCents: number | null;
  /** Ties a refund's authorization to its outcome. Null on every other kind. */
  refundKey: string | null;
  recordedBy: string;
  requestKey: string;
  createdAt: string;
}

export interface CashOutcomeObservationRow {
  id: string;
  project_id: string;
  opportunity_id: string;
  fulfillment_id: string;
  mechanism: string;
  fulfillment_kind: string;
  outcome: string;
  kind: string;
  value_text: string;
  value_number: number | null;
  currency: string | null;
  request_key: string;
  observed_at: string;
}

export interface CashOutcomeObservation {
  id: string;
  projectId: string;
  opportunityId: string;
  fulfillmentId: string;
  mechanism: string;
  fulfillmentKind: FulfillmentKind;
  outcome: Outcome;
  kind: OutcomeObservationKind;
  valueText: string;
  /** Cents for money kinds, seconds for `DELIVERY_TIME`, null otherwise. */
  valueNumber: number | null;
  currency: string | null;
  requestKey: string;
  observedAt: string;
}
