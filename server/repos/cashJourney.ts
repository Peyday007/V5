/**
 * Rows for the first-dollar journey: observations, agreements, invoices,
 * fulfilments and outcomes.
 *
 * Every insert is `ON CONFLICT (project_id, request_key) DO NOTHING` followed
 * by a read-back, so a retry, a restart mid-journey or two ticks racing produce
 * one row — the same shape `cash_money_entries` and `cash_actions` already
 * have. The only mutations are guarded transitions naming the state they come
 * from; nothing here deletes, and an amount is never updated.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso } from './util.ts';
import type {
  AgreementEvidenceKind,
  CashAgreement,
  CashFulfilment,
  CashInvoice,
  CashObservation,
  CashOutcome,
  FulfilmentPath,
  FulfilmentState,
  FulfilmentWorkKind,
  InvoiceState,
  ObservationKind,
  ObservationSource,
  OutcomeKind,
} from '../domain/cashJourney.ts';

type Row = Record<string, unknown>;
const s = (v: unknown): string => String(v);
const ns = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const nn = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export function journeyNow(): string {
  return nowIso();
}

/* ------------------------------------------------------------------------- */
/* Observations                                                               */
/* ------------------------------------------------------------------------- */

function mapObservation(r: Row): CashObservation {
  return {
    id: s(r.id),
    projectId: s(r.project_id),
    opportunityId: s(r.opportunity_id),
    kind: s(r.kind) as ObservationKind,
    source: s(r.source) as ObservationSource,
    channel: ns(r.channel),
    evidenceRef: s(r.evidence_ref),
    amountCents: nn(r.amount_cents),
    currency: ns(r.currency),
    note: ns(r.note),
    observedAt: s(r.observed_at),
    recordedBy: s(r.recorded_by),
    requestKey: s(r.request_key),
    createdAt: s(r.created_at),
  };
}

export async function insertObservation(input: {
  projectId: string;
  opportunityId: string;
  kind: ObservationKind;
  source: ObservationSource;
  channel?: string | null;
  evidenceRef: string;
  amountCents?: number | null;
  currency?: string | null;
  note?: string | null;
  observedAt?: string;
  recordedBy: string;
  requestKey: string;
}): Promise<{ row: CashObservation; created: boolean }> {
  const id = newId('cob');
  const at = journeyNow();
  await getDb().run(
    `INSERT INTO cash_observations
       (id, project_id, opportunity_id, kind, source, channel, evidence_ref, amount_cents,
        currency, note, observed_at, recorded_by, request_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (project_id, request_key) DO NOTHING`,
    [
      id,
      input.projectId,
      input.opportunityId,
      input.kind,
      input.source,
      input.channel ?? null,
      input.evidenceRef,
      input.amountCents ?? null,
      input.currency ?? null,
      input.note ?? null,
      input.observedAt ?? at,
      input.recordedBy,
      input.requestKey,
      at,
    ],
  );
  const row = await getDb().get<Row>(
    'SELECT * FROM cash_observations WHERE project_id = ? AND request_key = ?',
    [input.projectId, input.requestKey],
  );
  return { row: mapObservation(row!), created: s(row!.id) === id };
}

export async function observationsFor(opportunityId: string): Promise<CashObservation[]> {
  const rows = await getDb().all<Row>(
    'SELECT * FROM cash_observations WHERE opportunity_id = ? ORDER BY observed_at, created_at, id',
    [opportunityId],
  );
  return rows.map(mapObservation);
}

export async function getObservation(id: string): Promise<CashObservation | null> {
  const row = await getDb().get<Row>('SELECT * FROM cash_observations WHERE id = ?', [id]);
  return row ? mapObservation(row) : null;
}

/* ------------------------------------------------------------------------- */
/* Agreements                                                                 */
/* ------------------------------------------------------------------------- */

function mapAgreement(r: Row): CashAgreement {
  return {
    id: s(r.id),
    projectId: s(r.project_id),
    opportunityId: s(r.opportunity_id),
    amountCents: Number(r.amount_cents),
    currency: s(r.currency),
    deliverable: s(r.deliverable),
    acceptanceCondition: s(r.acceptance_condition),
    evidenceKind: s(r.evidence_kind) as AgreementEvidenceKind,
    evidenceRef: s(r.evidence_ref),
    observationId: ns(r.observation_id),
    state: s(r.state) as CashAgreement['state'],
    releasedReason: ns(r.released_reason),
    releasedBy: ns(r.released_by),
    releasedAt: ns(r.released_at),
    requestKey: s(r.request_key),
    recordedBy: s(r.recorded_by),
    createdAt: s(r.created_at),
    updatedAt: s(r.updated_at),
  };
}

export async function insertAgreement(input: {
  projectId: string;
  opportunityId: string;
  amountCents: number;
  currency: string;
  deliverable: string;
  acceptanceCondition: string;
  evidenceKind: AgreementEvidenceKind;
  evidenceRef: string;
  observationId?: string | null;
  recordedBy: string;
  requestKey: string;
}): Promise<{ row: CashAgreement; created: boolean }> {
  const id = newId('cag');
  const at = journeyNow();
  await getDb().run(
    `INSERT INTO cash_agreements
       (id, project_id, opportunity_id, amount_cents, currency, deliverable,
        acceptance_condition, evidence_kind, evidence_ref, observation_id, state,
        request_key, recorded_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'AGREED', ?, ?, ?, ?)
     ON CONFLICT (project_id, request_key) DO NOTHING`,
    [
      id,
      input.projectId,
      input.opportunityId,
      input.amountCents,
      input.currency,
      input.deliverable,
      input.acceptanceCondition,
      input.evidenceKind,
      input.evidenceRef,
      input.observationId ?? null,
      input.requestKey,
      input.recordedBy,
      at,
      at,
    ],
  );
  const row = await getDb().get<Row>(
    'SELECT * FROM cash_agreements WHERE project_id = ? AND request_key = ?',
    [input.projectId, input.requestKey],
  );
  return { row: mapAgreement(row!), created: s(row!.id) === id };
}

export async function agreementsFor(opportunityId: string): Promise<CashAgreement[]> {
  const rows = await getDb().all<Row>(
    'SELECT * FROM cash_agreements WHERE opportunity_id = ? ORDER BY created_at, id',
    [opportunityId],
  );
  return rows.map(mapAgreement);
}

export async function getAgreement(id: string): Promise<CashAgreement | null> {
  const row = await getDb().get<Row>('SELECT * FROM cash_agreements WHERE id = ?', [id]);
  return row ? mapAgreement(row) : null;
}

/** AGREED → RELEASED, guarded; false when somebody else already released it. */
export async function releaseAgreementRow(input: {
  id: string;
  reason: string;
  by: string;
}): Promise<boolean> {
  const at = journeyNow();
  const res = await getDb().run(
    `UPDATE cash_agreements
        SET state = 'RELEASED', released_reason = ?, released_by = ?, released_at = ?, updated_at = ?
      WHERE id = ? AND state = 'AGREED'`,
    [input.reason, input.by, at, at, input.id],
  );
  return res.changes === 1;
}

/* ------------------------------------------------------------------------- */
/* Invoices                                                                   */
/* ------------------------------------------------------------------------- */

function mapInvoice(r: Row): CashInvoice {
  return {
    id: s(r.id),
    projectId: s(r.project_id),
    opportunityId: s(r.opportunity_id),
    agreementId: s(r.agreement_id),
    amountCents: Number(r.amount_cents),
    currency: s(r.currency),
    issuedBy: s(r.issued_by) as CashInvoice['issuedBy'],
    providerRef: s(r.provider_ref),
    operationId: ns(r.operation_id),
    dueAt: ns(r.due_at),
    state: s(r.state) as InvoiceState,
    stateReason: ns(r.state_reason),
    requestKey: s(r.request_key),
    recordedBy: s(r.recorded_by),
    createdAt: s(r.created_at),
    updatedAt: s(r.updated_at),
  };
}

export async function insertInvoice(input: {
  projectId: string;
  opportunityId: string;
  agreementId: string;
  amountCents: number;
  currency: string;
  issuedBy: 'BRAIN' | 'PERSON';
  providerRef: string;
  operationId?: string | null;
  dueAt?: string | null;
  recordedBy: string;
  requestKey: string;
}): Promise<{ row: CashInvoice; created: boolean }> {
  const id = newId('cin');
  const at = journeyNow();
  await getDb().run(
    `INSERT INTO cash_invoices
       (id, project_id, opportunity_id, agreement_id, amount_cents, currency, issued_by,
        provider_ref, operation_id, due_at, state, request_key, recorded_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ISSUED', ?, ?, ?, ?)
     ON CONFLICT (project_id, request_key) DO NOTHING`,
    [
      id,
      input.projectId,
      input.opportunityId,
      input.agreementId,
      input.amountCents,
      input.currency,
      input.issuedBy,
      input.providerRef,
      input.operationId ?? null,
      input.dueAt ?? null,
      input.requestKey,
      input.recordedBy,
      at,
      at,
    ],
  );
  const row = await getDb().get<Row>(
    'SELECT * FROM cash_invoices WHERE project_id = ? AND request_key = ?',
    [input.projectId, input.requestKey],
  );
  return { row: mapInvoice(row!), created: s(row!.id) === id };
}

export async function invoicesFor(opportunityId: string): Promise<CashInvoice[]> {
  const rows = await getDb().all<Row>(
    'SELECT * FROM cash_invoices WHERE opportunity_id = ? ORDER BY created_at, id',
    [opportunityId],
  );
  return rows.map(mapInvoice);
}

export async function getInvoice(id: string): Promise<CashInvoice | null> {
  const row = await getDb().get<Row>('SELECT * FROM cash_invoices WHERE id = ?', [id]);
  return row ? mapInvoice(row) : null;
}

/** ISSUED → VOID | EXPIRED, guarded on ISSUED. */
export async function closeInvoiceRow(input: {
  id: string;
  to: 'VOID' | 'EXPIRED';
  reason: string;
}): Promise<boolean> {
  const res = await getDb().run(
    `UPDATE cash_invoices SET state = ?, state_reason = ?, updated_at = ?
      WHERE id = ? AND state = 'ISSUED'`,
    [input.to, input.reason, journeyNow(), input.id],
  );
  return res.changes === 1;
}

/* ------------------------------------------------------------------------- */
/* Fulfilments                                                                */
/* ------------------------------------------------------------------------- */

function mapFulfilment(r: Row): CashFulfilment {
  return {
    id: s(r.id),
    projectId: s(r.project_id),
    opportunityId: s(r.opportunity_id),
    agreementId: s(r.agreement_id),
    path: s(r.path) as FulfilmentPath,
    workKind: s(r.work_kind) as FulfilmentWorkKind,
    workRef: s(r.work_ref),
    commitmentId: ns(r.commitment_id),
    state: s(r.state) as FulfilmentState,
    performedEvidence: ns(r.performed_evidence),
    acceptedObservationId: ns(r.accepted_observation_id),
    acceptanceEvidence: ns(r.acceptance_evidence),
    stateReason: ns(r.state_reason),
    requestKey: s(r.request_key),
    createdBy: s(r.created_by),
    createdAt: s(r.created_at),
    performedAt: ns(r.performed_at),
    deliveredAt: ns(r.delivered_at),
    endedAt: ns(r.ended_at),
    updatedAt: s(r.updated_at),
  };
}

export async function insertFulfilment(input: {
  projectId: string;
  opportunityId: string;
  agreementId: string;
  path: FulfilmentPath;
  workKind: FulfilmentWorkKind;
  workRef: string;
  commitmentId?: string | null;
  createdBy: string;
  requestKey: string;
}): Promise<{ row: CashFulfilment; created: boolean }> {
  const id = newId('cfu');
  const at = journeyNow();
  await getDb().run(
    `INSERT INTO cash_fulfilments
       (id, project_id, opportunity_id, agreement_id, path, work_kind, work_ref, commitment_id,
        state, request_key, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'CREATED', ?, ?, ?, ?)
     ON CONFLICT (project_id, request_key) DO NOTHING`,
    [
      id,
      input.projectId,
      input.opportunityId,
      input.agreementId,
      input.path,
      input.workKind,
      input.workRef,
      input.commitmentId ?? null,
      input.requestKey,
      input.createdBy,
      at,
      at,
    ],
  );
  const row = await getDb().get<Row>(
    'SELECT * FROM cash_fulfilments WHERE project_id = ? AND request_key = ?',
    [input.projectId, input.requestKey],
  );
  return { row: mapFulfilment(row!), created: s(row!.id) === id };
}

export async function fulfilmentsFor(opportunityId: string): Promise<CashFulfilment[]> {
  const rows = await getDb().all<Row>(
    'SELECT * FROM cash_fulfilments WHERE opportunity_id = ? ORDER BY created_at, id',
    [opportunityId],
  );
  return rows.map(mapFulfilment);
}

export async function getFulfilment(id: string): Promise<CashFulfilment | null> {
  const row = await getDb().get<Row>('SELECT * FROM cash_fulfilments WHERE id = ?', [id]);
  return row ? mapFulfilment(row) : null;
}

/** CREATED → PERFORMED with the evidence, guarded. */
export async function markFulfilmentPerformed(id: string, evidence: string): Promise<boolean> {
  const at = journeyNow();
  const res = await getDb().run(
    `UPDATE cash_fulfilments
        SET state = 'PERFORMED', performed_evidence = ?, performed_at = ?, updated_at = ?
      WHERE id = ? AND state = 'CREATED'`,
    [evidence, at, at, id],
  );
  return res.changes === 1;
}

/** PERFORMED → DELIVERED with acceptance evidence, guarded. */
export async function markFulfilmentDelivered(input: {
  id: string;
  observationId?: string | null;
  evidence?: string | null;
}): Promise<boolean> {
  const at = journeyNow();
  const res = await getDb().run(
    `UPDATE cash_fulfilments
        SET state = 'DELIVERED', accepted_observation_id = ?, acceptance_evidence = ?,
            delivered_at = ?, ended_at = ?, updated_at = ?
      WHERE id = ? AND state = 'PERFORMED'`,
    [input.observationId ?? null, input.evidence ?? null, at, at, at, input.id],
  );
  return res.changes === 1;
}

/** CREATED | PERFORMED → FAILED | CANCELLED, guarded. */
export async function endFulfilment(input: {
  id: string;
  to: 'FAILED' | 'CANCELLED';
  reason: string;
}): Promise<boolean> {
  const at = journeyNow();
  const res = await getDb().run(
    `UPDATE cash_fulfilments SET state = ?, state_reason = ?, ended_at = ?, updated_at = ?
      WHERE id = ? AND state IN ('CREATED', 'PERFORMED')`,
    [input.to, input.reason, at, at, input.id],
  );
  return res.changes === 1;
}

/* ------------------------------------------------------------------------- */
/* Outcomes                                                                   */
/* ------------------------------------------------------------------------- */

function mapOutcome(r: Row): CashOutcome {
  return {
    id: s(r.id),
    projectId: s(r.project_id),
    opportunityId: s(r.opportunity_id),
    kind: s(r.kind) as OutcomeKind,
    mechanism: ns(r.mechanism),
    channel: ns(r.channel),
    valueCents: nn(r.value_cents),
    valueMs: nn(r.value_ms),
    valueText: ns(r.value_text),
    currency: ns(r.currency),
    basis: s(r.basis),
    requestKey: s(r.request_key),
    createdAt: s(r.created_at),
  };
}

export async function insertOutcome(input: {
  projectId: string;
  opportunityId: string;
  kind: OutcomeKind;
  mechanism?: string | null;
  channel?: string | null;
  valueCents?: number | null;
  valueMs?: number | null;
  valueText?: string | null;
  currency?: string | null;
  basis: string;
  requestKey: string;
}): Promise<boolean> {
  const id = newId('cou');
  await getDb().run(
    `INSERT INTO cash_outcomes
       (id, project_id, opportunity_id, kind, mechanism, channel, value_cents, value_ms,
        value_text, currency, basis, request_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (project_id, request_key) DO NOTHING`,
    [
      id,
      input.projectId,
      input.opportunityId,
      input.kind,
      input.mechanism ?? null,
      input.channel ?? null,
      input.valueCents ?? null,
      input.valueMs ?? null,
      input.valueText ?? null,
      input.currency ?? null,
      input.basis,
      input.requestKey,
      journeyNow(),
    ],
  );
  const row = await getDb().get<Row>(
    'SELECT id FROM cash_outcomes WHERE project_id = ? AND request_key = ?',
    [input.projectId, input.requestKey],
  );
  return s(row?.id) === id;
}

export async function outcomesFor(input: {
  projectId: string;
  opportunityId?: string;
}): Promise<CashOutcome[]> {
  const rows = input.opportunityId
    ? await getDb().all<Row>(
        'SELECT * FROM cash_outcomes WHERE project_id = ? AND opportunity_id = ? ORDER BY created_at, id',
        [input.projectId, input.opportunityId],
      )
    : await getDb().all<Row>(
        'SELECT * FROM cash_outcomes WHERE project_id = ? ORDER BY created_at, id',
        [input.projectId],
      );
  return rows.map(mapOutcome);
}

/** Opportunities in a project that have any journey row, for the tick. */
export async function opportunitiesInJourney(projectId: string): Promise<string[]> {
  const rows = await getDb().all<{ opportunity_id: string }>(
    `SELECT DISTINCT opportunity_id FROM cash_agreements WHERE project_id = ?
     UNION SELECT DISTINCT opportunity_id FROM cash_observations WHERE project_id = ?`,
    [projectId, projectId],
  );
  return rows.map((one) => one.opportunity_id);
}

export async function agreementsInProject(projectId: string): Promise<CashAgreement[]> {
  const rows = await getDb().all<Row>(
    'SELECT * FROM cash_agreements WHERE project_id = ? ORDER BY created_at, id',
    [projectId],
  );
  return rows.map(mapAgreement);
}

export async function fulfilmentsInProject(projectId: string): Promise<CashFulfilment[]> {
  const rows = await getDb().all<Row>(
    'SELECT * FROM cash_fulfilments WHERE project_id = ? ORDER BY created_at, id',
    [projectId],
  );
  return rows.map(mapFulfilment);
}

export async function issuedInvoicesInProject(projectId: string): Promise<CashInvoice[]> {
  const rows = await getDb().all<Row>(
    "SELECT * FROM cash_invoices WHERE project_id = ? AND state = 'ISSUED' ORDER BY created_at, id",
    [projectId],
  );
  return rows.map(mapInvoice);
}
