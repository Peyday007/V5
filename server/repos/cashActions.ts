/**
 * What was actually done on an opportunity, append-only.
 *
 * An opportunity reaches `EXECUTING` because a row appears here, never because
 * a transition was requested. Before this existed `beginExecution` moved the
 * state and emitted an event while nothing at all had happened — a piece could
 * read "the transaction is being pursued" on the strength of a button press.
 *
 * `request_key` makes one logical action one row, in the shape §20 settles: a
 * retry after a lost response, a duplicate submission and a restart mid-request
 * are one outcome. Nothing here updates or deletes: what happened is history.
 */
import { getDb } from '../db/database.ts';
import type { SqlParam } from '../db/types.ts';
import { newId, nowIso } from './util.ts';
import type { CashAction, CashActionPerformer, CashActionRow } from '../domain/types.ts';

function mapAction(row: CashActionRow): CashAction {
  return {
    id: row.id,
    projectId: row.project_id,
    opportunityId: row.opportunity_id,
    authorityId: row.authority_id,
    action: row.action,
    performedBy: row.performed_by as CashActionPerformer,
    reference: row.reference,
    detail: row.detail,
    confirmedBy: row.confirmed_by,
    requestKey: row.request_key,
    createdAt: row.created_at,
  };
}

export interface NewCashAction {
  projectId: string;
  opportunityId: string;
  authorityId: string;
  action: string;
  performedBy: CashActionPerformer;
  reference?: string | null;
  detail: string;
  confirmedBy: string;
  requestKey: string;
}

export interface RecordedAction {
  action: CashAction;
  /** True when this call is the one that wrote it. */
  created: boolean;
}

/**
 * Record one action, once.
 *
 * `ON CONFLICT DO NOTHING` then read back by the key, which is the shape every
 * idempotent write in this repository takes: exactly one caller inserts, and
 * every equivalent caller reads the row it collided with. The arbiter is the
 * unique index rather than a check-then-write, so two requests carrying the
 * same key cannot both come away believing they performed it.
 */
export async function recordAction(input: NewCashAction): Promise<RecordedAction> {
  const id = newId('cac');
  const at = nowIso();
  const params: SqlParam[] = [
    id,
    input.projectId,
    input.opportunityId,
    input.authorityId,
    input.action,
    input.performedBy,
    input.reference ?? null,
    input.detail,
    input.confirmedBy,
    input.requestKey,
    at,
  ];
  await getDb().run(
    `INSERT INTO cash_actions
       (id, project_id, opportunity_id, authority_id, action, performed_by,
        reference, detail, confirmed_by, request_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (project_id, request_key) DO NOTHING`,
    params,
  );
  const rows = await getDb().all<CashActionRow>(
    'SELECT * FROM cash_actions WHERE project_id = ? AND request_key = ?',
    [input.projectId, input.requestKey],
  );
  if (!rows[0]) throw new Error('The action disappeared immediately after being written.');
  return { action: mapAction(rows[0]), created: rows[0].id === id };
}

/**
 * Everything done on one opportunity, oldest first.
 *
 * Ordered by `created_at` with the id as the tiebreak rather than by `rowid`,
 * because `dialect.ts` rewrites `rowid` to `seq` and an `ORDER BY` has to be
 * sayable in both dialects — the third time that has been true in one only.
 */
export async function actionsFor(opportunityId: string): Promise<CashAction[]> {
  const rows = await getDb().all<CashActionRow>(
    'SELECT * FROM cash_actions WHERE opportunity_id = ? ORDER BY created_at, id',
    [opportunityId],
  );
  return rows.map(mapAction);
}

export async function countActions(opportunityId: string): Promise<number> {
  const rows = await getDb().all<{ n: number }>(
    'SELECT COUNT(*) AS n FROM cash_actions WHERE opportunity_id = ?',
    [opportunityId],
  );
  return Number(rows[0]?.n ?? 0);
}
