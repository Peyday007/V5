/**
 * Combined signals and the possibility store. Reads are scoped by project and
 * user; reconsideration finds what is waiting by an indexed condition key and
 * never rescans.
 */
import { getDb } from '../db/database.ts';
import type { SqlParam } from '../db/types.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';
import type {
  CombinedSignal,
  Possibility,
  PossibilityCondition,
  PossibilityEdge,
  PossibilityRelation,
  PossibilityRequirements,
  PossibilityState,
  SignalSubjectKind,
  SignalsViewer,
} from '../domain/signals.ts';

function scope(viewer: SignalsViewer, alias = ''): { sql: string; params: SqlParam[] } {
  const a = alias ? `${alias}.` : '';
  return viewer.userId
    ? { sql: `(${a}project_id = ? AND (${a}owner_user_id IS NULL OR ${a}owner_user_id = ?))`, params: [viewer.projectId, viewer.userId] }
    : { sql: `(${a}project_id = ? AND ${a}owner_user_id IS NULL)`, params: [viewer.projectId] };
}

// ---------------------------------------------------------------- signals

interface SignalRow {
  id: string; project_id: string; owner_user_id: string | null; subject_kind: SignalSubjectKind; subject_key: string;
  combo_key: string; detection_ids: string; industry_node_id: string | null; possible_need: string | null;
  capture_methods: string; label: 'SIGNAL'; created_at: string;
}
const toSignal = (r: SignalRow): CombinedSignal => ({
  id: r.id, projectId: r.project_id, ownerUserId: r.owner_user_id, subjectKind: r.subject_kind, subjectKey: r.subject_key,
  comboKey: r.combo_key, detectionIds: parseJson<string[]>(r.detection_ids, []), industryNodeId: r.industry_node_id,
  possibleNeed: r.possible_need, captureMethods: parseJson<string[]>(r.capture_methods, []), label: 'SIGNAL',
  createdAt: r.created_at,
});

/** One combination is one row: a replay returns the row already written. */
export async function recordCombinedSignal(input: {
  projectId: string; ownerUserId?: string | null; subjectKind: SignalSubjectKind; subjectKey: string; comboKey: string;
  detectionIds: string[]; industryNodeId?: string | null; possibleNeed?: string | null; captureMethods?: string[];
}): Promise<CombinedSignal> {
  await getDb().run(
    `INSERT INTO combined_signals
       (id, project_id, owner_user_id, subject_kind, subject_key, combo_key, detection_ids, industry_node_id,
        possible_need, capture_methods, label, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SIGNAL', ?) ON CONFLICT DO NOTHING`,
    [newId('cms'), input.projectId, input.ownerUserId ?? null, input.subjectKind, input.subjectKey, input.comboKey,
      toJson([...input.detectionIds].sort()), input.industryNodeId ?? null, input.possibleNeed ?? null,
      toJson(input.captureMethods ?? []), nowIso()],
  );
  const row = await getDb().get<SignalRow>('SELECT * FROM combined_signals WHERE project_id = ? AND combo_key = ?', [input.projectId, input.comboKey]);
  return toSignal(row!);
}

export async function combinedSignalsFor(viewer: SignalsViewer, subjectKind: SignalSubjectKind, subjectKey: string): Promise<CombinedSignal[]> {
  const s = scope(viewer);
  const rows = await getDb().all<SignalRow>(
    `SELECT * FROM combined_signals WHERE ${s.sql} AND subject_kind = ? AND subject_key = ? ORDER BY created_at, id`,
    [...s.params, subjectKind, subjectKey],
  );
  return rows.map(toSignal);
}

// ---------------------------------------------------------- possibilities

interface PossibilityRow {
  id: string; project_id: string; owner_user_id: string | null; title: string; kind: string; requirements: string;
  state: PossibilityState; source_ref: string | null; created_at: string; updated_at: string;
}
const toPossibility = (r: PossibilityRow): Possibility => ({
  id: r.id, projectId: r.project_id, ownerUserId: r.owner_user_id, title: r.title, kind: r.kind,
  requirements: parseJson<PossibilityRequirements>(r.requirements, {}), state: r.state, sourceRef: r.source_ref,
  createdAt: r.created_at, updatedAt: r.updated_at,
});

export async function keepPossibility(input: {
  projectId: string; ownerUserId?: string | null; title: string; kind: string;
  requirements?: PossibilityRequirements; sourceRef?: string | null;
  /** Condition key -> what would make it worth reconsidering. */
  conditions?: Record<string, string>;
}): Promise<Possibility> {
  const id = newId('pos');
  const at = nowIso();
  await getDb().transaction(async () => {
    await getDb().run(
      `INSERT INTO possibilities (id, project_id, owner_user_id, title, kind, requirements, state, source_ref, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'KEPT', ?, ?, ?)`,
      [id, input.projectId, input.ownerUserId ?? null, input.title, input.kind, toJson(input.requirements ?? {}),
        input.sourceRef ?? null, at, at],
    );
    for (const [key, description] of Object.entries(input.conditions ?? {})) {
      await getDb().run(
        `INSERT INTO possibility_conditions (id, project_id, possibility_id, condition_key, description, created_at)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        [newId('pcn'), input.projectId, id, key, description, at],
      );
    }
  });
  return toPossibility((await getDb().get<PossibilityRow>('SELECT * FROM possibilities WHERE id = ?', [id]))!);
}

export async function listPossibilities(viewer: SignalsViewer, state?: PossibilityState): Promise<Possibility[]> {
  const s = scope(viewer);
  const rows = await getDb().all<PossibilityRow>(
    `SELECT * FROM possibilities WHERE ${s.sql}${state ? ' AND state = ?' : ''} ORDER BY created_at, id`,
    state ? [...s.params, state] : s.params,
  );
  return rows.map(toPossibility);
}

/** Link two possibilities of the viewer's project. Both must be readable by the viewer. */
export async function linkPossibilities(
  viewer: SignalsViewer, fromId: string, toId: string, relation: PossibilityRelation,
): Promise<boolean> {
  const s = scope(viewer);
  const found = await getDb().all<{ id: string }>(
    `SELECT id FROM possibilities WHERE ${s.sql} AND id IN (?, ?)`, [...s.params, fromId, toId]);
  if (fromId === toId || new Set(found.map((r) => r.id)).size !== 2) return false;
  const result = await getDb().run(
    `INSERT INTO possibility_edges (id, project_id, from_id, to_id, relation, created_at)
     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    [newId('ped'), viewer.projectId, fromId, toId, relation, nowIso()],
  );
  return result.changes === 1;
}

/** Edges whose two ends the viewer may read. */
export async function possibilityEdgesFor(viewer: SignalsViewer, possibilityId: string): Promise<PossibilityEdge[]> {
  const s = scope(viewer, 'a');
  const t = scope(viewer, 'b');
  const rows = await getDb().all<{ id: string; project_id: string; from_id: string; to_id: string; relation: PossibilityRelation; created_at: string }>(
    `SELECT e.* FROM possibility_edges e
       JOIN possibilities a ON a.id = e.from_id JOIN possibilities b ON b.id = e.to_id
      WHERE (e.from_id = ? OR e.to_id = ?) AND ${s.sql} AND ${t.sql}
      ORDER BY e.created_at, e.id`,
    [possibilityId, possibilityId, ...s.params, ...t.params],
  );
  return rows.map((r) => ({ id: r.id, projectId: r.project_id, fromId: r.from_id, toId: r.to_id, relation: r.relation, createdAt: r.created_at }));
}

export async function conditionsFor(viewer: SignalsViewer, possibilityId: string): Promise<PossibilityCondition[]> {
  const s = scope(viewer, 'p');
  const rows = await getDb().all<{
    id: string; project_id: string; possibility_id: string; condition_key: string; description: string;
    met_change_ref: string | null; met_at: string | null; created_at: string;
  }>(
    `SELECT c.* FROM possibility_conditions c JOIN possibilities p ON p.id = c.possibility_id
      WHERE c.possibility_id = ? AND ${s.sql} ORDER BY c.created_at, c.id`,
    [possibilityId, ...s.params],
  );
  return rows.map((r) => ({
    id: r.id, projectId: r.project_id, possibilityId: r.possibility_id, conditionKey: r.condition_key,
    description: r.description, metChangeRef: r.met_change_ref, metAt: r.met_at, createdAt: r.created_at,
  }));
}

/**
 * A change met a condition key: one indexed read finds what was waiting on it,
 * and each unmet condition is stamped once. A possibility that was merely KEPT
 * moves to RECONSIDERING. Returns the possibilities newly reopened. The caller
 * scopes what it does with them by owner.
 */
export async function meetCondition(input: {
  projectId: string; conditionKey: string; changeRef: string; at?: string;
}): Promise<Array<{ possibilityId: string; ownerUserId: string | null }>> {
  const at = input.at ?? nowIso();
  const waiting = await getDb().all<{ id: string; possibility_id: string; owner_user_id: string | null }>(
    `SELECT c.id, c.possibility_id, p.owner_user_id FROM possibility_conditions c
       JOIN possibilities p ON p.id = c.possibility_id
      WHERE c.project_id = ? AND c.condition_key = ? AND c.met_at IS NULL ORDER BY c.created_at, c.id`,
    [input.projectId, input.conditionKey],
  );
  const out: Array<{ possibilityId: string; ownerUserId: string | null }> = [];
  for (const row of waiting) {
    const stamped = await getDb().run(
      'UPDATE possibility_conditions SET met_change_ref = ?, met_at = ? WHERE id = ? AND met_at IS NULL',
      [input.changeRef, at, row.id],
    );
    if (stamped.changes !== 1) continue;
    await getDb().run(`UPDATE possibilities SET state = 'RECONSIDERING', updated_at = ? WHERE id = ? AND state = 'KEPT'`, [at, row.possibility_id]);
    out.push({ possibilityId: row.possibility_id, ownerUserId: row.owner_user_id });
  }
  return out;
}
