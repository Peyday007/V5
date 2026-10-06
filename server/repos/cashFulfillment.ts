/**
 * Obligations and what happened to them — as rows.
 *
 * No state column and no figure. Where an obligation stands is derived by
 * `services/cash/journey/fulfillment.ts` from these rows, its agreement, the
 * money ledger and the work they point at; money lives in `cash_money_entries`
 * and nowhere else.
 *
 * Every write here is idempotent by a key the service builds from server facts:
 * insert with `ON CONFLICT DO NOTHING`, read back by the key, and say whether
 * this call is the one that wrote it. The arbiter is the unique index, so a
 * retry after a lost response, a restart mid-pass and two ticks at once are one
 * outcome. Nothing here deletes, and events have no update.
 */
import { getDb } from '../db/database.ts';
import type { SqlParam } from '../db/types.ts';
import { newId, nowIso } from './util.ts';
import type {
  CashFulfillment,
  CashFulfillmentEvent,
  CashFulfillmentEventRow,
  CashFulfillmentRow,
  FulfillmentEventKind,
  FulfillmentKind,
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
    agreementId: row.agreement_id,
    kind: row.kind as FulfillmentKind,
    performer: row.performer,
    repositoryRemote: row.repository_remote,
    repositoryRoot: row.repository_root,
    baseBranch: row.base_branch,
    mutationScope: parseScope(row.mutation_scope),
    supplierName: row.supplier_name,
    workRef: row.work_ref,
    workCreatedAt: row.work_created_at,
    workAttempt: Number(row.work_attempt ?? 0),
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

export interface FulfillmentDeclaration {
  projectId: string;
  opportunityId: string;
  agreementId: string;
  kind: FulfillmentKind;
  performer: string;
  repositoryRemote?: string | null;
  repositoryRoot?: string | null;
  baseBranch?: string | null;
  mutationScope?: string[];
  supplierName?: string | null;
  declaredBy: string;
}

/**
 * Declare how an agreement is fulfilled, or revise it while nothing exists yet.
 *
 * One row per agreement, by the unique index. A revision is accepted only while
 * no work has been created and nothing has been recorded against it — guarded
 * in the statement that makes the change — because once a Factory objective or
 * a research idea exists, the declaration it was built from is the one made.
 */
export async function declareFulfillment(
  input: FulfillmentDeclaration,
): Promise<{ fulfillment: CashFulfillment; created: boolean; revised: boolean }> {
  const id = newId('cff');
  const at = nowIso();
  const scope = JSON.stringify(input.mutationScope ?? []);
  await getDb().run(
    `INSERT INTO cash_fulfillments
       (id, project_id, opportunity_id, agreement_id, kind, performer,
        repository_remote, repository_root, base_branch, mutation_scope, supplier_name,
        work_ref, work_created_at, work_attempt, declared_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?, ?)
     ON CONFLICT (agreement_id) DO NOTHING`,
    [
      id,
      input.projectId,
      input.opportunityId,
      input.agreementId,
      input.kind,
      input.performer,
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
  const existing = await fulfillmentForAgreement(input.agreementId);
  if (!existing) throw new Error('The fulfillment disappeared immediately after being written.');
  if (existing.id === id) return { fulfillment: existing, created: true, revised: false };

  const result = await getDb().run(
    `UPDATE cash_fulfillments
        SET kind = ?, performer = ?, repository_remote = ?, repository_root = ?, base_branch = ?,
            mutation_scope = ?, supplier_name = ?, declared_by = ?, updated_at = ?
      WHERE id = ? AND work_ref IS NULL AND work_created_at IS NULL AND work_attempt = 0
        AND NOT EXISTS (SELECT 1 FROM cash_fulfillment_events e WHERE e.fulfillment_id = cash_fulfillments.id)`,
    [
      input.kind,
      input.performer,
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

export async function getFulfillment(id: string): Promise<CashFulfillment | null> {
  const row = await getDb().get<CashFulfillmentRow>('SELECT * FROM cash_fulfillments WHERE id = ?', [id]);
  return row ? mapFulfillment(row) : null;
}

export async function fulfillmentForAgreement(agreementId: string): Promise<CashFulfillment | null> {
  const row = await getDb().get<CashFulfillmentRow>(
    'SELECT * FROM cash_fulfillments WHERE agreement_id = ?',
    [agreementId],
  );
  return row ? mapFulfillment(row) : null;
}

export async function fulfillmentsForOpportunity(
  projectId: string,
  opportunityId: string,
): Promise<CashFulfillment[]> {
  const rows = await getDb().all<CashFulfillmentRow>(
    'SELECT * FROM cash_fulfillments WHERE project_id = ? AND opportunity_id = ? ORDER BY created_at, id',
    [projectId, opportunityId],
  );
  return rows.map(mapFulfillment);
}

export async function listFulfillments(projectId: string): Promise<CashFulfillment[]> {
  const rows = await getDb().all<CashFulfillmentRow>(
    'SELECT * FROM cash_fulfillments WHERE project_id = ? ORDER BY created_at, id',
    [projectId],
  );
  return rows.map(mapFulfillment);
}

/**
 * Record the work Brain created for an obligation, exactly once per attempt.
 *
 * Guarded on both columns still being null — the one value meaning nobody has
 * created work for this attempt, and never what a winner leaves behind (§34's
 * correction at the probe claim) — and on the attempt the caller built the work
 * for, so work created for a superseded attempt is never claimed. `workRef` is
 * null for `PERSON` and `SUPPLIER` work, where the obligation is the work.
 */
export async function claimFulfillmentWork(
  id: string,
  workRef: string | null,
  attempt: number,
): Promise<boolean> {
  const at = nowIso();
  const result = await getDb().run(
    `UPDATE cash_fulfillments SET work_ref = ?, work_created_at = ?, updated_at = ?
      WHERE id = ? AND work_ref IS NULL AND work_created_at IS NULL AND work_attempt = ?`,
    [workRef, at, at, id, attempt],
  );
  return (result.changes ?? 0) === 1;
}

/**
 * Give back work that failed, so the tick creates the next attempt.
 *
 * One statement releases the pointer and advances the attempt, guarded on the
 * work and the attempt the caller read: two people retrying at once release it
 * once, and the attempt number can never fall back onto a failed attempt's
 * Factory key. The failed work keeps its own rows wherever it lives.
 */
export async function releaseFulfillmentWork(id: string, workRef: string, attempt: number): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE cash_fulfillments
        SET work_ref = NULL, work_created_at = NULL, work_attempt = work_attempt + 1, updated_at = ?
      WHERE id = ? AND work_ref = ? AND work_created_at IS NOT NULL AND work_attempt = ?`,
    [nowIso(), id, workRef, attempt],
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

/** Authorized refunds on an opportunity not yet confirmed or failed, in cents. */
export async function unresolvedRefundCents(input: {
  projectId: string;
  opportunityId: string;
  /** `<fulfillmentId>:<refundKey>` of the refund being confirmed, left out. */
  except?: string | null;
  /** Only refunds on these obligations; all of the piece's when absent. */
  fulfillmentIds?: readonly string[];
}): Promise<number> {
  const rows = await getDb().all<{
    fulfillment_id: string;
    refund_key: string;
    kind: string;
    amount_cents: number | null;
  }>(
    `SELECT fulfillment_id, refund_key, kind, amount_cents FROM cash_fulfillment_events
      WHERE project_id = ? AND opportunity_id = ? AND refund_key IS NOT NULL
      ORDER BY rowid`,
    [input.projectId, input.opportunityId],
  );
  const open = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.fulfillment_id}:${row.refund_key}`;
    if (row.kind === 'REFUND_AUTHORIZED') open.set(key, Number(row.amount_cents ?? 0));
    else if (row.kind === 'REFUND_CONFIRMED' || row.kind === 'REFUND_FAILED') open.delete(key);
  }
  if (input.except) open.delete(input.except);
  return [...open.entries()]
    .filter(([key]) => !input.fulfillmentIds || input.fulfillmentIds.includes(key.split(':')[0]!))
    .reduce((total, [, one]) => total + one, 0);
}
