/**
 * Work done through people, as rows.
 *
 * Every state change here is a guarded `UPDATE` naming the state it moves from,
 * so two callers deciding one thing produce one change and an ordinary loser —
 * the compare-and-swap every other repository in this codebase uses, for the
 * same reason: the tick and the routes run on more than one instance, and the
 * arbiter has to be the database.
 *
 * Events, deliverables, reviews and costs are append-only. There is no
 * function here that edits or deletes one, and `tests/humanWork.test.ts` reads
 * this file to keep it that way: what somebody was told, what they handed back
 * and what it cost are the evidence the next staffing decision is made from.
 */
import { createHash } from 'node:crypto';
import { getDb } from '../db/database.ts';
import type { SqlParam } from '../db/types.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';
import type {
  AcceptanceCondition,
  CompetenceEvidence,
  EngagedEvidence,
  EngagementFunding,
  EngagementState,
  EngagementTerms,
  HumanNecessityReason,
  HumanWorkActor,
  HumanWorkCandidate,
  HumanWorkCandidateRow,
  HumanWorkCost,
  HumanWorkCostRow,
  HumanWorkDeliverable,
  HumanWorkDeliverableRow,
  HumanWorkEngagement,
  HumanWorkEngagementRow,
  HumanWorkEvent,
  HumanWorkEventRow,
  HumanWorkOrder,
  HumanWorkOrderRow,
  HumanWorkOrderState,
  HumanWorkRelationship,
  HumanWorkReview,
  HumanWorkReviewRow,
  QuoteSource,
  RateBasis,
  ReviewVerdict,
} from '../domain/types.ts';

const tidy = (value: string) => value.replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

function mapOrder(row: HumanWorkOrderRow): HumanWorkOrder {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    allocationId: row.allocation_id,
    necessityReason: row.necessity_reason as HumanNecessityReason,
    title: row.title,
    work: row.work,
    whyPerson: row.why_person,
    brainPrepares: parseJson<string[]>(row.brain_prepares, []),
    deliverables: parseJson<string[]>(row.deliverables, []),
    acceptance: parseJson<AcceptanceCondition[]>(row.acceptance, []),
    sharedContext: parseJson<string[]>(row.shared_context, []),
    accessRequired: parseJson<string[]>(row.access_required, []),
    dueBy: row.due_by,
    budgetCents: row.budget_cents,
    currency: row.currency,
    coordinatorUserId: row.coordinator_user_id,
    openedBy: row.opened_by,
    state: row.state as HumanWorkOrderState,
    closedAt: row.closed_at,
    closeReason: row.close_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface NewOrder {
  projectId: string;
  taskId: string;
  allocationId: string;
  necessityReason: HumanNecessityReason;
  title: string;
  work: string;
  whyPerson: string;
  brainPrepares: string[];
  deliverables: string[];
  acceptance: AcceptanceCondition[];
  sharedContext: string[];
  accessRequired: string[];
  dueBy: string | null;
  budgetCents: number | null;
  currency: string;
  coordinatorUserId: string | null;
  openedBy: string;
}

/**
 * Open an order, or find the live one for this task.
 *
 * One live order per task, by a partial unique index: two people opening work
 * for the same task at once produce one order, and the loser reads it back.
 */
export async function createOrder(input: NewOrder): Promise<{ order: HumanWorkOrder; created: boolean }> {
  const id = newId('hwo');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO human_work_orders
       (id, project_id, task_id, allocation_id, necessity_reason, title, work, why_person,
        brain_prepares, deliverables, acceptance, shared_context, access_required, due_by,
        budget_cents, currency, coordinator_user_id, opened_by, state, closed_at, close_reason,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', NULL, NULL, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      input.taskId,
      input.allocationId,
      input.necessityReason,
      tidy(input.title),
      input.work.trim(),
      input.whyPerson.trim(),
      toJson(input.brainPrepares),
      toJson(input.deliverables),
      toJson(input.acceptance),
      toJson(input.sharedContext),
      toJson(input.accessRequired),
      input.dueBy,
      input.budgetCents,
      input.currency,
      input.coordinatorUserId,
      input.openedBy,
      at,
      at,
    ],
  );
  const rows = await getDb().all<HumanWorkOrderRow>(
    "SELECT * FROM human_work_orders WHERE task_id = ? AND state = 'OPEN'",
    [input.taskId],
  );
  if (!rows[0]) throw new Error('The work order disappeared immediately after being written.');
  return { order: mapOrder(rows[0]), created: rows[0].id === id };
}

export async function getOrder(id: string): Promise<HumanWorkOrder | null> {
  const rows = await getDb().all<HumanWorkOrderRow>('SELECT * FROM human_work_orders WHERE id = ?', [id]);
  return rows[0] ? mapOrder(rows[0]) : null;
}

export async function listOrders(projectId: string): Promise<HumanWorkOrder[]> {
  const rows = await getDb().all<HumanWorkOrderRow>(
    `SELECT * FROM human_work_orders WHERE project_id = ? ORDER BY created_at ASC, id ASC`,
    [projectId],
  );
  return rows.map(mapOrder);
}

export async function listOpenOrders(limit = 200): Promise<HumanWorkOrder[]> {
  const rows = await getDb().all<HumanWorkOrderRow>(
    `SELECT * FROM human_work_orders WHERE state = 'OPEN' ORDER BY created_at ASC, id ASC LIMIT ?`,
    [Math.max(1, Math.min(1000, limit))],
  );
  return rows.map(mapOrder);
}

export async function closeOrder(input: {
  id: string;
  to: 'ACCEPTED' | 'CANCELLED';
  reason: string;
}): Promise<boolean> {
  const at = nowIso();
  const result = await getDb().run(
    `UPDATE human_work_orders SET state = ?, closed_at = ?, close_reason = ?, updated_at = ?
      WHERE id = ? AND state = 'OPEN'`,
    [input.to, at, input.reason, at, input.id],
  );
  return result.changes === 1;
}

export async function setCoordinator(orderId: string, userId: string | null): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE human_work_orders SET coordinator_user_id = ?, updated_at = ?
      WHERE id = ? AND state = 'OPEN'`,
    [userId, nowIso(), orderId],
  );
  return result.changes === 1;
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

function mapCandidate(row: HumanWorkCandidateRow): HumanWorkCandidate {
  return {
    id: row.id,
    projectId: row.project_id,
    orderId: row.order_id,
    displayName: row.display_name,
    kind: row.kind as HumanWorkCandidate['kind'],
    relationship: row.relationship as HumanWorkRelationship,
    userId: row.user_id,
    sourceClaimId: row.source_claim_id,
    attestedBy: row.attested_by,
    competence: parseJson<CompetenceEvidence[]>(row.competence, []),
    location: row.location,
    availability: row.availability,
    quoteCents: row.quote_cents,
    quoteBasis: row.quote_basis as RateBasis | null,
    quoteCurrency: row.quote_currency,
    quoteSource: row.quote_source as QuoteSource | null,
    uncertainties: parseJson<string[]>(row.uncertainties, []),
    contactChannel: row.contact_channel,
    setAsideAt: row.set_aside_at,
    setAsideReason: row.set_aside_reason,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export interface NewCandidate {
  projectId: string;
  orderId: string;
  displayName: string;
  kind: 'PERSON' | 'ORGANIZATION';
  relationship: HumanWorkRelationship;
  userId: string | null;
  sourceClaimId: string | null;
  attestedBy: string | null;
  competence: CompetenceEvidence[];
  location: string | null;
  availability: string | null;
  quoteCents: number | null;
  quoteBasis: RateBasis | null;
  quoteCurrency: string | null;
  quoteSource: QuoteSource | null;
  uncertainties: string[];
  contactChannel: string | null;
  createdBy: string;
}

export async function addCandidate(input: NewCandidate): Promise<{ candidate: HumanWorkCandidate; created: boolean }> {
  const id = newId('hwc');
  await getDb().run(
    `INSERT INTO human_work_candidates
       (id, project_id, order_id, display_name, kind, relationship, user_id, source_claim_id,
        attested_by, competence, location, availability, quote_cents, quote_basis, quote_currency,
        quote_source, uncertainties, contact_channel, set_aside_at, set_aside_reason, created_by,
        created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      input.orderId,
      tidy(input.displayName),
      input.kind,
      input.relationship,
      input.userId,
      input.sourceClaimId,
      input.attestedBy,
      toJson(input.competence),
      input.location,
      input.availability,
      input.quoteCents,
      input.quoteCents === null ? null : input.quoteBasis,
      input.quoteCurrency,
      input.quoteSource,
      toJson(input.uncertainties),
      input.contactChannel,
      input.createdBy,
      nowIso(),
    ],
  );
  const byKey = input.userId
    ? await getDb().all<HumanWorkCandidateRow>(
        'SELECT * FROM human_work_candidates WHERE order_id = ? AND user_id = ?',
        [input.orderId, input.userId],
      )
    : input.sourceClaimId
      ? await getDb().all<HumanWorkCandidateRow>(
          'SELECT * FROM human_work_candidates WHERE order_id = ? AND source_claim_id = ?',
          [input.orderId, input.sourceClaimId],
        )
      : await getDb().all<HumanWorkCandidateRow>('SELECT * FROM human_work_candidates WHERE id = ?', [id]);
  if (!byKey[0]) throw new Error('The candidate disappeared immediately after being written.');
  return { candidate: mapCandidate(byKey[0]), created: byKey[0].id === id };
}

export async function getCandidate(id: string): Promise<HumanWorkCandidate | null> {
  const rows = await getDb().all<HumanWorkCandidateRow>('SELECT * FROM human_work_candidates WHERE id = ?', [id]);
  return rows[0] ? mapCandidate(rows[0]) : null;
}

export async function listCandidates(orderId: string): Promise<HumanWorkCandidate[]> {
  const rows = await getDb().all<HumanWorkCandidateRow>(
    'SELECT * FROM human_work_candidates WHERE order_id = ? ORDER BY created_at ASC, id ASC',
    [orderId],
  );
  return rows.map(mapCandidate);
}

export async function listProjectCandidates(projectId: string): Promise<HumanWorkCandidate[]> {
  const rows = await getDb().all<HumanWorkCandidateRow>(
    'SELECT * FROM human_work_candidates WHERE project_id = ? ORDER BY created_at ASC, id ASC',
    [projectId],
  );
  return rows.map(mapCandidate);
}

export async function setAsideCandidate(id: string, reason: string): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE human_work_candidates SET set_aside_at = ?, set_aside_reason = ?
      WHERE id = ? AND set_aside_at IS NULL`,
    [nowIso(), reason, id],
  );
  return result.changes === 1;
}

// ---------------------------------------------------------------------------
// Engagements
// ---------------------------------------------------------------------------

function mapEngagement(row: HumanWorkEngagementRow): HumanWorkEngagement {
  return {
    id: row.id,
    projectId: row.project_id,
    orderId: row.order_id,
    candidateId: row.candidate_id,
    terms: parseJson<EngagementTerms>(row.terms, {} as EngagementTerms),
    termsHash: row.terms_hash,
    compensationCents: row.compensation_cents,
    currency: row.currency,
    state: row.state as EngagementState,
    decisionRequestId: row.decision_request_id,
    approvedByUserId: row.approved_by_user_id,
    approvedAt: row.approved_at,
    approvedMaxCents: row.approved_max_cents,
    funding: row.funding as EngagementFunding | null,
    commitmentId: row.commitment_id,
    assigneeUserId: row.assignee_user_id,
    invitedAt: row.invited_at,
    invitedBy: row.invited_by,
    invitationChannel: row.invitation_channel,
    invitationReference: row.invitation_reference,
    engagedAt: row.engaged_at,
    engagedEvidence: row.engaged_evidence as EngagedEvidence | null,
    engagedAttestedBy: row.engaged_attested_by,
    completedAt: row.completed_at,
    endedReason: row.ended_reason,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The terms, hashed — what a decision was made about. */
export function termsHash(terms: EngagementTerms): string {
  return createHash('sha256').update(JSON.stringify(terms), 'utf8').digest('hex');
}

/**
 * Propose terms to a candidate.
 *
 * One live engagement per order, by a partial unique index: a second proposal
 * while one is live is refused rather than queued, because two sets of terms
 * in front of one decision-maker is two decisions nobody asked for.
 */
export async function createEngagement(input: {
  projectId: string;
  orderId: string;
  candidateId: string;
  terms: EngagementTerms;
  assigneeUserId: string | null;
  createdBy: string;
}): Promise<HumanWorkEngagement | null> {
  const id = newId('hwe');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO human_work_engagements
       (id, project_id, order_id, candidate_id, terms, terms_hash, compensation_cents, currency,
        state, assignee_user_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PROPOSED', ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      input.orderId,
      input.candidateId,
      toJson(input.terms),
      termsHash(input.terms),
      input.terms.compensationCents,
      input.terms.currency,
      input.assigneeUserId,
      input.createdBy,
      at,
      at,
    ],
  );
  return getEngagement(id);
}

export async function getEngagement(id: string): Promise<HumanWorkEngagement | null> {
  const rows = await getDb().all<HumanWorkEngagementRow>('SELECT * FROM human_work_engagements WHERE id = ?', [id]);
  return rows[0] ? mapEngagement(rows[0]) : null;
}

export async function listEngagements(orderId: string): Promise<HumanWorkEngagement[]> {
  const rows = await getDb().all<HumanWorkEngagementRow>(
    'SELECT * FROM human_work_engagements WHERE order_id = ? ORDER BY created_at ASC, id ASC',
    [orderId],
  );
  return rows.map(mapEngagement);
}

export async function listProjectEngagements(projectId: string): Promise<HumanWorkEngagement[]> {
  const rows = await getDb().all<HumanWorkEngagementRow>(
    'SELECT * FROM human_work_engagements WHERE project_id = ? ORDER BY created_at ASC, id ASC',
    [projectId],
  );
  return rows.map(mapEngagement);
}

export async function engagementsForAssignee(userId: string): Promise<HumanWorkEngagement[]> {
  const rows = await getDb().all<HumanWorkEngagementRow>(
    `SELECT * FROM human_work_engagements WHERE assignee_user_id = ?
      ORDER BY created_at DESC, id DESC`,
    [userId],
  );
  return rows.map(mapEngagement);
}

/** Every engagement with this person or this researched source, across projects. */
export async function engagementsForCandidateIdentity(input: {
  userId: string | null;
  sourceClaimId: string | null;
  displayName: string;
}): Promise<HumanWorkEngagement[]> {
  const rows = await getDb().all<HumanWorkEngagementRow>(
    `SELECT e.* FROM human_work_engagements e
       JOIN human_work_candidates c ON c.id = e.candidate_id
      WHERE (c.user_id IS NOT NULL AND c.user_id = ?)
         OR (c.source_claim_id IS NOT NULL AND c.source_claim_id = ?)
         OR (c.user_id IS NULL AND c.source_claim_id IS NULL AND c.display_name = ?)
      ORDER BY e.created_at ASC, e.id ASC`,
    [input.userId ?? '', input.sourceClaimId ?? '', input.displayName],
  );
  return rows.map(mapEngagement);
}

type EngagementPatch = Partial<{
  decision_request_id: string | null;
  approved_by_user_id: string;
  approved_at: string;
  approved_max_cents: number;
  funding: EngagementFunding;
  commitment_id: string | null;
  invited_at: string;
  invited_by: string;
  invitation_channel: string;
  invitation_reference: string | null;
  engaged_at: string;
  engaged_evidence: EngagedEvidence;
  engaged_attested_by: string | null;
  completed_at: string;
  ended_reason: string;
}>;

/**
 * Move an engagement from one named state to another, in one statement.
 *
 * The `WHERE state = ?` is the whole guard: an invitation cannot become an
 * engagement unless it is still an invitation, and a late second answer to one
 * decision matches nothing.
 */
export async function transitionEngagement(input: {
  id: string;
  from: EngagementState;
  to: EngagementState;
  patch?: EngagementPatch;
}): Promise<boolean> {
  const patch = input.patch ?? {};
  const keys = Object.keys(patch) as (keyof EngagementPatch)[];
  const sets = ['state = ?', 'updated_at = ?', ...keys.map((key) => `${key} = ?`)];
  const values: SqlParam[] = [input.to, nowIso(), ...keys.map((key) => (patch[key] ?? null) as SqlParam)];
  const result = await getDb().run(
    `UPDATE human_work_engagements SET ${sets.join(', ')} WHERE id = ? AND state = ?`,
    [...values, input.id, input.from],
  );
  return result.changes === 1;
}

/** Attach the decision card, once. */
export async function setDecisionRequest(engagementId: string, requestId: string): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE human_work_engagements SET decision_request_id = ?, updated_at = ?
      WHERE id = ? AND decision_request_id IS NULL AND state = 'PROPOSED'`,
    [requestId, nowIso(), engagementId],
  );
  return result.changes === 1;
}

export async function engagementForRequest(requestId: string): Promise<HumanWorkEngagement | null> {
  const rows = await getDb().all<HumanWorkEngagementRow>(
    'SELECT * FROM human_work_engagements WHERE decision_request_id = ?',
    [requestId],
  );
  return rows[0] ? mapEngagement(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function mapEvent(row: HumanWorkEventRow): HumanWorkEvent {
  return {
    id: row.id,
    projectId: row.project_id,
    orderId: row.order_id,
    engagementId: row.engagement_id,
    kind: row.kind,
    summary: row.summary,
    detail: parseJson<Record<string, unknown>>(row.detail, {}),
    actor: row.actor as HumanWorkActor,
    actorUserId: row.actor_user_id,
    createdAt: row.created_at,
  };
}

export async function recordHumanWorkEvent(input: {
  projectId: string;
  orderId: string;
  engagementId?: string | null;
  kind: string;
  summary: string;
  detail?: Record<string, unknown>;
  actor: HumanWorkActor;
  actorUserId?: string | null;
}): Promise<HumanWorkEvent> {
  const id = newId('hwv');
  await getDb().run(
    `INSERT INTO human_work_events
       (id, project_id, order_id, engagement_id, kind, summary, detail, actor, actor_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.projectId,
      input.orderId,
      input.engagementId ?? null,
      input.kind,
      input.summary.slice(0, 2_000),
      toJson(input.detail ?? {}),
      input.actor,
      input.actorUserId ?? null,
      nowIso(),
    ],
  );
  const rows = await getDb().all<HumanWorkEventRow>('SELECT * FROM human_work_events WHERE id = ?', [id]);
  return mapEvent(rows[0]!);
}

export async function listHumanWorkEvents(orderId: string): Promise<HumanWorkEvent[]> {
  const rows = await getDb().all<HumanWorkEventRow>(
    'SELECT * FROM human_work_events WHERE order_id = ? ORDER BY created_at ASC, rowid ASC',
    [orderId],
  );
  return rows.map(mapEvent);
}

// ---------------------------------------------------------------------------
// Deliverables, reviews and costs
// ---------------------------------------------------------------------------

function mapDeliverable(row: HumanWorkDeliverableRow): HumanWorkDeliverable {
  return {
    id: row.id,
    projectId: row.project_id,
    engagementId: row.engagement_id,
    round: row.round,
    description: row.description,
    documentId: row.document_id,
    reference: row.reference,
    submittedByUserId: row.submitted_by_user_id,
    submittedAs: row.submitted_as as HumanWorkDeliverable['submittedAs'],
    createdAt: row.created_at,
  };
}

/**
 * Record a deliverable as the next round.
 *
 * The round is computed and then *claimed* by the unique index, so two
 * submissions at once produce rounds n and n+1 or one of them retries — never
 * two rows claiming to be the same round.
 */
export async function addDeliverable(input: {
  projectId: string;
  engagementId: string;
  description: string;
  documentId: string | null;
  reference: string | null;
  submittedByUserId: string;
  submittedAs: 'ASSIGNEE' | 'COORDINATOR';
}): Promise<HumanWorkDeliverable> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const max = await getDb().all<{ round: number | null }>(
      'SELECT MAX(round) AS round FROM human_work_deliverables WHERE engagement_id = ?',
      [input.engagementId],
    );
    const round = (max[0]?.round ?? 0) + 1;
    const id = newId('hwd');
    await getDb().run(
      `INSERT INTO human_work_deliverables
         (id, project_id, engagement_id, round, description, document_id, reference,
          submitted_by_user_id, submitted_as, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
      [
        id,
        input.projectId,
        input.engagementId,
        round,
        input.description.trim(),
        input.documentId,
        input.reference,
        input.submittedByUserId,
        input.submittedAs,
        nowIso(),
      ],
    );
    const rows = await getDb().all<HumanWorkDeliverableRow>('SELECT * FROM human_work_deliverables WHERE id = ?', [id]);
    if (rows[0]) return mapDeliverable(rows[0]);
  }
  throw new Error('Could not claim a deliverable round after five attempts.');
}

export async function listDeliverables(engagementId: string): Promise<HumanWorkDeliverable[]> {
  const rows = await getDb().all<HumanWorkDeliverableRow>(
    'SELECT * FROM human_work_deliverables WHERE engagement_id = ? ORDER BY round ASC',
    [engagementId],
  );
  return rows.map(mapDeliverable);
}

function mapReview(row: HumanWorkReviewRow): HumanWorkReview {
  return {
    id: row.id,
    projectId: row.project_id,
    engagementId: row.engagement_id,
    deliverableId: row.deliverable_id,
    criterionKey: row.criterion_key,
    verdict: row.verdict as ReviewVerdict,
    note: row.note,
    repair: row.repair,
    reviewerUserId: row.reviewer_user_id,
    createdAt: row.created_at,
  };
}

export async function addReview(input: {
  projectId: string;
  engagementId: string;
  deliverableId: string;
  criterionKey: string;
  verdict: ReviewVerdict;
  note: string;
  repair: string | null;
  reviewerUserId: string;
}): Promise<HumanWorkReview> {
  const id = newId('hwr');
  await getDb().run(
    `INSERT INTO human_work_reviews
       (id, project_id, engagement_id, deliverable_id, criterion_key, verdict, note, repair,
        reviewer_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.projectId,
      input.engagementId,
      input.deliverableId,
      input.criterionKey,
      input.verdict,
      input.note,
      input.repair,
      input.reviewerUserId,
      nowIso(),
    ],
  );
  const rows = await getDb().all<HumanWorkReviewRow>('SELECT * FROM human_work_reviews WHERE id = ?', [id]);
  return mapReview(rows[0]!);
}

export async function listReviews(engagementId: string): Promise<HumanWorkReview[]> {
  const rows = await getDb().all<HumanWorkReviewRow>(
    'SELECT * FROM human_work_reviews WHERE engagement_id = ? ORDER BY created_at ASC, rowid ASC',
    [engagementId],
  );
  return rows.map(mapReview);
}

function mapCost(row: HumanWorkCostRow): HumanWorkCost {
  return {
    id: row.id,
    projectId: row.project_id,
    engagementId: row.engagement_id,
    kind: row.kind as HumanWorkCost['kind'],
    amountCents: row.amount_cents,
    currency: row.currency,
    hours: row.hours,
    reference: row.reference,
    note: row.note,
    recordedBy: row.recorded_by,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  };
}

/** A cost or a payment, exactly once per key. */
export async function addCost(input: {
  projectId: string;
  engagementId: string;
  kind: 'INCURRED' | 'PAID';
  amountCents: number;
  currency: string;
  hours: number | null;
  reference: string | null;
  note: string | null;
  recordedBy: string;
  idempotencyKey: string;
}): Promise<{ cost: HumanWorkCost; replayed: boolean }> {
  const id = newId('hwk');
  await getDb().run(
    `INSERT INTO human_work_costs
       (id, project_id, engagement_id, kind, amount_cents, currency, hours, reference, note,
        recorded_by, idempotency_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      input.engagementId,
      input.kind,
      Math.trunc(input.amountCents),
      input.currency,
      input.hours,
      input.reference,
      input.note,
      input.recordedBy,
      input.idempotencyKey,
      nowIso(),
    ],
  );
  const rows = await getDb().all<HumanWorkCostRow>(
    'SELECT * FROM human_work_costs WHERE engagement_id = ? AND idempotency_key = ?',
    [input.engagementId, input.idempotencyKey],
  );
  if (!rows[0]) throw new Error('The cost disappeared immediately after being written.');
  return { cost: mapCost(rows[0]), replayed: rows[0].id !== id };
}

export async function listCosts(engagementId: string): Promise<HumanWorkCost[]> {
  const rows = await getDb().all<HumanWorkCostRow>(
    'SELECT * FROM human_work_costs WHERE engagement_id = ? ORDER BY created_at ASC, rowid ASC',
    [engagementId],
  );
  return rows.map(mapCost);
}
