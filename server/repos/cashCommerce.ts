/**
 * Rows for the commercial journey: demand tests, the people asked, what they
 * said, what we owe, and what the payment provider says.
 *
 * Every state change here is a guarded `UPDATE ... WHERE state IN (...)`, so two
 * requests racing one transition produce one move and one ordinary loser — the
 * same compare-and-swap shape the rest of Cash Mode uses. Responses, contacts
 * and obligation events are append-only; nothing here deletes a row.
 */
import { getDb } from '../db/database.ts';
import type { SqlParam } from '../db/types.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';
import type {
  CashDemandContact,
  CashDemandTest,
  CashInvoice,
  CashObligation,
  CashObligationEvent,
  CashResponse,
  DeliveryRoute,
  DemandTestState,
  DemandVerdict,
  InvoiceState,
  NextStepOwner,
  ObligationState,
  ResponseKind,
} from '../domain/commerce.ts';

/** The Brain's clock for this module, named once. */
export function commerceNow(): string {
  return nowIso();
}

type Row = Record<string, unknown>;
const s = (v: unknown): string => String(v);
const n = (v: unknown): number => Number(v);
const sn = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const nn = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}

/* --------------------------------------------------------------------------
 * Demand tests
 * ------------------------------------------------------------------------ */

function mapTest(r: Row): CashDemandTest {
  return {
    id: s(r['id']),
    projectId: s(r['project_id']),
    opportunityId: s(r['opportunity_id']),
    ownerUserId: s(r['owner_user_id']),
    preparedBy: s(r['prepared_by']) as 'BRAIN' | 'PERSON',
    audience: s(r['audience']),
    channel: s(r['channel']),
    offer: s(r['offer']),
    priceCents: nn(r['price_cents']),
    currency: s(r['currency']),
    maxContacts: n(r['max_contacts']),
    maxSpendCents: n(r['max_spend_cents']),
    windowEndsAt: s(r['window_ends_at']),
    continueIfAgreed: n(r['continue_if_agreed']),
    changeIfInterested: n(r['change_if_interested']),
    stopAfterContacts: n(r['stop_after_contacts']),
    draftMessage: s(r['draft_message']),
    basis: s(r['basis']),
    state: s(r['state']) as DemandTestState,
    verdict: sn(r['verdict']) as DemandVerdict | null,
    verdictReason: sn(r['verdict_reason']),
    startedAt: sn(r['started_at']),
    concludedAt: sn(r['concluded_at']),
    createdAt: s(r['created_at']),
    updatedAt: s(r['updated_at']),
  };
}

export interface NewDemandTest {
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
  basis: string;
}

/**
 * Create a PREPARED test, or return the live one this opening already has.
 *
 * The partial unique index on live tests is the arbiter: exactly one caller
 * inserts, and the other reads back the row it collided with.
 */
export async function createDemandTest(
  input: NewDemandTest,
): Promise<{ test: CashDemandTest; created: boolean }> {
  const id = newId('cdt');
  const at = commerceNow();
  await getDb().run(
    `INSERT INTO cash_demand_tests
       (id, project_id, opportunity_id, owner_user_id, prepared_by, audience, channel, offer,
        price_cents, currency, max_contacts, max_spend_cents, window_ends_at,
        continue_if_agreed, change_if_interested, stop_after_contacts, draft_message, basis,
        state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PREPARED', ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      input.opportunityId,
      input.ownerUserId,
      input.preparedBy,
      input.audience,
      input.channel,
      input.offer,
      input.priceCents,
      input.currency,
      input.maxContacts,
      input.maxSpendCents,
      input.windowEndsAt,
      input.continueIfAgreed,
      input.changeIfInterested,
      input.stopAfterContacts,
      input.draftMessage,
      input.basis,
      at,
      at,
    ],
  );
  const live = await liveTestFor(input.opportunityId);
  if (!live) throw new Error('A demand test disappeared immediately after being written.');
  return { test: live, created: live.id === id };
}

export async function getDemandTest(id: string): Promise<CashDemandTest | null> {
  const rows = await getDb().all<Row>('SELECT * FROM cash_demand_tests WHERE id = ?', [id]);
  return rows[0] ? mapTest(rows[0]) : null;
}

export async function liveTestFor(opportunityId: string): Promise<CashDemandTest | null> {
  const rows = await getDb().all<Row>(
    `SELECT * FROM cash_demand_tests
      WHERE opportunity_id = ? AND state IN ('PREPARED', 'RUNNING')`,
    [opportunityId],
  );
  return rows[0] ? mapTest(rows[0]) : null;
}

export async function listDemandTests(projectId: string): Promise<CashDemandTest[]> {
  const rows = await getDb().all<Row>(
    'SELECT * FROM cash_demand_tests WHERE project_id = ? ORDER BY created_at, id',
    [projectId],
  );
  return rows.map(mapTest);
}

export async function transitionDemandTest(input: {
  id: string;
  from: DemandTestState[];
  to: DemandTestState;
  verdict?: DemandVerdict;
  verdictReason?: string;
}): Promise<boolean> {
  const at = commerceNow();
  const params: SqlParam[] = [input.to, at];
  let extra = '';
  if (input.to === 'RUNNING') {
    extra += ', started_at = COALESCE(started_at, ?)';
    params.push(at);
  }
  if (input.to === 'CONCLUDED' || input.to === 'WITHDRAWN') {
    extra += ', verdict = ?, verdict_reason = ?, concluded_at = ?';
    params.push(input.verdict ?? null, input.verdictReason ?? null, at);
  }
  params.push(input.id, ...input.from);
  const result = await getDb().run(
    `UPDATE cash_demand_tests SET state = ?, updated_at = ?${extra}
      WHERE id = ? AND state IN (${placeholders(input.from)})`,
    params,
  );
  return result.changes > 0;
}

/* --------------------------------------------------------------------------
 * Contacts
 * ------------------------------------------------------------------------ */

function mapContact(r: Row): CashDemandContact {
  return {
    id: s(r['id']),
    testId: s(r['test_id']),
    projectId: s(r['project_id']),
    opportunityId: s(r['opportunity_id']),
    actionId: s(r['action_id']),
    recipient: s(r['recipient']),
    sentAt: s(r['sent_at']),
    createdAt: s(r['created_at']),
  };
}

export async function recordContact(input: {
  testId: string;
  projectId: string;
  opportunityId: string;
  actionId: string;
  recipient: string;
  sentAt: string;
}): Promise<{ contact: CashDemandContact; created: boolean }> {
  const id = newId('cdc');
  await getDb().run(
    `INSERT INTO cash_demand_contacts
       (id, test_id, project_id, opportunity_id, action_id, recipient, sent_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (test_id, recipient) DO NOTHING`,
    [id, input.testId, input.projectId, input.opportunityId, input.actionId, input.recipient,
      input.sentAt, commerceNow()],
  );
  const rows = await getDb().all<Row>(
    'SELECT * FROM cash_demand_contacts WHERE test_id = ? AND recipient = ?',
    [input.testId, input.recipient],
  );
  if (!rows[0]) throw new Error('A contact disappeared immediately after being written.');
  return { contact: mapContact(rows[0]), created: s(rows[0]['id']) === id };
}

export async function contactsFor(testId: string): Promise<CashDemandContact[]> {
  const rows = await getDb().all<Row>(
    'SELECT * FROM cash_demand_contacts WHERE test_id = ? ORDER BY sent_at, id',
    [testId],
  );
  return rows.map(mapContact);
}

/* --------------------------------------------------------------------------
 * Responses
 * ------------------------------------------------------------------------ */

function mapResponse(r: Row): CashResponse {
  return {
    id: s(r['id']),
    projectId: s(r['project_id']),
    opportunityId: s(r['opportunity_id']),
    testId: sn(r['test_id']),
    obligationId: sn(r['obligation_id']),
    respondent: s(r['respondent']),
    kind: s(r['kind']) as ResponseKind,
    channel: s(r['channel']),
    reference: s(r['reference']),
    excerpt: s(r['excerpt']),
    receivedAt: s(r['received_at']),
    performedBy: s(r['performed_by']) as 'BRAIN' | 'PERSON',
    recordedBy: s(r['recorded_by']),
    requestKey: s(r['request_key']),
    createdAt: s(r['created_at']),
  };
}

export async function recordResponse(
  input: Omit<CashResponse, 'id' | 'createdAt'>,
): Promise<{ response: CashResponse; created: boolean }> {
  const id = newId('crs');
  await getDb().run(
    `INSERT INTO cash_responses
       (id, project_id, opportunity_id, test_id, obligation_id, respondent, kind, channel,
        reference, excerpt, received_at, performed_by, recorded_by, request_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (project_id, request_key) DO NOTHING`,
    [
      id,
      input.projectId,
      input.opportunityId,
      input.testId,
      input.obligationId,
      input.respondent,
      input.kind,
      input.channel,
      input.reference,
      input.excerpt,
      input.receivedAt,
      input.performedBy,
      input.recordedBy,
      input.requestKey,
      commerceNow(),
    ],
  );
  const rows = await getDb().all<Row>(
    'SELECT * FROM cash_responses WHERE project_id = ? AND request_key = ?',
    [input.projectId, input.requestKey],
  );
  if (!rows[0]) throw new Error('A response disappeared immediately after being written.');
  return { response: mapResponse(rows[0]), created: s(rows[0]['id']) === id };
}

export async function getResponse(id: string): Promise<CashResponse | null> {
  const rows = await getDb().all<Row>('SELECT * FROM cash_responses WHERE id = ?', [id]);
  return rows[0] ? mapResponse(rows[0]) : null;
}

export async function responsesFor(input: {
  projectId: string;
  testId?: string;
  obligationId?: string;
  opportunityId?: string;
}): Promise<CashResponse[]> {
  const where = ['project_id = ?'];
  const params: SqlParam[] = [input.projectId];
  if (input.testId) {
    where.push('test_id = ?');
    params.push(input.testId);
  }
  if (input.obligationId) {
    where.push('obligation_id = ?');
    params.push(input.obligationId);
  }
  if (input.opportunityId) {
    where.push('opportunity_id = ?');
    params.push(input.opportunityId);
  }
  const rows = await getDb().all<Row>(
    `SELECT * FROM cash_responses WHERE ${where.join(' AND ')} ORDER BY received_at, id`,
    params,
  );
  return rows.map(mapResponse);
}

/* --------------------------------------------------------------------------
 * Obligations
 * ------------------------------------------------------------------------ */

function mapObligation(r: Row): CashObligation {
  return {
    id: s(r['id']),
    projectId: s(r['project_id']),
    opportunityId: s(r['opportunity_id']),
    testId: sn(r['test_id']),
    agreementResponseId: sn(r['agreement_response_id']),
    ownerUserId: s(r['owner_user_id']),
    buyer: s(r['buyer']),
    scope: s(r['scope']),
    priceCents: n(r['price_cents']),
    currency: s(r['currency']),
    acceptanceConditions: parseJson<string[]>(sn(r['acceptance_conditions']), []),
    deliveryPlan: s(r['delivery_plan']),
    deliveryRoute: s(r['delivery_route']) as DeliveryRoute,
    requiredResources: parseJson<string[]>(sn(r['required_resources']), []),
    productionReference: sn(r['production_reference']),
    deliverableReference: sn(r['deliverable_reference']),
    state: s(r['state']) as ObligationState,
    revisionCount: n(r['revision_count']),
    nextStep: s(r['next_step']),
    nextStepOwner: s(r['next_step_owner']) as NextStepOwner,
    nextStepDue: sn(r['next_step_due']),
    offerActionId: sn(r['offer_action_id']),
    sentAt: sn(r['sent_at']),
    agreedAt: sn(r['agreed_at']),
    deliveredAt: sn(r['delivered_at']),
    acceptedAt: sn(r['accepted_at']),
    closedAt: sn(r['closed_at']),
    closeReason: sn(r['close_reason']),
    createdAt: s(r['created_at']),
    updatedAt: s(r['updated_at']),
  };
}

export interface NewObligation {
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
  state: 'OFFER_PREPARED' | 'AGREED';
  nextStep: string;
  nextStepOwner: NextStepOwner;
  nextStepDue: string | null;
}

export async function createObligation(input: NewObligation): Promise<CashObligation> {
  const id = newId('cob');
  const at = commerceNow();
  await getDb().run(
    `INSERT INTO cash_obligations
       (id, project_id, opportunity_id, test_id, agreement_response_id, owner_user_id, buyer,
        scope, price_cents, currency, acceptance_conditions, delivery_plan, delivery_route,
        required_resources, state, revision_count, next_step, next_step_owner, next_step_due,
        agreed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.projectId,
      input.opportunityId,
      input.testId,
      input.agreementResponseId,
      input.ownerUserId,
      input.buyer,
      input.scope,
      input.priceCents,
      input.currency,
      toJson(input.acceptanceConditions),
      input.deliveryPlan,
      input.deliveryRoute,
      toJson(input.requiredResources),
      input.state,
      input.nextStep,
      input.nextStepOwner,
      input.nextStepDue,
      input.state === 'AGREED' ? at : null,
      at,
      at,
    ],
  );
  const made = await getObligation(id);
  if (!made) throw new Error('An obligation disappeared immediately after being written.');
  return made;
}

export async function getObligation(id: string): Promise<CashObligation | null> {
  const rows = await getDb().all<Row>('SELECT * FROM cash_obligations WHERE id = ?', [id]);
  return rows[0] ? mapObligation(rows[0]) : null;
}

export async function obligationForAgreement(responseId: string): Promise<CashObligation | null> {
  const rows = await getDb().all<Row>(
    'SELECT * FROM cash_obligations WHERE agreement_response_id = ?',
    [responseId],
  );
  return rows[0] ? mapObligation(rows[0]) : null;
}

export async function listObligations(input: {
  projectId: string;
  opportunityId?: string;
  states?: readonly ObligationState[];
}): Promise<CashObligation[]> {
  if (input.states && input.states.length === 0) return [];
  const where = ['project_id = ?'];
  const params: SqlParam[] = [input.projectId];
  if (input.opportunityId) {
    where.push('opportunity_id = ?');
    params.push(input.opportunityId);
  }
  if (input.states) {
    where.push(`state IN (${placeholders(input.states)})`);
    params.push(...input.states);
  }
  const rows = await getDb().all<Row>(
    `SELECT * FROM cash_obligations WHERE ${where.join(' AND ')} ORDER BY created_at, id`,
    params,
  );
  return rows.map(mapObligation);
}

/**
 * Move an obligation, guarded on the state it was read in, and record why.
 *
 * The patch is applied in the same statement as the state change, so there is
 * no moment in which the state says DELIVERED and the deliverable is missing.
 * The event is written only by the winner.
 */
export async function transitionObligation(input: {
  id: string;
  from: readonly ObligationState[];
  to: ObligationState;
  actorRef: string;
  kind: string;
  evidence: Record<string, unknown>;
  patch?: Partial<{
    agreement_response_id: string;
    offer_action_id: string;
    production_reference: string;
    deliverable_reference: string;
    next_step: string;
    next_step_owner: NextStepOwner;
    next_step_due: string | null;
    sent_at: string;
    agreed_at: string;
    delivered_at: string;
    accepted_at: string;
    closed_at: string;
    close_reason: string;
    revision_count: number;
  }>;
}): Promise<boolean> {
  const at = commerceNow();
  const patch = input.patch ?? {};
  const keys = Object.keys(patch).filter(
    (k) => (patch as Record<string, unknown>)[k] !== undefined,
  );
  const sets = ['state = ?', 'updated_at = ?', ...keys.map((k) => `${k} = ?`)];
  const params: SqlParam[] = [
    input.to,
    at,
    ...keys.map((k) => (patch as Record<string, SqlParam>)[k]!),
    input.id,
    ...input.from,
  ];
  const result = await getDb().run(
    `UPDATE cash_obligations SET ${sets.join(', ')}
      WHERE id = ? AND state IN (${placeholders(input.from)})`,
    params,
  );
  if (result.changes === 0) return false;
  const current = await getObligation(input.id);
  await getDb().run(
    `INSERT INTO cash_obligation_events
       (id, obligation_id, project_id, kind, from_state, to_state, actor_ref, evidence, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId('coe'),
      input.id,
      current!.projectId,
      input.kind,
      input.from.length === 1 ? input.from[0]! : null,
      input.to,
      input.actorRef,
      toJson(input.evidence),
      at,
    ],
  );
  return true;
}

/** Record something that happened to an obligation without changing its state. */
export async function noteObligation(input: {
  obligation: CashObligation;
  kind: string;
  actorRef: string;
  evidence: Record<string, unknown>;
  nextStep?: { step: string; owner: NextStepOwner; due: string | null };
}): Promise<void> {
  const at = commerceNow();
  if (input.nextStep) {
    await getDb().run(
      `UPDATE cash_obligations SET next_step = ?, next_step_owner = ?, next_step_due = ?,
              updated_at = ? WHERE id = ?`,
      [input.nextStep.step, input.nextStep.owner, input.nextStep.due, at, input.obligation.id],
    );
  }
  await getDb().run(
    `INSERT INTO cash_obligation_events
       (id, obligation_id, project_id, kind, from_state, to_state, actor_ref, evidence, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId('coe'),
      input.obligation.id,
      input.obligation.projectId,
      input.kind,
      input.obligation.state,
      input.obligation.state,
      input.actorRef,
      toJson(input.evidence),
      at,
    ],
  );
}

export async function obligationEvents(obligationId: string): Promise<CashObligationEvent[]> {
  const rows = await getDb().all<Row>(
    'SELECT * FROM cash_obligation_events WHERE obligation_id = ? ORDER BY created_at, id',
    [obligationId],
  );
  return rows.map((r) => ({
    id: s(r['id']),
    obligationId: s(r['obligation_id']),
    projectId: s(r['project_id']),
    kind: s(r['kind']),
    fromState: sn(r['from_state']) as ObligationState | null,
    toState: s(r['to_state']) as ObligationState,
    actorRef: s(r['actor_ref']),
    evidence: parseJson<Record<string, unknown>>(sn(r['evidence']), {}),
    createdAt: s(r['created_at']),
  }));
}

/* --------------------------------------------------------------------------
 * Invoices
 * ------------------------------------------------------------------------ */

function mapInvoice(r: Row): CashInvoice {
  return {
    id: s(r['id']),
    projectId: s(r['project_id']),
    obligationId: s(r['obligation_id']),
    opportunityId: s(r['opportunity_id']),
    amountCents: n(r['amount_cents']),
    currency: s(r['currency']),
    provider: s(r['provider']),
    providerReference: s(r['provider_reference']),
    issuedActionId: s(r['issued_action_id']),
    state: s(r['state']) as InvoiceState,
    dueAt: sn(r['due_at']),
    paymentReference: sn(r['payment_reference']),
    paymentEntryId: sn(r['payment_entry_id']),
    settlementReference: sn(r['settlement_reference']),
    settlementEntryId: sn(r['settlement_entry_id']),
    fundsAvailableAt: sn(r['funds_available_at']),
    stateReason: sn(r['state_reason']),
    issuedAt: s(r['issued_at']),
    paidAt: sn(r['paid_at']),
    settledAt: sn(r['settled_at']),
    createdAt: s(r['created_at']),
    updatedAt: s(r['updated_at']),
  };
}

export async function createInvoice(input: {
  projectId: string;
  obligationId: string;
  opportunityId: string;
  amountCents: number;
  currency: string;
  provider: string;
  providerReference: string;
  issuedActionId: string;
  dueAt: string | null;
}): Promise<{ invoice: CashInvoice; created: boolean }> {
  const id = newId('cin');
  const at = commerceNow();
  await getDb().run(
    `INSERT INTO cash_invoices
       (id, project_id, obligation_id, opportunity_id, amount_cents, currency, provider,
        provider_reference, issued_action_id, state, due_at, issued_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ISSUED', ?, ?, ?, ?)
     ON CONFLICT (project_id, provider, provider_reference) DO NOTHING`,
    [id, input.projectId, input.obligationId, input.opportunityId, input.amountCents,
      input.currency, input.provider, input.providerReference, input.issuedActionId,
      input.dueAt, at, at, at],
  );
  const rows = await getDb().all<Row>(
    `SELECT * FROM cash_invoices WHERE project_id = ? AND provider = ? AND provider_reference = ?`,
    [input.projectId, input.provider, input.providerReference],
  );
  if (!rows[0]) throw new Error('An invoice disappeared immediately after being written.');
  return { invoice: mapInvoice(rows[0]), created: s(rows[0]['id']) === id };
}

export async function getInvoice(id: string): Promise<CashInvoice | null> {
  const rows = await getDb().all<Row>('SELECT * FROM cash_invoices WHERE id = ?', [id]);
  return rows[0] ? mapInvoice(rows[0]) : null;
}

export async function listInvoices(input: {
  projectId: string;
  obligationId?: string;
}): Promise<CashInvoice[]> {
  const where = ['project_id = ?'];
  const params: SqlParam[] = [input.projectId];
  if (input.obligationId) {
    where.push('obligation_id = ?');
    params.push(input.obligationId);
  }
  const rows = await getDb().all<Row>(
    `SELECT * FROM cash_invoices WHERE ${where.join(' AND ')} ORDER BY issued_at, id`,
    params,
  );
  return rows.map(mapInvoice);
}

export async function transitionInvoice(input: {
  id: string;
  from: readonly InvoiceState[];
  to: InvoiceState;
  patch?: Partial<{
    payment_reference: string;
    payment_entry_id: string;
    settlement_reference: string;
    settlement_entry_id: string;
    funds_available_at: string | null;
    state_reason: string | null;
    paid_at: string;
    settled_at: string;
  }>;
}): Promise<boolean> {
  if (input.from.length === 0) return false;
  const patch = input.patch ?? {};
  const keys = Object.keys(patch).filter(
    (k) => (patch as Record<string, unknown>)[k] !== undefined,
  );
  const result = await getDb().run(
    `UPDATE cash_invoices SET state = ?, updated_at = ?${keys.map((k) => `, ${k} = ?`).join('')}
      WHERE id = ? AND state IN (${placeholders(input.from)})`,
    [
      input.to,
      commerceNow(),
      ...keys.map((k) => (patch as Record<string, SqlParam>)[k]!),
      input.id,
      ...input.from,
    ],
  );
  return result.changes > 0;
}
