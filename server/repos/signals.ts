/**
 * Combined signals, kept possibilities, their reconsideration conditions and
 * stage measurements.
 *
 * Possibilities, conditions and measurements are always one person's and are
 * read only for that person. Reconsideration is found by the indexed condition
 * key, so a change never rescans the store (§19-style: the index is the arbiter).
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';
import type {
  CombinedSignal,
  CombinedSignalRow,
  MeasurementStage,
  Possibility,
  PossibilityCondition,
  PossibilityConditionRow,
  PossibilityEdge,
  PossibilityEdgeRow,
  PossibilityRelation,
  PossibilityRequirements,
  PossibilityRow,
  PossibilityState,
  SignalSubjectKind,
  StageMeasurement,
  StageMeasurementRow,
} from '../domain/signals.ts';

function mapSignal(row: CombinedSignalRow): CombinedSignal {
  return {
    id: row.id,
    projectId: row.project_id,
    ownerUserId: row.owner_user_id,
    subjectKind: row.subject_kind as SignalSubjectKind,
    subjectKey: row.subject_key,
    patternKey: row.pattern_key,
    memberDetectionIds: parseJson<string[]>(row.member_detection_ids, []),
    industryNodeId: row.industry_node_id,
    possibleNeed: row.possible_need,
    captureMethods: parseJson<string[]>(row.capture_methods, []),
    label: 'SIGNAL',
    createdAt: row.created_at,
  };
}

function mapPossibility(row: PossibilityRow): Possibility {
  return {
    id: row.id,
    projectId: row.project_id,
    ownerUserId: row.owner_user_id,
    title: row.title,
    requirements: parseJson<PossibilityRequirements>(row.requirements, {}),
    state: row.state as PossibilityState,
    originRef: row.origin_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEdge(row: PossibilityEdgeRow): PossibilityEdge {
  return {
    id: row.id,
    projectId: row.project_id,
    ownerUserId: row.owner_user_id,
    fromId: row.from_id,
    toId: row.to_id,
    relation: row.relation as PossibilityRelation,
    createdAt: row.created_at,
  };
}

function mapCondition(row: PossibilityConditionRow): PossibilityCondition {
  return {
    id: row.id,
    possibilityId: row.possibility_id,
    projectId: row.project_id,
    ownerUserId: row.owner_user_id,
    conditionKey: row.condition_key,
    detail: row.detail,
    metAt: row.met_at,
    metChangeRef: row.met_change_ref,
    createdAt: row.created_at,
  };
}

function mapMeasurement(row: StageMeasurementRow): StageMeasurement {
  return {
    id: row.id,
    projectId: row.project_id,
    ownerUserId: row.owner_user_id,
    goalId: row.goal_id,
    stage: row.stage as MeasurementStage,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
    screened: row.screened,
    rejected: row.rejected,
    advanced: row.advanced,
    researchJobs: row.research_jobs,
    premiumAiJobs: row.premium_ai_jobs,
    relevantOpenings: row.relevant_openings,
    supportedPlans: row.supported_plans,
    bottleneck: row.bottleneck,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------- combined signals

/** Record a combined signal, or find the one already recorded for this pattern. */
export async function recordCombinedSignal(input: {
  projectId: string;
  ownerUserId: string | null;
  subjectKind: SignalSubjectKind;
  subjectKey: string;
  patternKey: string;
  memberDetectionIds: string[];
  industryNodeId?: string | null;
  possibleNeed?: string | null;
  captureMethods?: string[];
}): Promise<{ signal: CombinedSignal; created: boolean }> {
  const subjectKey = input.subjectKey.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!subjectKey) throw new Error('A combined signal must name its organisation or place.');
  if (input.memberDetectionIds.length < 2) {
    throw new Error('A combined signal links at least two detections; one is just a detection.');
  }
  const id = newId('csg');
  await getDb().run(
    `INSERT INTO combined_signals
       (id, project_id, owner_user_id, subject_kind, subject_key, pattern_key, member_detection_ids,
        industry_node_id, possible_need, capture_methods, label, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SIGNAL', ?)
     ON CONFLICT DO NOTHING`,
    [
      id, input.projectId, input.ownerUserId, input.subjectKind, subjectKey, input.patternKey,
      toJson([...input.memberDetectionIds].sort()), input.industryNodeId ?? null,
      input.possibleNeed ?? null, toJson(input.captureMethods ?? []), nowIso(),
    ],
  );
  const rows = await getDb().all<CombinedSignalRow>(
    `SELECT * FROM combined_signals
      WHERE project_id = ? AND subject_kind = ? AND subject_key = ? AND pattern_key = ?`,
    [input.projectId, input.subjectKind, subjectKey, input.patternKey],
  );
  if (!rows[0]) throw new Error('The combined signal disappeared immediately after being written.');
  return { signal: mapSignal(rows[0]), created: rows[0].id === id };
}

export async function listCombinedSignals(
  projectId: string,
  userId: string,
  filter: { industryNodeId?: string } = {},
): Promise<CombinedSignal[]> {
  const rows = filter.industryNodeId
    ? await getDb().all<CombinedSignalRow>(
        `SELECT * FROM combined_signals
          WHERE project_id = ? AND industry_node_id = ? AND (owner_user_id = ? OR owner_user_id IS NULL)
          ORDER BY created_at ASC, id ASC`,
        [projectId, filter.industryNodeId, userId],
      )
    : await getDb().all<CombinedSignalRow>(
        `SELECT * FROM combined_signals
          WHERE project_id = ? AND (owner_user_id = ? OR owner_user_id IS NULL)
          ORDER BY created_at ASC, id ASC`,
        [projectId, userId],
      );
  return rows.map(mapSignal);
}

// ---------------------------------------------------------------- possibilities

export async function createPossibility(input: {
  projectId: string;
  ownerUserId: string;
  title: string;
  requirements?: PossibilityRequirements;
  originRef?: string | null;
}): Promise<Possibility> {
  const title = input.title.trim();
  if (!title) throw new Error('A possibility must have a title.');
  const id = newId('pos');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO possibilities
       (id, project_id, owner_user_id, title, requirements, state, origin_ref, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'KEPT', ?, ?, ?)`,
    [id, input.projectId, input.ownerUserId, title, toJson(input.requirements ?? {}), input.originRef ?? null, at, at],
  );
  return (await getPossibility(input.projectId, input.ownerUserId, id))!;
}

export async function getPossibility(
  projectId: string,
  userId: string,
  id: string,
): Promise<Possibility | null> {
  const rows = await getDb().all<PossibilityRow>(
    'SELECT * FROM possibilities WHERE id = ? AND project_id = ? AND owner_user_id = ?',
    [id, projectId, userId],
  );
  return rows[0] ? mapPossibility(rows[0]) : null;
}

export async function listPossibilities(
  projectId: string,
  userId: string,
  states?: PossibilityState[],
): Promise<Possibility[]> {
  const rows = await getDb().all<PossibilityRow>(
    `SELECT * FROM possibilities WHERE project_id = ? AND owner_user_id = ?
      ORDER BY created_at ASC, id ASC`,
    [projectId, userId],
  );
  const all = rows.map(mapPossibility);
  return states ? all.filter((p) => states.includes(p.state)) : all;
}

/** Move a possibility, guarded on the state it is moving from. */
export async function transitionPossibility(input: {
  projectId: string;
  ownerUserId: string;
  id: string;
  from: PossibilityState;
  to: PossibilityState;
}): Promise<boolean> {
  const before = await getDb().all<{ id: string }>(
    'SELECT id FROM possibilities WHERE id = ? AND project_id = ? AND owner_user_id = ? AND state = ?',
    [input.id, input.projectId, input.ownerUserId, input.from],
  );
  if (!before[0]) return false;
  await getDb().run(
    `UPDATE possibilities SET state = ?, updated_at = ?
      WHERE id = ? AND project_id = ? AND owner_user_id = ? AND state = ?`,
    [input.to, nowIso(), input.id, input.projectId, input.ownerUserId, input.from],
  );
  return true;
}

/** Both ends must be this user's possibilities in this project. */
export async function addPossibilityEdge(input: {
  projectId: string;
  ownerUserId: string;
  fromId: string;
  toId: string;
  relation: PossibilityRelation;
}): Promise<{ edge: PossibilityEdge; created: boolean }> {
  if (input.fromId === input.toId) throw new Error('A possibility cannot depend on itself.');
  for (const end of [input.fromId, input.toId]) {
    if (!(await getPossibility(input.projectId, input.ownerUserId, end))) {
      throw new Error('Both ends of an edge must be possibilities this user owns in this project.');
    }
  }
  const id = newId('ped');
  await getDb().run(
    `INSERT INTO possibility_edges (id, project_id, owner_user_id, from_id, to_id, relation, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [id, input.projectId, input.ownerUserId, input.fromId, input.toId, input.relation, nowIso()],
  );
  const rows = await getDb().all<PossibilityEdgeRow>(
    `SELECT * FROM possibility_edges
      WHERE project_id = ? AND owner_user_id = ? AND from_id = ? AND to_id = ? AND relation = ?`,
    [input.projectId, input.ownerUserId, input.fromId, input.toId, input.relation],
  );
  return { edge: mapEdge(rows[0]!), created: rows[0]!.id === id };
}

export async function listPossibilityEdges(projectId: string, userId: string): Promise<PossibilityEdge[]> {
  const rows = await getDb().all<PossibilityEdgeRow>(
    `SELECT * FROM possibility_edges WHERE project_id = ? AND owner_user_id = ?
      ORDER BY created_at ASC, id ASC`,
    [projectId, userId],
  );
  return rows.map(mapEdge);
}

/** Add a reconsideration condition, once per (possibility, key). */
export async function addCondition(input: {
  projectId: string;
  ownerUserId: string;
  possibilityId: string;
  conditionKey: string;
  detail?: string | null;
}): Promise<PossibilityCondition> {
  if (!(await getPossibility(input.projectId, input.ownerUserId, input.possibilityId))) {
    throw new Error('That possibility is not this user\'s in this project.');
  }
  const key = input.conditionKey.trim();
  if (!key) throw new Error('A condition must have a key.');
  await getDb().run(
    `INSERT INTO possibility_conditions
       (id, possibility_id, project_id, owner_user_id, condition_key, detail, met_at, met_change_ref, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)
     ON CONFLICT DO NOTHING`,
    [newId('pcd'), input.possibilityId, input.projectId, input.ownerUserId, key, input.detail ?? null, nowIso()],
  );
  const rows = await getDb().all<PossibilityConditionRow>(
    'SELECT * FROM possibility_conditions WHERE possibility_id = ? AND condition_key = ?',
    [input.possibilityId, key],
  );
  return mapCondition(rows[0]!);
}

/**
 * A change happened. Find, by the indexed key, this user's unmet conditions on
 * it, mark them met by the change ref, and move their KEPT possibilities to
 * RECONSIDER. A ref already recorded on a condition is not applied twice. It
 * never moves an ADOPTED or RETIRED possibility.
 */
export async function reconsiderOnChange(input: {
  projectId: string;
  ownerUserId: string;
  conditionKey: string;
  changeRef: string;
}): Promise<string[]> {
  const waiting = await getDb().all<PossibilityConditionRow>(
    `SELECT * FROM possibility_conditions
      WHERE project_id = ? AND owner_user_id = ? AND condition_key = ? AND met_at IS NULL`,
    [input.projectId, input.ownerUserId, input.conditionKey],
  );
  const moved: string[] = [];
  const at = nowIso();
  for (const condition of waiting) {
    await getDb().run(
      `UPDATE possibility_conditions SET met_at = ?, met_change_ref = ?
        WHERE id = ? AND met_at IS NULL`,
      [at, input.changeRef, condition.id],
    );
    const ok = await transitionPossibility({
      projectId: input.projectId,
      ownerUserId: input.ownerUserId,
      id: condition.possibility_id,
      from: 'KEPT',
      to: 'RECONSIDER',
    });
    if (ok) moved.push(condition.possibility_id);
  }
  return moved;
}

export async function listConditions(
  projectId: string,
  userId: string,
  possibilityId: string,
): Promise<PossibilityCondition[]> {
  const rows = await getDb().all<PossibilityConditionRow>(
    `SELECT * FROM possibility_conditions
      WHERE project_id = ? AND owner_user_id = ? AND possibility_id = ?
      ORDER BY created_at ASC, id ASC`,
    [projectId, userId, possibilityId],
  );
  return rows.map(mapCondition);
}

// ---------------------------------------------------------------- measurements

export async function recordMeasurement(input: {
  projectId: string;
  ownerUserId: string;
  goalId: string;
  stage: MeasurementStage;
  startedAt: string;
  endedAt?: string | null;
  screened?: number;
  rejected?: number;
  advanced?: number;
  researchJobs?: number;
  premiumAiJobs?: number;
  relevantOpenings?: number;
  supportedPlans?: number;
  bottleneck?: string | null;
}): Promise<StageMeasurement> {
  const started = Date.parse(input.startedAt);
  const ended = input.endedAt ? Date.parse(input.endedAt) : null;
  if (Number.isNaN(started) || (input.endedAt && Number.isNaN(ended as number))) {
    throw new Error('A measurement needs valid timestamps.');
  }
  const duration = ended === null ? null : Math.max(0, ended - started);
  const counts = [input.screened, input.rejected, input.advanced, input.researchJobs, input.premiumAiJobs,
    input.relevantOpenings, input.supportedPlans];
  if (counts.some((n) => n !== undefined && (!Number.isInteger(n) || n < 0))) {
    throw new Error('Measurement counts must be non-negative integers.');
  }
  const id = newId('stm');
  await getDb().run(
    `INSERT INTO stage_measurements
       (id, project_id, owner_user_id, goal_id, stage, started_at, ended_at, duration_ms, screened, rejected,
        advanced, research_jobs, premium_ai_jobs, relevant_openings, supported_plans, bottleneck, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, input.projectId, input.ownerUserId, input.goalId, input.stage, input.startedAt,
      input.endedAt ?? null, duration, input.screened ?? 0, input.rejected ?? 0, input.advanced ?? 0,
      input.researchJobs ?? 0, input.premiumAiJobs ?? 0, input.relevantOpenings ?? 0,
      input.supportedPlans ?? 0, input.bottleneck ?? null, nowIso(),
    ],
  );
  const rows = await getDb().all<StageMeasurementRow>('SELECT * FROM stage_measurements WHERE id = ?', [id]);
  return mapMeasurement(rows[0]!);
}

export async function listMeasurements(
  projectId: string,
  userId: string,
  goalId: string,
): Promise<StageMeasurement[]> {
  const rows = await getDb().all<StageMeasurementRow>(
    `SELECT * FROM stage_measurements
      WHERE project_id = ? AND owner_user_id = ? AND goal_id = ?
      ORDER BY started_at ASC, id ASC`,
    [projectId, userId, goalId],
  );
  return rows.map(mapMeasurement);
}
