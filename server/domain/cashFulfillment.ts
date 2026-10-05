/**
 * The vocabulary of the obligation an agreement creates.
 *
 * One obligation per agreement (`cash_fulfillments.agreement_id` is unique).
 * What was promised and what proves it landed are the agreement's own
 * `deliverable` and `acceptance_condition` and are not copied here: two copies
 * of one promise is how the card, the agreement and the obligation came to
 * disagree in the two branches this replaced (docs/POST-SALE.md).
 *
 * Every `*Row` type is the shape `migrations/108_cash_post_sale.sql` holds,
 * every view type is what the repository hands upward, and
 * `repos/cashFulfillment.ts` is the only place the two meet.
 */

/**
 * How an obligation is performed.
 *
 * Closed, and each member names *who does the work*, because that decides what
 * Brain can create for it:
 *
 *   * `SOFTWARE` — the Software Factory builds it. Brain submits an objective;
 *     a person still approves it on Build.
 *   * `RESEARCH` — the research pipeline answers it. Brain captures an idea;
 *     the standing research authority decides whether it launches.
 *   * `PERSON` — somebody does it by hand. Brain creates nothing and tracks
 *     what is waiting and what proof closes it.
 *   * `SUPPLIER` — a contractor or supplier does it. Brain tracks their
 *     liability in the ledger and the evidence they delivered.
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
 *
 * There is no supplier-commitment event: what a supplier is owed is a ledger
 * entry (`UNPAID_COMMITMENT`), and one fact has one owner.
 */
export const FULFILLMENT_EVENT_KINDS = [
  'WORK_COMPLETE',
  'DELIVERED',
  'PARTIALLY_DELIVERED',
  'ACCEPTED',
  'REJECTED',
  'FAILED',
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

export interface CashFulfillmentRow {
  id: string;
  project_id: string;
  opportunity_id: string;
  agreement_id: string;
  kind: string;
  performer: string;
  repository_remote: string | null;
  repository_root: string | null;
  base_branch: string | null;
  mutation_scope: string | null;
  supplier_name: string | null;
  work_ref: string | null;
  work_created_at: string | null;
  work_attempt: number;
  declared_by: string;
  created_at: string;
  updated_at: string;
}

export interface CashFulfillment {
  id: string;
  projectId: string;
  opportunityId: string;
  /** The agreement this obligation delivers. Its deliverable is the promise. */
  agreementId: string;
  kind: FulfillmentKind;
  /** Who or what performs it. A name, never "somebody". */
  performer: string;
  repositoryRemote: string | null;
  repositoryRoot: string | null;
  baseBranch: string | null;
  mutationScope: string[];
  supplierName: string | null;
  /** The Factory change request or Russell candidate created for it, once per attempt. */
  workRef: string | null;
  workCreatedAt: string | null;
  /** How many times failed work was released for re-creation. */
  workAttempt: number;
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
