/**
 * The work register's rows.
 *
 * Three tables and no cleverness: a workstream, the things it points at, and
 * what has happened to it. Nothing here derives a state, ranks anything or
 * decides whether a link is still true — those are `services/register/`'s, and
 * keeping them out of the repository is what stops a second reader appearing
 * with its own opinion. This codebase has paid for that four times
 * (`reconcileAcceptedFragment`, `reconcileRepairs`, `rearmSurfaceDeferredIntents`,
 * `linkFiledWork`), and every one of them was two readers of one rule.
 *
 * The one guarded write is `supersedeLink`, and it is guarded on the link still
 * being live — so two readers correcting the same link produce one correction
 * and one ordinary refusal, rather than a correction that silently overwrites
 * another correction.
 */
import { getDb } from '../db/database.ts';
import type { SqlParam } from '../db/types.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';
import type {
  LinkKind,
  LinkRelation,
  Workstream,
  WorkstreamEvent,
  WorkstreamEventRow,
  WorkstreamLink,
  WorkstreamLinkRow,
  WorkstreamPurpose,
  WorkstreamRow,
} from '../domain/register.ts';

function mapWorkstream(row: WorkstreamRow): Workstream {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    intent: row.intent,
    purpose: row.purpose as WorkstreamPurpose,
    archivedAt: row.archived_at,
    archivedReason: row.archived_reason,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    outcome: row.outcome ?? null,
    ownerUserId: row.owner_user_id ?? null,
    dueAt: row.due_at ?? null,
    commitment:
      row.commitment === 'CUSTOMER' || row.commitment === 'INTERNAL' ? row.commitment : 'NONE',
    pausedAt: row.paused_at ?? null,
    pausedReason: row.paused_reason ?? null,
    cancelledAt: row.cancelled_at ?? null,
    cancelledReason: row.cancelled_reason ?? null,
  };
}

function mapLink(row: WorkstreamLinkRow): WorkstreamLink {
  return {
    id: row.id,
    workstreamId: row.workstream_id,
    kind: row.kind as LinkKind,
    ref: row.ref,
    label: row.label,
    relation: row.relation as LinkRelation,
    detail: parseJson<Record<string, unknown>>(row.detail, {}),
    recordedBy: row.recorded_by === 'PERSON' ? 'PERSON' : 'BRAIN',
    recordedByUserId: row.recorded_by_user_id,
    supersededAt: row.superseded_at,
    supersededReason: row.superseded_reason,
    createdAt: row.created_at,
  };
}

function mapEvent(row: WorkstreamEventRow): WorkstreamEvent {
  return {
    id: row.id,
    workstreamId: row.workstream_id,
    kind: row.kind,
    summary: row.summary,
    detail: parseJson<Record<string, unknown>>(row.detail, {}),
    actorRef: row.actor_ref,
    createdAt: row.created_at,
  };
}

export async function createWorkstream(input: {
  projectId: string | null;
  title: string;
  intent: string;
  purpose: WorkstreamPurpose;
  createdByUserId: string | null;
}): Promise<Workstream> {
  const id = newId('wst');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO workstreams
       (id, project_id, title, intent, purpose, created_by_user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.projectId, input.title, input.intent, input.purpose, input.createdByUserId, at, at],
  );
  const created = await getWorkstream(id);
  if (!created) throw new Error('The workstream was written and could not be read back.');
  return created;
}

export async function getWorkstream(id: string): Promise<Workstream | null> {
  const row = await getDb().get<WorkstreamRow>(`SELECT * FROM workstreams WHERE id = ?`, [id]);
  return row ? mapWorkstream(row) : null;
}

/**
 * Every workstream, newest movement first.
 *
 * Ordered by `updated_at` with the id as the tiebreak, which is an ordering
 * **both dialects can say**. §27 records the third time a tiebreak on `rowid`
 * passed the whole SQLite suite and threw in production, so there is no `rowid`
 * here and no `seq` either.
 */
export async function listWorkstreams(options?: {
  projectIds?: string[] | null;
  includeArchived?: boolean;
}): Promise<Workstream[]> {
  const where: string[] = [];
  const params: SqlParam[] = [];
  if (!options?.includeArchived) where.push('archived_at IS NULL');
  if (options?.projectIds) {
    if (options.projectIds.length === 0) {
      // A caller who may read nothing gets nothing, rather than everything.
      return [];
    }
    const marks = options.projectIds.map(() => '?').join(', ');
    // A Brain-wide workstream has no project and is readable by anybody who may
    // read the register at all — it is about the platform rather than about
    // somebody's private operation.
    where.push(`(project_id IS NULL OR project_id IN (${marks}))`);
    params.push(...options.projectIds);
  }
  const rows = await getDb().all<WorkstreamRow>(
    `SELECT * FROM workstreams
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY updated_at DESC, id DESC`,
    params,
  );
  return rows.map(mapWorkstream);
}

export async function updateWorkstream(
  id: string,
  patch: { title?: string; intent?: string; purpose?: WorkstreamPurpose; projectId?: string | null },
): Promise<Workstream | null> {
  const sets: string[] = [];
  const params: SqlParam[] = [];
  if (patch.title !== undefined) { sets.push('title = ?'); params.push(patch.title); }
  if (patch.intent !== undefined) { sets.push('intent = ?'); params.push(patch.intent); }
  if (patch.purpose !== undefined) { sets.push('purpose = ?'); params.push(patch.purpose); }
  if (patch.projectId !== undefined) { sets.push('project_id = ?'); params.push(patch.projectId); }
  if (sets.length === 0) return await getWorkstream(id);
  sets.push('updated_at = ?');
  params.push(nowIso(), id);
  await getDb().run(`UPDATE workstreams SET ${sets.join(', ')} WHERE id = ?`, params);
  return await getWorkstream(id);
}

/** Archiving destroys nothing: the links stay, so the sources still resolve. */
export async function archiveWorkstream(id: string, reason: string): Promise<Workstream | null> {
  const at = nowIso();
  await getDb().run(
    `UPDATE workstreams SET archived_at = ?, archived_reason = ?, updated_at = ?
      WHERE id = ? AND archived_at IS NULL`,
    [at, reason, at, id],
  );
  return await getWorkstream(id);
}

/**
 * Point a workstream at something.
 *
 * Idempotent by the partial unique index rather than by a read-then-write:
 * linking the same conversation twice produces one live link and the second
 * call reports the row it collided with. That is §20's shape at a much smaller
 * scale, and the reason it matters here is that the bridge links a conversation
 * on every synchronization.
 */
export async function linkWorkstream(input: {
  workstreamId: string;
  kind: LinkKind;
  ref: string;
  relation: LinkRelation;
  label?: string | null;
  detail?: Record<string, unknown>;
  recordedBy: 'BRAIN' | 'PERSON';
  recordedByUserId?: string | null;
}): Promise<WorkstreamLink> {
  const existing = await getDb().get<WorkstreamLinkRow>(
    `SELECT * FROM workstream_links
      WHERE workstream_id = ? AND kind = ? AND ref = ? AND relation = ? AND superseded_at IS NULL`,
    [input.workstreamId, input.kind, input.ref, input.relation],
  );
  if (existing) return mapLink(existing);

  const id = newId('wsl');
  await getDb().run(
    `INSERT INTO workstream_links
       (id, workstream_id, kind, ref, label, relation, detail,
        recorded_by, recorded_by_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.workstreamId,
      input.kind,
      input.ref,
      input.label ?? null,
      input.relation,
      toJson(input.detail ?? {}),
      input.recordedBy,
      input.recordedByUserId ?? null,
      nowIso(),
    ],
  );
  await getDb().run(`UPDATE workstreams SET updated_at = ? WHERE id = ?`, [
    nowIso(),
    input.workstreamId,
  ]);
  const row = await getDb().get<WorkstreamLinkRow>(`SELECT * FROM workstream_links WHERE id = ?`, [id]);
  if (!row) throw new Error('The link was written and could not be read back.');
  return mapLink(row);
}

/**
 * Correct a link without destroying it.
 *
 * Guarded on the row still being live, in the statement that makes the change,
 * so two callers correcting one link produce one correction. The loser is an
 * ordinary outcome and is reported as `false` rather than thrown.
 */
export async function supersedeLink(id: string, reason: string): Promise<boolean> {
  const at = nowIso();
  const result = await getDb().run(
    `UPDATE workstream_links SET superseded_at = ?, superseded_reason = ?
      WHERE id = ? AND superseded_at IS NULL`,
    [at, reason, id],
  );
  return result.changes > 0;
}

export async function listLinks(
  workstreamId: string,
  options?: { includeSuperseded?: boolean },
): Promise<WorkstreamLink[]> {
  const rows = await getDb().all<WorkstreamLinkRow>(
    `SELECT * FROM workstream_links
      WHERE workstream_id = ?
        ${options?.includeSuperseded ? '' : 'AND superseded_at IS NULL'}
      ORDER BY created_at, id`,
    [workstreamId],
  );
  return rows.map(mapLink);
}

/**
 * Every live link across every workstream, for the one-query owner view.
 *
 * The view reads dozens of workstreams at once and a per-workstream query would
 * be a read amplification nobody notices until the register is large. Ordered
 * by workstream so a caller can group without sorting.
 */
export async function listAllLiveLinks(workstreamIds: string[]): Promise<WorkstreamLink[]> {
  if (workstreamIds.length === 0) return [];
  const marks = workstreamIds.map(() => '?').join(', ');
  const rows = await getDb().all<WorkstreamLinkRow>(
    `SELECT * FROM workstream_links
      WHERE workstream_id IN (${marks}) AND superseded_at IS NULL
      ORDER BY workstream_id, created_at, id`,
    workstreamIds,
  );
  return rows.map(mapLink);
}

/** Which workstreams point at this thing. One conversation, several streams. */
export async function workstreamsForRef(kind: LinkKind, ref: string): Promise<string[]> {
  const rows = await getDb().all<{ workstream_id: string }>(
    `SELECT DISTINCT workstream_id FROM workstream_links
      WHERE kind = ? AND ref = ? AND superseded_at IS NULL
      ORDER BY workstream_id`,
    [kind, ref],
  );
  return rows.map((row) => row.workstream_id);
}

export async function recordWorkstreamEvent(input: {
  workstreamId: string;
  kind: string;
  summary: string;
  detail?: Record<string, unknown>;
  actorRef: string;
}): Promise<WorkstreamEvent> {
  const id = newId('wse');
  await getDb().run(
    `INSERT INTO workstream_events (id, workstream_id, kind, summary, detail, actor_ref, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.workstreamId,
      input.kind,
      input.summary,
      toJson(input.detail ?? {}),
      input.actorRef,
      nowIso(),
    ],
  );
  const row = await getDb().get<WorkstreamEventRow>(`SELECT * FROM workstream_events WHERE id = ?`, [id]);
  if (!row) throw new Error('The event was written and could not be read back.');
  return mapEvent(row);
}

export async function listWorkstreamEvents(
  workstreamId: string,
  limit = 50,
): Promise<WorkstreamEvent[]> {
  const rows = await getDb().all<WorkstreamEventRow>(
    `SELECT * FROM workstream_events
      WHERE workstream_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
    [workstreamId, limit],
  );
  return rows.map(mapEvent);
}
