/**
 * Objectives, the steps a decision about one turned into, and the history of
 * what Brain recommended.
 *
 * The objective holds an intent and nothing about progress. Steps are pointers
 * to work items that other parts of Brain own; their state is the state of the
 * thing they point at. Decisions are append-only. See migration 092.
 */
import { getDb } from '../db/database.ts';
import type { SqlParam } from '../db/types.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';
import type { DecisionVerdict, StepKind } from '../domain/decision.ts';

export type ObjectiveSourceKind = 'CASH_MODE' | 'CONVERSATION';

export interface Objective {
  id: string;
  projectId: string;
  conversationId: string | null;
  statement: string;
  sourceKind: ObjectiveSourceKind;
  sourceRef: string;
  createdByUserId: string;
  closedAt: string | null;
  closedReason: string | null;
  closedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ObjectiveRow {
  id: string;
  project_id: string;
  conversation_id: string | null;
  statement: string;
  source_kind: string;
  source_ref: string;
  created_by_user_id: string;
  closed_at: string | null;
  closed_reason: string | null;
  closed_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

function toObjective(row: ObjectiveRow): Objective {
  return {
    id: row.id,
    projectId: row.project_id,
    conversationId: row.conversation_id,
    statement: row.statement,
    sourceKind: row.source_kind as ObjectiveSourceKind,
    sourceRef: row.source_ref,
    createdByUserId: row.created_by_user_id,
    closedAt: row.closed_at,
    closedReason: row.closed_reason,
    closedByUserId: row.closed_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The live objective for a source, created if there is none.
 *
 * `ON CONFLICT DO NOTHING` against the partial unique index, then a read-back:
 * two requests adopting the same sprint objective produce one row, and the
 * loser is an ordinary outcome. A later asking in a different thread moves
 * where results are reported, and nothing else.
 */
export async function ensureObjective(input: {
  projectId: string;
  statement: string;
  sourceKind: ObjectiveSourceKind;
  sourceRef: string;
  conversationId: string | null;
  createdByUserId: string;
}): Promise<{ objective: Objective; created: boolean }> {
  const db = getDb();
  const id = newId('obj');
  const now = nowIso();
  await db.run(
    `INSERT INTO russell_objectives
       (id, project_id, conversation_id, statement, source_kind, source_ref,
        created_by_user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      input.conversationId,
      input.statement,
      input.sourceKind,
      input.sourceRef,
      input.createdByUserId,
      now,
      now,
    ],
  );
  const row = await db.get<ObjectiveRow>(
    `SELECT * FROM russell_objectives
      WHERE project_id = ? AND source_kind = ? AND source_ref = ? AND closed_at IS NULL`,
    [input.projectId, input.sourceKind, input.sourceRef],
  );
  if (!row) throw new Error('an objective that was just written could not be read back');
  const created = row.id === id;
  if (!created && input.conversationId && row.conversation_id !== input.conversationId) {
    await db.run(
      'UPDATE russell_objectives SET conversation_id = ?, updated_at = ? WHERE id = ?',
      [input.conversationId, now, row.id],
    );
    row.conversation_id = input.conversationId;
  }
  return { objective: toObjective(row), created };
}

export async function getObjective(id: string): Promise<Objective | null> {
  const row = await getDb().get<ObjectiveRow>('SELECT * FROM russell_objectives WHERE id = ?', [id]);
  return row ? toObjective(row) : null;
}

export async function listObjectives(input: {
  projectId?: string;
  conversationId?: string;
  includeClosed?: boolean;
}): Promise<Objective[]> {
  const where: string[] = [];
  const params: SqlParam[] = [];
  if (input.projectId) {
    where.push('project_id = ?');
    params.push(input.projectId);
  }
  if (input.conversationId) {
    where.push('conversation_id = ?');
    params.push(input.conversationId);
  }
  if (!input.includeClosed) where.push('closed_at IS NULL');
  const rows = await getDb().all<ObjectiveRow>(
    `SELECT * FROM russell_objectives
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at, id`,
    params,
  );
  return rows.map(toObjective);
}

/** A person saying this objective is finished with. Guarded on it still being live. */
export async function closeObjective(input: {
  id: string;
  reason: string;
  userId: string;
}): Promise<boolean> {
  const now = nowIso();
  const result = await getDb().run(
    `UPDATE russell_objectives
        SET closed_at = ?, closed_reason = ?, closed_by_user_id = ?, updated_at = ?
      WHERE id = ? AND closed_at IS NULL`,
    [now, input.reason, input.userId, now, input.id],
  );
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export interface ObjectiveStep {
  id: string;
  objectiveId: string;
  kind: StepKind;
  pathRef: string;
  serves: string | null;
  description: string;
  workKind: string | null;
  workRef: string | null;
  authority: 'AUTHORIZED' | 'NEEDS_PERSON';
  boundary: string | null;
  prepared: Record<string, unknown> | null;
  stepKey: string;
  supersededAt: string | null;
  supersededReason: string | null;
  createdAt: string;
  updatedAt: string;
}

interface StepRow {
  id: string;
  objective_id: string;
  kind: string;
  path_ref: string;
  serves: string | null;
  description: string;
  work_kind: string | null;
  work_ref: string | null;
  authority: string;
  boundary: string | null;
  prepared: string | null;
  step_key: string;
  superseded_at: string | null;
  superseded_reason: string | null;
  created_at: string;
  updated_at: string;
}

function toStep(row: StepRow): ObjectiveStep {
  return {
    id: row.id,
    objectiveId: row.objective_id,
    kind: row.kind as StepKind,
    pathRef: row.path_ref,
    serves: row.serves,
    description: row.description,
    workKind: row.work_kind,
    workRef: row.work_ref,
    authority: row.authority as 'AUTHORIZED' | 'NEEDS_PERSON',
    boundary: row.boundary,
    prepared: parseJson<Record<string, unknown> | null>(row.prepared, null),
    stepKey: row.step_key,
    supersededAt: row.superseded_at,
    supersededReason: row.superseded_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Record a step, once per key.
 *
 * The unique index on `(objective_id, step_key)` is the whole concurrency
 * design: two ticks taking the same step insert one row, and the loser reads
 * back the winner's.
 */
export async function recordStep(input: {
  objectiveId: string;
  kind: StepKind;
  pathRef: string;
  serves: string | null;
  description: string;
  workKind: string | null;
  workRef: string | null;
  authority: 'AUTHORIZED' | 'NEEDS_PERSON';
  boundary: string | null;
  prepared: Record<string, unknown> | null;
  stepKey: string;
}): Promise<{ step: ObjectiveStep; created: boolean }> {
  const db = getDb();
  const id = newId('ost');
  const now = nowIso();
  await db.run(
    `INSERT INTO russell_objective_steps
       (id, objective_id, kind, path_ref, serves, description, work_kind, work_ref,
        authority, boundary, prepared, step_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.objectiveId,
      input.kind,
      input.pathRef,
      input.serves,
      input.description,
      input.workKind,
      input.workRef,
      input.authority,
      input.boundary,
      input.prepared ? toJson(input.prepared) : null,
      input.stepKey,
      now,
      now,
    ],
  );
  const row = await db.get<StepRow>(
    'SELECT * FROM russell_objective_steps WHERE objective_id = ? AND step_key = ?',
    [input.objectiveId, input.stepKey],
  );
  if (!row) throw new Error('a step that was just written could not be read back');
  return { step: toStep(row), created: row.id === id };
}

export async function listSteps(objectiveId: string): Promise<ObjectiveStep[]> {
  const rows = await getDb().all<StepRow>(
    'SELECT * FROM russell_objective_steps WHERE objective_id = ? ORDER BY created_at, id',
    [objectiveId],
  );
  return rows.map(toStep);
}

/** Mark a step as no longer the one Brain is taking. Keeps the row. */
export async function supersedeStep(id: string, reason: string): Promise<boolean> {
  const now = nowIso();
  const result = await getDb().run(
    `UPDATE russell_objective_steps SET superseded_at = ?, superseded_reason = ?, updated_at = ?
      WHERE id = ? AND superseded_at IS NULL`,
    [now, reason, now, id],
  );
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Decisions — append-only
// ---------------------------------------------------------------------------

export interface ObjectiveDecision {
  id: string;
  objectiveId: string;
  verdict: DecisionVerdict;
  pathRef: string | null;
  fingerprint: string;
  summary: string;
  changedBecause: string | null;
  messageId: string | null;
  createdAt: string;
}

interface DecisionRow {
  id: string;
  objective_id: string;
  verdict: string;
  path_ref: string | null;
  fingerprint: string;
  summary: string;
  changed_because: string | null;
  message_id: string | null;
  created_at: string;
}

function toDecision(row: DecisionRow): ObjectiveDecision {
  return {
    id: row.id,
    objectiveId: row.objective_id,
    verdict: row.verdict as DecisionVerdict,
    pathRef: row.path_ref,
    fingerprint: row.fingerprint,
    summary: row.summary,
    changedBecause: row.changed_because,
    messageId: row.message_id,
    createdAt: row.created_at,
  };
}

/** Record which message reported a decision, once it has been posted. */
export async function setDecisionMessage(id: string, messageId: string): Promise<void> {
  await getDb().run(
    'UPDATE russell_objective_decisions SET message_id = ? WHERE id = ? AND message_id IS NULL',
    [messageId, id],
  );
}

export async function listDecisions(objectiveId: string): Promise<ObjectiveDecision[]> {
  const rows = await getDb().all<DecisionRow>(
    'SELECT * FROM russell_objective_decisions WHERE objective_id = ? ORDER BY created_at, id',
    [objectiveId],
  );
  return rows.map(toDecision);
}

export async function latestDecision(objectiveId: string): Promise<ObjectiveDecision | null> {
  const all = await listDecisions(objectiveId);
  return all[all.length - 1] ?? null;
}

/**
 * Append a decision after `followsId` (null for the first), once.
 *
 * Returns null when another pass already appended the decision that follows
 * the same predecessor — the loser of the race, an ordinary outcome.
 */
export async function appendDecision(input: {
  objectiveId: string;
  followsId: string | null;
  verdict: DecisionVerdict;
  pathRef: string | null;
  fingerprint: string;
  summary: string;
  changedBecause: string | null;
  messageId: string | null;
}): Promise<ObjectiveDecision | null> {
  const id = newId('odc');
  const now = nowIso();
  const result = await getDb().run(
    `INSERT INTO russell_objective_decisions
       (id, objective_id, verdict, path_ref, fingerprint, follows_id, summary, changed_because, message_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.objectiveId,
      input.verdict,
      input.pathRef,
      input.fingerprint,
      input.followsId ?? '-',
      input.summary,
      input.changedBecause,
      input.messageId,
      now,
    ],
  );
  if (result.changes === 0) return null;
  return {
    id,
    objectiveId: input.objectiveId,
    verdict: input.verdict,
    pathRef: input.pathRef,
    fingerprint: input.fingerprint,
    summary: input.summary,
    changedBecause: input.changedBecause,
    messageId: input.messageId,
    createdAt: now,
  };
}

/**
 * The openings a live objective has steered the deep dive towards.
 *
 * Read by `startValidations` to order its queue. A preference and never a
 * ceiling: nothing is refused because of it, and the slot bound is unchanged.
 */
export async function steeredOpenings(projectId: string): Promise<string[]> {
  const rows = await getDb().all<{ work_ref: string }>(
    `SELECT s.work_ref
       FROM russell_objective_steps s
       JOIN russell_objectives o ON o.id = s.objective_id
      WHERE o.project_id = ? AND o.closed_at IS NULL
        AND s.kind = 'QUALIFY_OPENING' AND s.superseded_at IS NULL
        AND s.work_kind = 'OPPORTUNITY' AND s.work_ref IS NOT NULL
      ORDER BY s.created_at, s.id`,
    [projectId],
  );
  return rows.map((row) => row.work_ref);
}
