/**
 * Economic edges, per-activity variables and stage measurements. Every read is
 * scoped by project and user: a private row (owner_user_id set) answers only
 * its owner.
 */
import { getDb } from '../db/database.ts';
import type { SqlParam } from '../db/types.ts';
import { newId, nowIso } from './util.ts';
import {
  evidenceProblem,
  type ActivityVariable,
  type EconomicEdge,
  type EconomicRelation,
  type EconomyViewer,
  type EdgeEndpointKind,
  type EvidenceStatus,
  type MeasurementStage,
  type OperatorKind,
  type StageMeasurement,
} from '../domain/economy.ts';

/** Shared rows of the project, plus the viewer's own private ones. */
function scope(viewer: EconomyViewer): { sql: string; params: SqlParam[] } {
  return viewer.userId
    ? { sql: '(project_id = ? AND (owner_user_id IS NULL OR owner_user_id = ?))', params: [viewer.projectId, viewer.userId] }
    : { sql: '(project_id = ? AND owner_user_id IS NULL)', params: [viewer.projectId] };
}

const num = (v: number | string | null): number | null => (v === null ? null : Number(v));

// ------------------------------------------------------------------- edges

interface EdgeRow {
  id: string; project_id: string; owner_user_id: string | null; from_kind: EdgeEndpointKind; from_ref: string;
  relation: EconomicRelation; to_kind: EdgeEndpointKind; to_ref: string; status: EvidenceStatus;
  claim_id: string | null; basis: string | null; operator_kind: OperatorKind; created_at: string;
}
const toEdge = (r: EdgeRow): EconomicEdge => ({
  id: r.id, projectId: r.project_id, ownerUserId: r.owner_user_id, fromKind: r.from_kind, fromRef: r.from_ref,
  relation: r.relation, toKind: r.to_kind, toRef: r.to_ref, status: r.status, claimId: r.claim_id,
  basis: r.basis, operatorKind: r.operator_kind, createdAt: r.created_at,
});

/** The same edge for the same kind of operator is one row; the first stays. */
export async function recordEconomicEdge(input: {
  projectId: string; ownerUserId?: string | null;
  fromKind: EdgeEndpointKind; fromRef: string; relation: EconomicRelation; toKind: EdgeEndpointKind; toRef: string;
  status: EvidenceStatus; claimId?: string | null; basis?: string | null; operatorKind: OperatorKind;
}): Promise<EconomicEdge> {
  const problem = evidenceProblem(input);
  if (problem) throw new Error(problem);
  await getDb().run(
    `INSERT INTO economic_edges
       (id, project_id, owner_user_id, from_kind, from_ref, relation, to_kind, to_ref, status, claim_id, basis, operator_kind, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [newId('eed'), input.projectId, input.ownerUserId ?? null, input.fromKind, input.fromRef, input.relation, input.toKind,
      input.toRef, input.status, input.claimId ?? null, input.basis ?? null, input.operatorKind, nowIso()],
  );
  const row = await getDb().get<EdgeRow>(
    `SELECT * FROM economic_edges WHERE project_id = ? AND from_kind = ? AND from_ref = ? AND relation = ?
        AND to_kind = ? AND to_ref = ? AND operator_kind = ?`,
    [input.projectId, input.fromKind, input.fromRef, input.relation, input.toKind, input.toRef, input.operatorKind],
  );
  return toEdge(row!);
}

export async function edgesFrom(viewer: EconomyViewer, fromKind: EdgeEndpointKind, fromRef: string): Promise<EconomicEdge[]> {
  const s = scope(viewer);
  const rows = await getDb().all<EdgeRow>(
    `SELECT * FROM economic_edges WHERE ${s.sql} AND from_kind = ? AND from_ref = ? ORDER BY created_at, id`,
    [...s.params, fromKind, fromRef],
  );
  return rows.map(toEdge);
}

export async function edgesTo(viewer: EconomyViewer, toKind: EdgeEndpointKind, toRef: string): Promise<EconomicEdge[]> {
  const s = scope(viewer);
  const rows = await getDb().all<EdgeRow>(
    `SELECT * FROM economic_edges WHERE ${s.sql} AND to_kind = ? AND to_ref = ? ORDER BY created_at, id`,
    [...s.params, toKind, toRef],
  );
  return rows.map(toEdge);
}

// --------------------------------------------------------------- variables

interface VariableRow {
  id: string; project_id: string; owner_user_id: string | null; activity_ref: string; name: string;
  value_num: number | string | null; value_text: string | null; unit: string | null; status: EvidenceStatus;
  claim_id: string | null; basis: string | null; operator_kind: OperatorKind; created_at: string; updated_at: string;
}
const toVariable = (r: VariableRow): ActivityVariable => ({
  id: r.id, projectId: r.project_id, ownerUserId: r.owner_user_id, activityRef: r.activity_ref, name: r.name,
  valueNum: num(r.value_num), valueText: r.value_text, unit: r.unit, status: r.status, claimId: r.claim_id,
  basis: r.basis, operatorKind: r.operator_kind, createdAt: r.created_at, updatedAt: r.updated_at,
});

/**
 * Set a variable. An UNKNOWN never carries a value, and a stronger reading is
 * never replaced by a weaker one: VERIFIED > ESTIMATE > UNKNOWN.
 */
export async function setActivityVariable(input: {
  projectId: string; ownerUserId?: string | null; activityRef: string; name: string;
  valueNum?: number | null; valueText?: string | null; unit?: string | null;
  status: EvidenceStatus; claimId?: string | null; basis?: string | null; operatorKind: OperatorKind;
}): Promise<{ variable: ActivityVariable; written: boolean }> {
  const problem = evidenceProblem(input);
  if (problem) throw new Error(problem);
  if (input.status === 'UNKNOWN' && (input.valueNum != null || input.valueText != null)) {
    throw new Error('An UNKNOWN variable carries no value.');
  }
  const key = [input.projectId, input.activityRef, input.name, input.operatorKind];
  const find = () => getDb().get<VariableRow>(
    'SELECT * FROM activity_variables WHERE project_id = ? AND activity_ref = ? AND name = ? AND operator_kind = ?', key);
  const existing = await find();
  const at = nowIso();
  if (!existing) {
    await getDb().run(
      `INSERT INTO activity_variables
         (id, project_id, owner_user_id, activity_ref, name, value_num, value_text, unit, status, claim_id, basis, operator_kind, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      [newId('avr'), input.projectId, input.ownerUserId ?? null, input.activityRef, input.name, input.valueNum ?? null,
        input.valueText ?? null, input.unit ?? null, input.status, input.claimId ?? null, input.basis ?? null,
        input.operatorKind, at, at],
    );
    return { variable: toVariable((await find())!), written: true };
  }
  const rank: Record<EvidenceStatus, number> = { UNKNOWN: 0, ESTIMATE: 1, VERIFIED: 2 };
  if (rank[input.status] < rank[existing.status]) return { variable: toVariable(existing), written: false };
  await getDb().run(
    `UPDATE activity_variables SET value_num = ?, value_text = ?, unit = ?, status = ?, claim_id = ?, basis = ?, updated_at = ?
      WHERE id = ?`,
    [input.valueNum ?? null, input.valueText ?? null, input.unit ?? null, input.status, input.claimId ?? null,
      input.basis ?? null, at, existing.id],
  );
  return { variable: toVariable((await find())!), written: true };
}

export async function variablesFor(viewer: EconomyViewer, activityRef: string): Promise<ActivityVariable[]> {
  const s = scope(viewer);
  const rows = await getDb().all<VariableRow>(
    `SELECT * FROM activity_variables WHERE ${s.sql} AND activity_ref = ? ORDER BY name, operator_kind`,
    [...s.params, activityRef],
  );
  return rows.map(toVariable);
}

// ------------------------------------------------------------ measurements

interface MeasurementRow {
  id: string; project_id: string; owner_user_id: string | null; goal_id: string; stage: MeasurementStage;
  duration_ms: number | string | null; screened: number | string | null; rejected: number | string | null;
  advanced: number | string | null; research_jobs: number | string | null; premium_jobs: number | string | null;
  note: string | null; recorded_at: string;
}

/** Record what was measured; a field left out stays null (not measured), never zero. */
export async function recordStageMeasurement(input: {
  projectId: string; ownerUserId?: string | null; goalId: string; stage: MeasurementStage;
  durationMs?: number | null; screened?: number | null; rejected?: number | null; advanced?: number | null;
  researchJobs?: number | null; premiumJobs?: number | null; note?: string | null; recordedAt?: string;
}): Promise<string> {
  const id = newId('smm');
  await getDb().run(
    `INSERT INTO stage_measurements
       (id, project_id, owner_user_id, goal_id, stage, duration_ms, screened, rejected, advanced, research_jobs, premium_jobs, note, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.projectId, input.ownerUserId ?? null, input.goalId, input.stage, input.durationMs ?? null,
      input.screened ?? null, input.rejected ?? null, input.advanced ?? null, input.researchJobs ?? null,
      input.premiumJobs ?? null, input.note ?? null, input.recordedAt ?? nowIso()],
  );
  return id;
}

export async function stageMeasurements(viewer: EconomyViewer, goalId: string, stage?: MeasurementStage): Promise<StageMeasurement[]> {
  const s = scope(viewer);
  const rows = await getDb().all<MeasurementRow>(
    `SELECT * FROM stage_measurements WHERE ${s.sql} AND goal_id = ?${stage ? ' AND stage = ?' : ''} ORDER BY recorded_at, id`,
    stage ? [...s.params, goalId, stage] : [...s.params, goalId],
  );
  return rows.map((r) => ({
    id: r.id, projectId: r.project_id, ownerUserId: r.owner_user_id, goalId: r.goal_id, stage: r.stage,
    durationMs: num(r.duration_ms), screened: num(r.screened), rejected: num(r.rejected), advanced: num(r.advanced),
    researchJobs: num(r.research_jobs), premiumJobs: num(r.premium_jobs), note: r.note, recordedAt: r.recorded_at,
  }));
}
