/**
 * The cash sprint's own row, and the append-only history beside it.
 *
 * Two things live here and they are deliberately in one module, because the
 * second is what makes the first auditable: every transition writes a
 * `cash_events` row naming who asked for it and why, and nothing reads a mode's
 * state without that history being reconstructable.
 *
 * **Nothing in this file touches `russell_cycle`.** That is worth saying in
 * code rather than only in prose: the cycle is a singleton whose pause stops
 * the entire Russell tick — writeback, request resumption, every other
 * project's missions — so wiring a sprint's off switch to it would stop the
 * Brain in order to end one person's sprint. A mode winding down is a fact
 * about one project, and it is read by the one producer that creates new cash
 * discovery.
 */
import { getDb } from '../db/database.ts';
import type { SqlParam } from '../db/types.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';
import type {
  CashEvent,
  CashEventRow,
  CashMode,
  CashModeRow,
  CashModeState,
} from '../domain/types.ts';

/** The Brain's clock, named once so the assumption has one home. */
export function cashNow(): string {
  return nowIso();
}

function mapMode(row: CashModeRow): CashMode {
  return {
    id: row.id,
    projectId: row.project_id,
    ownerUserId: row.owner_user_id,
    objective: row.objective,
    horizonDays: row.horizon_days,
    envelopeId: row.envelope_id,
    currency: row.currency,
    state: row.state as CashModeState,
    activatedAt: row.activated_at,
    woundDownAt: row.wound_down_at,
    archivedAt: row.archived_at,
    stateReason: row.state_reason,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getCashMode(projectId: string): Promise<CashMode | null> {
  const rows = await getDb().all<CashModeRow>('SELECT * FROM cash_modes WHERE project_id = ?', [
    projectId,
  ]);
  return rows[0] ? mapMode(rows[0]) : null;
}

/**
 * The sprints inside a given set of projects.
 *
 * The set is the caller's readable projects, decided by `decideProjectAccess`
 * before this is called — so the query is bounded rather than filtered
 * afterwards, which is §29's rule about search: a listing that fetched broadly
 * and filtered later is one forgotten predicate away from showing somebody
 * another person's operation, and the *count* alone is already information.
 */
export async function listCashModes(projectIds: string[]): Promise<CashMode[]> {
  if (projectIds.length === 0) return [];
  const rows = await getDb().all<CashModeRow>(
    `SELECT * FROM cash_modes
      WHERE project_id IN (${projectIds.map(() => '?').join(', ')})
      ORDER BY activated_at DESC, id DESC`,
    projectIds,
  );
  return rows.map(mapMode);
}

export async function getCashModeById(id: string): Promise<CashMode | null> {
  const rows = await getDb().all<CashModeRow>('SELECT * FROM cash_modes WHERE id = ?', [id]);
  return rows[0] ? mapMode(rows[0]) : null;
}

/**
 * Turn the section on for one project.
 *
 * `ON CONFLICT DO NOTHING` on the unique project, then read back: activating
 * twice is one mode rather than two, and a retried request after a lost
 * response finds the mode it already created rather than colliding. The caller
 * is told which happened, because "already active" and "activated" are
 * different sentences to show a person.
 */
export async function activateCashMode(input: {
  projectId: string;
  ownerUserId: string;
  createdByUserId: string;
  objective: string;
  horizonDays: number;
  envelopeId: string;
  currency: string;
}): Promise<{ mode: CashMode; created: boolean }> {
  const existing = await getCashMode(input.projectId);
  if (existing) return { mode: existing, created: false };

  const at = cashNow();
  await getDb().run(
    `INSERT INTO cash_modes
       (id, project_id, owner_user_id, objective, horizon_days, envelope_id, currency, state,
        activated_at, wound_down_at, archived_at, state_reason,
        created_by_user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, NULL, NULL, NULL, ?, ?, ?)
     ON CONFLICT (project_id) DO NOTHING`,
    [
      newId('csm'),
      input.projectId,
      input.ownerUserId,
      input.objective,
      Math.max(1, Math.trunc(input.horizonDays)),
      input.envelopeId,
      /*
       * The currency the person chose, which this INSERT used to leave out.
       *
       * `053` added the column with `DEFAULT 'USD'`, so omitting it did not
       * fail — it silently stored dollars for a sprint somebody activated in
       * euros, and every figure afterwards was correct arithmetic over the
       * wrong label. A default is what makes a dropped argument invisible.
       */
      input.currency,
      at,
      input.createdByUserId,
      at,
      at,
    ],
  );
  const mode = await getCashMode(input.projectId);
  if (!mode) throw new Error('The cash mode disappeared immediately after being written.');
  return { mode, created: true };
}

/**
 * Move the sprint's lifecycle, guarded on where it is now.
 *
 * A compare-and-swap on `state` rather than a read-then-write, for the reason
 * every claim in this repository is one: two people pressing the same control
 * must produce one transition, and the loser of the race is an ordinary outcome
 * rather than an error.
 *
 * `false` means the mode was not in `from` — which the caller turns into "this
 * has already happened" rather than into a failure.
 */
export async function transitionCashMode(input: {
  projectId: string;
  from: CashModeState;
  to: CashModeState;
  reason: string;
}): Promise<boolean> {
  const at = cashNow();
  const stamp =
    input.to === 'WINDING_DOWN'
      ? ', wound_down_at = ?'
      : input.to === 'ARCHIVED'
        ? ', archived_at = ?'
        : '';
  const params: SqlParam[] = [input.to, input.reason, at];
  if (stamp) params.push(at);
  params.push(input.projectId, input.from);
  const result = await getDb().run(
    `UPDATE cash_modes
        SET state = ?, state_reason = ?, updated_at = ?${stamp}
      WHERE project_id = ? AND state = ?`,
    params,
  );
  return result.changes === 1;
}

/**
 * Every meaningful change, kept.
 *
 * No foreign keys, on purpose: `identity_events`' reasoning at a new subject —
 * an audit row a cascade can delete is not an audit row. So this survives the
 * opportunity it describes being archived, and the project row being whatever
 * it becomes.
 */
export async function recordCashEvent(input: {
  projectId: string;
  opportunityId?: string | null;
  kind: string;
  actorRef: string;
  summary: string;
  detail?: Record<string, unknown>;
}): Promise<CashEvent> {
  const id = newId('cse');
  const at = cashNow();
  await getDb().run(
    `INSERT INTO cash_events
       (id, project_id, opportunity_id, kind, actor_ref, summary, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.projectId,
      input.opportunityId ?? null,
      input.kind,
      input.actorRef,
      input.summary,
      toJson(input.detail ?? {}),
      at,
    ],
  );
  return {
    id,
    projectId: input.projectId,
    opportunityId: input.opportunityId ?? null,
    kind: input.kind,
    actorRef: input.actorRef,
    summary: input.summary,
    detail: input.detail ?? {},
    createdAt: at,
  };
}

function mapEvent(row: CashEventRow): CashEvent {
  return {
    id: row.id,
    projectId: row.project_id,
    opportunityId: row.opportunity_id,
    kind: row.kind,
    actorRef: row.actor_ref,
    summary: row.summary,
    detail: parseJson<Record<string, unknown>>(row.detail, {}),
    createdAt: row.created_at,
  };
}

export async function listCashEvents(projectId: string, limit = 50): Promise<CashEvent[]> {
  const rows = await getDb().all<CashEventRow>(
    `SELECT * FROM cash_events
      WHERE project_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
    [projectId, Math.max(1, Math.min(500, limit))],
  );
  return rows.map(mapEvent);
}

export async function listCashEventsFor(
  opportunityId: string,
  limit = 50,
): Promise<CashEvent[]> {
  const rows = await getDb().all<CashEventRow>(
    `SELECT * FROM cash_events
      WHERE opportunity_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
    [opportunityId, Math.max(1, Math.min(500, limit))],
  );
  return rows.map(mapEvent);
}
