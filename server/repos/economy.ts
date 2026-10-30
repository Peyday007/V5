/**
 * Economic relationships and per-activity variables.
 *
 * Reads are scoped by project and user: a private row is visible to its owner
 * only, and a row with no owner is general knowledge shared inside the project.
 * Writes are idempotent by a unique index, and a variable is append-only — a
 * new reading supersedes the current one without deleting it (§5).
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso } from './util.ts';
import { evidenceProblem } from '../domain/economy.ts';
import type {
  ActivityVariable,
  ActivityVariableRow,
  EconomicEdge,
  EconomicEdgeRow,
  EconomicRelation,
  EndpointKind,
  EvidenceStatus,
  OperatorKind,
} from '../domain/economy.ts';

function mapEdge(row: EconomicEdgeRow): EconomicEdge {
  return {
    id: row.id,
    projectId: row.project_id,
    ownerUserId: row.owner_user_id,
    fromKind: row.from_kind as EndpointKind,
    fromId: row.from_id,
    toKind: row.to_kind as EndpointKind,
    toId: row.to_id,
    relation: row.relation as EconomicRelation,
    status: row.status as EvidenceStatus,
    sourceClaimId: row.source_claim_id,
    basis: row.basis,
    operatorKind: row.operator_kind as OperatorKind | null,
    createdAt: row.created_at,
    retiredAt: row.retired_at,
  };
}

function mapVariable(row: ActivityVariableRow): ActivityVariable {
  return {
    id: row.id,
    projectId: row.project_id,
    ownerUserId: row.owner_user_id,
    activityId: row.activity_id,
    name: row.name,
    valueNumber: row.value_number,
    valueText: row.value_text,
    unit: row.unit,
    status: row.status as EvidenceStatus,
    sourceClaimId: row.source_claim_id,
    basis: row.basis,
    operatorKind: row.operator_kind as OperatorKind,
    createdAt: row.created_at,
    supersededAt: row.superseded_at,
  };
}

/** Record a relationship, or find the one already recorded. */
export async function recordEdge(input: {
  projectId: string;
  ownerUserId: string | null;
  fromKind: EndpointKind;
  fromId: string;
  toKind: EndpointKind;
  toId: string;
  relation: EconomicRelation;
  status: EvidenceStatus;
  sourceClaimId?: string | null;
  basis?: string | null;
  operatorKind?: OperatorKind | null;
}): Promise<{ edge: EconomicEdge; created: boolean }> {
  const problem = evidenceProblem(input);
  if (problem) throw new Error(problem);
  const id = newId('eec');
  await getDb().run(
    `INSERT INTO economic_edges
       (id, project_id, owner_user_id, from_kind, from_id, to_kind, to_id, relation, status,
        source_claim_id, basis, operator_kind, created_at, retired_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT DO NOTHING`,
    [
      id, input.projectId, input.ownerUserId, input.fromKind, input.fromId, input.toKind, input.toId,
      input.relation, input.status, input.sourceClaimId ?? null, input.basis ?? null,
      input.operatorKind ?? null, nowIso(),
    ],
  );
  const rows = await getDb().all<EconomicEdgeRow>(
    `SELECT * FROM economic_edges
      WHERE project_id = ? AND from_kind = ? AND from_id = ? AND to_kind = ? AND to_id = ? AND relation = ?`,
    [input.projectId, input.fromKind, input.fromId, input.toKind, input.toId, input.relation],
  );
  if (!rows[0]) throw new Error('The economic edge disappeared immediately after being written.');
  return { edge: mapEdge(rows[0]), created: rows[0].id === id };
}

/** Live edges touching one endpoint, as seen by one user. */
export async function listEdgesAt(
  projectId: string,
  userId: string,
  endpointId: string,
): Promise<EconomicEdge[]> {
  const rows = await getDb().all<EconomicEdgeRow>(
    `SELECT * FROM economic_edges
      WHERE project_id = ? AND (from_id = ? OR to_id = ?) AND retired_at IS NULL
        AND (owner_user_id = ? OR owner_user_id IS NULL)
      ORDER BY created_at ASC, id ASC`,
    [projectId, endpointId, endpointId, userId],
  );
  return rows.map(mapEdge);
}

/** Retire an edge. The row stays; only a live edge can be retired. */
export async function retireEdge(projectId: string, edgeId: string): Promise<boolean> {
  const before = await getDb().all<{ id: string }>(
    'SELECT id FROM economic_edges WHERE id = ? AND project_id = ? AND retired_at IS NULL',
    [edgeId, projectId],
  );
  if (!before[0]) return false;
  await getDb().run(
    'UPDATE economic_edges SET retired_at = ? WHERE id = ? AND project_id = ? AND retired_at IS NULL',
    [nowIso(), edgeId, projectId],
  );
  return true;
}

/**
 * Record a reading of one variable. The current reading for the same
 * (activity, name, operator kind) is superseded, never overwritten.
 */
export async function recordVariable(input: {
  projectId: string;
  ownerUserId: string | null;
  activityId: string;
  name: string;
  valueNumber?: number | null;
  valueText?: string | null;
  unit?: string | null;
  status: EvidenceStatus;
  sourceClaimId?: string | null;
  basis?: string | null;
  operatorKind: OperatorKind;
}): Promise<ActivityVariable> {
  const name = input.name.trim();
  if (!name) throw new Error('A variable must have a name.');
  const problem = evidenceProblem(input);
  if (problem) throw new Error(problem);
  if (input.valueNumber != null && !Number.isFinite(input.valueNumber)) {
    throw new Error('A variable value must be a finite number.');
  }
  const id = newId('eav');
  const at = nowIso();
  await getDb().transaction(async () => {
    await getDb().run(
      `UPDATE activity_variables SET superseded_at = ?
        WHERE project_id = ? AND activity_id = ? AND name = ? AND operator_kind = ? AND superseded_at IS NULL`,
      [at, input.projectId, input.activityId, name, input.operatorKind],
    );
    await getDb().run(
      `INSERT INTO activity_variables
         (id, project_id, owner_user_id, activity_id, name, value_number, value_text, unit, status,
          source_claim_id, basis, operator_kind, created_at, superseded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      [
        id, input.projectId, input.ownerUserId, input.activityId, name, input.valueNumber ?? null,
        input.valueText ?? null, input.unit ?? null, input.status, input.sourceClaimId ?? null,
        input.basis ?? null, input.operatorKind, at,
      ],
    );
  });
  const rows = await getDb().all<ActivityVariableRow>('SELECT * FROM activity_variables WHERE id = ?', [id]);
  return mapVariable(rows[0]!);
}

/** The current readings for one activity, as seen by one user. */
export async function currentVariables(
  projectId: string,
  userId: string,
  activityId: string,
): Promise<ActivityVariable[]> {
  const rows = await getDb().all<ActivityVariableRow>(
    `SELECT * FROM activity_variables
      WHERE project_id = ? AND activity_id = ? AND superseded_at IS NULL
        AND (owner_user_id = ? OR owner_user_id IS NULL)
      ORDER BY name ASC, operator_kind ASC`,
    [projectId, activityId, userId],
  );
  return rows.map(mapVariable);
}
