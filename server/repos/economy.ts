/**
 * Economic edges and activity variables, the possibility store, and stage
 * measurements. Every read is scoped by project, and the stores a person's
 * goals touch are scoped by owner as well. Writes are idempotent by a unique
 * index: a loser reads back the winner's row.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';
import { evidenceProblem } from '../domain/economy.ts';
import type {
  ActivityVariable, EconomicEdge, EconomicRelation, EndpointKind, EvidenceStatus, OperatorKind,
  Possibility, PossibilityCondition, PossibilityEdge, PossibilityKind, PossibilityRelation,
  PossibilityRequirements, Stage, StageMeasurement,
} from '../domain/economy.ts';

interface Row { [key: string]: unknown }
const s = (v: unknown): string => v as string;
const sn = (v: unknown): string | null => (v as string | null) ?? null;

function mapEdge(r: Row): EconomicEdge {
  return {
    id: s(r['id']), projectId: s(r['project_id']),
    fromKind: s(r['from_kind']) as EndpointKind, fromRef: s(r['from_ref']),
    toKind: s(r['to_kind']) as EndpointKind, toRef: s(r['to_ref']),
    relation: s(r['relation']) as EconomicRelation, status: s(r['status']) as EvidenceStatus,
    sourceClaimId: sn(r['source_claim_id']), basis: sn(r['basis']),
    operatorKind: s(r['operator_kind']) as OperatorKind, createdAt: s(r['created_at']),
  };
}

export async function recordEconomicEdge(input: {
  projectId: string; fromKind: EndpointKind; fromRef: string; toKind: EndpointKind; toRef: string;
  relation: EconomicRelation; status: EvidenceStatus; sourceClaimId?: string | null;
  basis?: string | null; operatorKind: OperatorKind;
}): Promise<{ edge: EconomicEdge; created: boolean }> {
  const problem = evidenceProblem(input);
  if (problem) throw new Error(problem);
  const id = newId('eed');
  await getDb().run(
    `INSERT INTO economic_edges (id, project_id, from_kind, from_ref, to_kind, to_ref, relation,
       status, source_claim_id, basis, operator_kind, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    [id, input.projectId, input.fromKind, input.fromRef, input.toKind, input.toRef, input.relation,
      input.status, input.sourceClaimId ?? null, input.basis ?? null, input.operatorKind, nowIso()],
  );
  const row = await getDb().get<Row>(
    `SELECT * FROM economic_edges WHERE project_id = ? AND from_kind = ? AND from_ref = ?
       AND relation = ? AND to_kind = ? AND to_ref = ? AND operator_kind = ?`,
    [input.projectId, input.fromKind, input.fromRef, input.relation, input.toKind, input.toRef, input.operatorKind],
  );
  const edge = mapEdge(row!);
  return { edge, created: edge.id === id };
}

export async function edgesAround(projectId: string, ref: string): Promise<EconomicEdge[]> {
  const rows = await getDb().all<Row>(
    `SELECT * FROM economic_edges WHERE project_id = ? AND (from_ref = ? OR to_ref = ?)
     ORDER BY created_at, id`,
    [projectId, ref, ref],
  );
  return rows.map(mapEdge);
}

function mapVariable(r: Row): ActivityVariable {
  return {
    id: s(r['id']), projectId: s(r['project_id']), activityRef: s(r['activity_ref']),
    name: s(r['name']), value: r['value'] === null ? null : Number(r['value']), unit: sn(r['unit']),
    status: s(r['status']) as EvidenceStatus, sourceClaimId: sn(r['source_claim_id']),
    basis: sn(r['basis']), operatorKind: s(r['operator_kind']) as OperatorKind,
    createdAt: s(r['created_at']),
  };
}

/** A newer reading is a new row; the older ones stay as history. */
export async function recordVariable(input: {
  projectId: string; activityRef: string; name: string; value: number | null; unit?: string | null;
  status: EvidenceStatus; sourceClaimId?: string | null; basis?: string | null; operatorKind: OperatorKind;
}): Promise<ActivityVariable> {
  const name = input.name.replace(/\s+/g, ' ').trim();
  if (!name) throw new Error('A variable must have a name.');
  const problem = evidenceProblem(input);
  if (problem) throw new Error(problem);
  const id = newId('avr');
  await getDb().run(
    `INSERT INTO activity_variables (id, project_id, activity_ref, name, value, unit, status,
       source_claim_id, basis, operator_kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.projectId, input.activityRef, name, input.value, input.unit ?? null, input.status,
      input.sourceClaimId ?? null, input.basis ?? null, input.operatorKind, nowIso()],
  );
  return mapVariable((await getDb().get<Row>('SELECT * FROM activity_variables WHERE id = ?', [id]))!);
}

/** The current reading of each variable: the newest per (name, operator kind). */
export async function currentVariables(projectId: string, activityRef: string): Promise<ActivityVariable[]> {
  const rows = await getDb().all<Row>(
    `SELECT * FROM activity_variables WHERE project_id = ? AND activity_ref = ?
     ORDER BY created_at, id`,
    [projectId, activityRef],
  );
  const latest = new Map<string, ActivityVariable>();
  for (const r of rows) {
    const v = mapVariable(r);
    latest.set(`${v.name}\u0000${v.operatorKind}`, v);
  }
  return [...latest.values()];
}

function mapPossibility(r: Row): Possibility {
  return {
    id: s(r['id']), projectId: s(r['project_id']), ownerUserId: s(r['owner_user_id']),
    kind: s(r['kind']) as PossibilityKind, title: s(r['title']),
    requirements: parseJson<PossibilityRequirements>(r['requirements'] as string, {}),
    sourceRef: sn(r['source_ref']), parkedReason: sn(r['parked_reason']),
    shared: Number(r['shared']) === 1, createdAt: s(r['created_at']), updatedAt: s(r['updated_at']),
  };
}

export async function keepPossibility(input: {
  projectId: string; ownerUserId: string; kind: PossibilityKind; title: string;
  requirements: PossibilityRequirements; sourceRef?: string | null; parkedReason?: string | null;
}): Promise<{ possibility: Possibility; created: boolean }> {
  const title = input.title.replace(/\s+/g, ' ').trim();
  if (!title) throw new Error('A possibility must have a title.');
  const id = newId('pos');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO possibilities (id, project_id, owner_user_id, kind, title, requirements,
       source_ref, parked_reason, shared, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?) ON CONFLICT DO NOTHING`,
    [id, input.projectId, input.ownerUserId, input.kind, title, toJson(input.requirements),
      input.sourceRef ?? null, input.parkedReason ?? null, at, at],
  );
  const row = input.sourceRef
    ? await getDb().get<Row>(
        'SELECT * FROM possibilities WHERE project_id = ? AND owner_user_id = ? AND source_ref = ?',
        [input.projectId, input.ownerUserId, input.sourceRef])
    : await getDb().get<Row>('SELECT * FROM possibilities WHERE id = ?', [id]);
  const possibility = mapPossibility(row!);
  return { possibility, created: possibility.id === id };
}

export async function listPossibilities(projectId: string, ownerUserId: string): Promise<Possibility[]> {
  const rows = await getDb().all<Row>(
    'SELECT * FROM possibilities WHERE project_id = ? AND owner_user_id = ? ORDER BY created_at, id',
    [projectId, ownerUserId],
  );
  return rows.map(mapPossibility);
}

export async function linkPossibilities(input: {
  projectId: string; fromId: string; toId: string; relation: PossibilityRelation;
}): Promise<PossibilityEdge> {
  await getDb().run(
    `INSERT INTO possibility_edges (id, project_id, from_id, to_id, relation, created_at)
     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    [newId('ped'), input.projectId, input.fromId, input.toId, input.relation, nowIso()],
  );
  const r = (await getDb().get<Row>(
    'SELECT * FROM possibility_edges WHERE from_id = ? AND relation = ? AND to_id = ?',
    [input.fromId, input.relation, input.toId]))!;
  return {
    id: s(r['id']), projectId: s(r['project_id']), fromId: s(r['from_id']), toId: s(r['to_id']),
    relation: s(r['relation']) as PossibilityRelation, createdAt: s(r['created_at']),
  };
}

function mapCondition(r: Row): PossibilityCondition {
  return {
    id: s(r['id']), projectId: s(r['project_id']), possibilityId: s(r['possibility_id']),
    conditionKey: s(r['condition_key']), createdAt: s(r['created_at']),
    triggeredAt: sn(r['triggered_at']), triggerChangeRef: sn(r['trigger_change_ref']),
  };
}

export async function watchCondition(input: {
  projectId: string; possibilityId: string; conditionKey: string;
}): Promise<PossibilityCondition> {
  await getDb().run(
    `INSERT INTO possibility_conditions (id, project_id, possibility_id, condition_key, created_at)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    [newId('pco'), input.projectId, input.possibilityId, input.conditionKey, nowIso()],
  );
  return mapCondition((await getDb().get<Row>(
    `SELECT * FROM possibility_conditions WHERE possibility_id = ? AND condition_key = ?
       AND triggered_at IS NULL`, [input.possibilityId, input.conditionKey]))!);
}

/** Untriggered watches for one fact, by the indexed key; never a scan of possibilities. */
export async function watchersOf(projectId: string, conditionKey: string): Promise<PossibilityCondition[]> {
  const rows = await getDb().all<Row>(
    `SELECT * FROM possibility_conditions WHERE project_id = ? AND condition_key = ?
       AND triggered_at IS NULL ORDER BY created_at, id`,
    [projectId, conditionKey],
  );
  return rows.map(mapCondition);
}

/** Triggers a watch once, by a guarded UPDATE. Returns whether this call did. */
export async function triggerCondition(conditionId: string, changeRef: string): Promise<boolean> {
  const r = await getDb().run(
    `UPDATE possibility_conditions SET triggered_at = ?, trigger_change_ref = ?
     WHERE id = ? AND triggered_at IS NULL`,
    [nowIso(), changeRef, conditionId],
  );
  return r.changes === 1;
}

export async function recordStageMeasurement(
  input: Omit<StageMeasurement, 'id' | 'measuredAt' | 'note'> & { note?: string | null },
): Promise<StageMeasurement> {
  const id = newId('smm');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO stage_measurements (id, project_id, owner_user_id, goal_id, stage, duration_ms,
       screened, rejected, advanced, research_jobs, premium_ai_jobs, note, measured_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.projectId, input.ownerUserId, input.goalId, input.stage, input.durationMs,
      input.screened, input.rejected, input.advanced, input.researchJobs, input.premiumAiJobs,
      input.note ?? null, at],
  );
  return { ...input, id, note: input.note ?? null, measuredAt: at };
}

export async function stageMeasurements(
  projectId: string, ownerUserId: string, goalId: string,
): Promise<StageMeasurement[]> {
  const rows = await getDb().all<Row>(
    `SELECT * FROM stage_measurements WHERE project_id = ? AND owner_user_id = ? AND goal_id = ?
     ORDER BY measured_at, id`, [projectId, ownerUserId, goalId]);
  return rows.map((r) => ({
    id: s(r['id']), projectId: s(r['project_id']), ownerUserId: s(r['owner_user_id']),
    goalId: s(r['goal_id']), stage: s(r['stage']) as Stage, durationMs: Number(r['duration_ms']),
    screened: Number(r['screened']), rejected: Number(r['rejected']), advanced: Number(r['advanced']),
    researchJobs: Number(r['research_jobs']), premiumAiJobs: Number(r['premium_ai_jobs']),
    note: sn(r['note']), measuredAt: s(r['measured_at']),
  }));
}
