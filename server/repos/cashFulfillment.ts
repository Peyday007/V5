/**
 * Obligations, what happened to them, and what they taught — as rows.
 *
 * No state column and no figure. Where an obligation stands is derived by
 * `services/cash/fulfillment.ts` from these rows, the money ledger and the
 * work they point at; money lives in `cash_money_entries` and nowhere else.
 *
 * Every write here is idempotent by a key the service builds from server facts,
 * in the shape every idempotent write in this repository takes: insert with
 * `ON CONFLICT DO NOTHING`, read back by the key, and say whether this call is
 * the one that wrote it. The arbiter is the unique index, so a retry after a
 * lost response, a restart mid-pass and two ticks at once are one outcome.
 *
 * Nothing here deletes. Events and observations have no update either.
 */
import { getDb } from '../db/database.ts';
import type { SqlParam } from '../db/types.ts';
import { newId, nowIso } from './util.ts';
import type {
  CashFulfillment,
  CashFulfillmentEvent,
  CashFulfillmentEventRow,
  CashFulfillmentRow,
  CashOutcomeObservation,
  CashOutcomeObservationRow,
  FulfillmentEventKind,
  FulfillmentKind,
  Outcome,
  OutcomeObservationKind,
} from '../domain/cashFulfillment.ts';

function parseScope(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((one): one is string => typeof one === 'string') : [];
  } catch {
    return [];
  }
}

function mapFulfillment(row: CashFulfillmentRow): CashFulfillment {
  return {
    id: row.id,
    projectId: row.project_id,
    opportunityId: row.opportunity_id,
    kind: row.kind as FulfillmentKind,
    promise: row.promise,
    performer: row.performer,
    acceptanceCondition: row.acceptance_condition,
    repositoryRemote: row.repository_remote,
    repositoryRoot: row.repository_root,
    baseBranch: row.base_branch,
    mutationScope: parseScope(row.mutation_scope),
    supplierName: row.supplier_name,
    workRef: row.work_ref,
    workCreatedAt: row.work_created_at,
    declaredBy: row.declared_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEvent(row: CashFulfillmentEventRow): CashFulfillmentEvent {
  return {
    id: row.id,
    projectId: row.project_id,
    fulfillmentId: row.fulfillment_id,
    opportunityId: row.opportunity_id,
    kind: row.kind as FulfillmentEventKind,
    detail: row.detail,
    evidenceRef: row.evidence_ref,
    amountCents: row.amount_cents === null ? null : Number(row.amount_cents),
    refundKey: row.refund_key,
    recordedBy: row.recorded_by,
    requestKey: row.request_key,
    createdAt: row.created_at,
  };
}

function mapObservation(row: CashOutcomeObservationRow): CashOutcomeObservation {
  return {
    id: row.id,
    projectId: row.project_id,
    opportunityId: row.opportunity_id,
    fulfillmentId: row.fulfillment_id,
    mechanism: row.mechanism,
    fulfillmentKind: row.fulfillment_kind as FulfillmentKind,
    outcome: row.outcome as Outcome,
    kind: row.kind as OutcomeObservationKind,
    valueText: row.value_text,
    valueNumber: row.value_number === null ? null : Number(row.value_number),
    currency: row.currency,
    requestKey: row.request_key,
    observedAt: row.observed_at,
  };
}

export interface FulfillmentDeclaration {
  projectId: string;
  opportunityId: string;
  kind: FulfillmentKind;
  promise: string;
  performer: string;
  acceptanceCondition: string | null;
  repositoryRemote?: string | null;
  repositoryRoot?: string | null;
  baseBranch?: string | null;
  mutationScope?: string[];
  supplierName?: string | null;
  declaredBy: string;
}

/**
 * Declare how an obligation is fulfilled, or revise it while nothing exists yet.
 *
 * One row per opportunity, by the unique index. A revision is accepted only
 * while no work has been created for it — guarded on `work_ref IS NULL AND
 * work_created_at IS NULL` in the statement that makes the change — because
 * once a Factory objective or a research idea exists, the promise it was built
 * from is the one that was made, and rewriting it underneath the work would
 * leave the work answering a question nobody asks any more.
 */
export async function declareFulfillment(
  input: FulfillmentDeclaration,
): Promise<{ fulfillment: CashFulfillment; created: boolean; revised: boolean }> {
  const id = newId('cff');
  const at = nowIso();
  const scope = JSON.stringify(input.mutationScope ?? []);
  await getDb().run(
    `INSERT INTO cash_fulfillments
       (id, project_id, opportunity_id, kind, promise, performer, acceptance_condition,
        repository_remote, repository_root, base_branch, mutation_scope, supplier_name,
        work_ref, work_created_at, declared_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)
     ON CONFLICT (project_id, opportunity_id) DO NOTHING`,
    [
      id,
      input.projectId,
      input.opportunityId,
      input.kind,
      input.promise,
      input.performer,
      input.acceptanceCondition,
      input.repositoryRemote ?? null,
      input.repositoryRoot ?? null,
      input.baseBranch ?? null,
      scope,
      input.supplierName ?? null,
      input.declaredBy,
      at,
      at,
    ],
  );
  const existing = await fulfillmentForOpportunity(input.projectId, input.opportunityId);
  if (!existing) throw new Error('The fulfillment disappeared immediately after being written.');
  if (existing.id === id) return { fulfillment: existing, created: true, revised: false };

  const result = await getDb().run(
    `UPDATE cash_fulfillments
        SET kind = ?, promise = ?, performer = ?, acceptance_condition = ?,
            repository_remote = ?, repository_root = ?, base_branch = ?, mutation_scope = ?,
            supplier_name = ?, declared_by = ?, updated_at = ?
      WHERE id = ? AND work_ref IS NULL AND work_created_at IS NULL`,
    [
      input.kind,
      input.promise,
      input.performer,
      input.acceptanceCondition,
      input.repositoryRemote ?? null,
      input.repositoryRoot ?? null,
      input.baseBranch ?? null,
      scope,
      input.supplierName ?? null,
      input.declaredBy,
      at,
      existing.id,
    ],
  );
  const after = await getFulfillment(existing.id);
  return { fulfillment: after!, created: false, revised: (result.changes ?? 0) === 1 };
}

/**
 * Supply the acceptance condition an obligation was declared without.
 *
 * The one field that may still be filled after work exists, and only from
 * empty: a condition nobody stated cannot have been built against, and one
 * somebody stated may not be quietly replaced.
 */
export async function supplyAcceptanceCondition(id: string, condition: string): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE cash_fulfillments SET acceptance_condition = ?, updated_at = ?
      WHERE id = ? AND acceptance_condition IS NULL`,
    [condition, nowIso(), id],
  );
  return (result.changes ?? 0) === 1;
}

export async function getFulfillment(id: string): Promise<CashFulfillment | null> {
  const row = await getDb().get<CashFulfillmentRow>('SELECT * FROM cash_fulfillments WHERE id = ?', [id]);
  return row ? mapFulfillment(row) : null;
}

export async function fulfillmentForOpportunity(
  projectId: string,
  opportunityId: string,
): Promise<CashFulfillment | null> {
  const row = await getDb().get<CashFulfillmentRow>(
    'SELECT * FROM cash_fulfillments WHERE project_id = ? AND opportunity_id = ?',
    [projectId, opportunityId],
  );
  return row ? mapFulfillment(row) : null;
}

export async function listFulfillments(projectId: string): Promise<CashFulfillment[]> {
  const rows = await getDb().all<CashFulfillmentRow>(
    'SELECT * FROM cash_fulfillments WHERE project_id = ? ORDER BY created_at, id',
    [projectId],
  );
  return rows.map(mapFulfillment);
}

/**
 * Record the work Brain created for an obligation, exactly once.
 *
 * Guarded on both columns still being null: the one value meaning nobody has
 * created work yet, and never what a winner leaves behind — §34's correction at
 * the probe claim. `workRef` is null for `PERSON` and `SUPPLIER` work, where the
 * obligation itself is the work and only the moment it was opened is recorded.
 */
export async function claimFulfillmentWork(id: string, workRef: string | null): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE cash_fulfillments SET work_ref = ?, work_created_at = ?, updated_at = ?
      WHERE id = ? AND work_ref IS NULL AND work_created_at IS NULL`,
    [workRef, nowIso(), nowIso(), id],
  );
  return (result.changes ?? 0) === 1;
}

export interface NewFulfillmentEvent {
  projectId: string;
  fulfillmentId: string;
  opportunityId: string;
  kind: FulfillmentEventKind;
  detail: string;
  evidenceRef?: string | null;
  amountCents?: number | null;
  refundKey?: string | null;
  recordedBy: string;
  requestKey: string;
}

export async function recordFulfillmentEvent(
  input: NewFulfillmentEvent,
): Promise<{ event: CashFulfillmentEvent; created: boolean }> {
  const id = newId('cfe');
  const params: SqlParam[] = [
    id,
    input.projectId,
    input.fulfillmentId,
    input.opportunityId,
    input.kind,
    input.detail,
    input.evidenceRef ?? null,
    input.amountCents ?? null,
    input.refundKey ?? null,
    input.recordedBy,
    input.requestKey,
    nowIso(),
  ];
  await getDb().run(
    `INSERT INTO cash_fulfillment_events
       (id, project_id, fulfillment_id, opportunity_id, kind, detail, evidence_ref,
        amount_cents, refund_key, recorded_by, request_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (fulfillment_id, request_key) DO NOTHING`,
    params,
  );
  const row = await getDb().get<CashFulfillmentEventRow>(
    'SELECT * FROM cash_fulfillment_events WHERE fulfillment_id = ? AND request_key = ?',
    [input.fulfillmentId, input.requestKey],
  );
  if (!row) throw new Error('The fulfillment event disappeared immediately after being written.');
  return { event: mapEvent(row), created: row.id === id };
}

/** Everything that happened to one obligation, in the order it was recorded. */
export async function fulfillmentEvents(fulfillmentId: string): Promise<CashFulfillmentEvent[]> {
  const rows = await getDb().all<CashFulfillmentEventRow>(
    // Insertion order, not the clock: two events in one millisecond are still
    // two events in an order, and a redelivery after a rejection must read as
    // after it. `rowid` is rewritten to `seq` on Postgres, which this table has.
    'SELECT * FROM cash_fulfillment_events WHERE fulfillment_id = ? ORDER BY rowid',
    [fulfillmentId],
  );
  return rows.map(mapEvent);
}

export interface NewObservation {
  projectId: string;
  opportunityId: string;
  fulfillmentId: string;
  mechanism: string;
  fulfillmentKind: FulfillmentKind;
  outcome: Outcome;
  kind: OutcomeObservationKind;
  valueText: string;
  valueNumber?: number | null;
  currency?: string | null;
  requestKey: string;
}

export async function recordObservation(input: NewObservation): Promise<boolean> {
  const id = newId('cob');
  await getDb().run(
    `INSERT INTO cash_outcome_observations
       (id, project_id, opportunity_id, fulfillment_id, mechanism, fulfillment_kind, outcome,
        kind, value_text, value_number, currency, request_key, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (project_id, request_key) DO NOTHING`,
    [
      id,
      input.projectId,
      input.opportunityId,
      input.fulfillmentId,
      input.mechanism,
      input.fulfillmentKind,
      input.outcome,
      input.kind,
      input.valueText,
      input.valueNumber ?? null,
      input.currency ?? null,
      input.requestKey,
      nowIso(),
    ],
  );
  const row = await getDb().get<{ id: string }>(
    'SELECT id FROM cash_outcome_observations WHERE project_id = ? AND request_key = ?',
    [input.projectId, input.requestKey],
  );
  return row?.id === id;
}

export async function listObservations(input: {
  projectId: string;
  mechanism?: string;
  opportunityId?: string;
}): Promise<CashOutcomeObservation[]> {
  const where = ['project_id = ?'];
  const params: SqlParam[] = [input.projectId];
  if (input.mechanism) {
    where.push('mechanism = ?');
    params.push(input.mechanism);
  }
  if (input.opportunityId) {
    where.push('opportunity_id = ?');
    params.push(input.opportunityId);
  }
  const rows = await getDb().all<CashOutcomeObservationRow>(
    `SELECT * FROM cash_outcome_observations WHERE ${where.join(' AND ')}
      ORDER BY rowid`,
    params,
  );
  return rows.map(mapObservation);
}
