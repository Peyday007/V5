/**
 * Rows for a deal around its agreement: observations, agreements and outcomes.
 * The obligation an agreement creates is `cashFulfillment.ts`; invoices are
 * `cashInvoices.ts`.
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
  CashObservation,
  CashOutcome,
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
