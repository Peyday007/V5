/**
 * The improvement register's rows (§87, migration 136 / pg 127).
 *
 * `improvement_candidates` stores a weakness, the links to the work carrying
 * it and Brain's decision; the stage between is derived from the linked rows.
 * `improvement_events` is append-only.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';
import type { ImprovementCandidateRow, ImprovementEventRow } from '../domain/types.ts';
import type { SqlParam } from '../db/types.ts';
import type { Decision, MetricKey, Severity, WeaknessScope } from '../domain/improvement.ts';

export interface ImprovementCandidate {
  id: string;
  weaknessKey: string;
  kind: string;
  title: string;
  problem: string;
  metric: MetricKey;
  downstreamMetric: MetricKey | null;
  ownerComponent: string;
  frequency: number;
  denominator: number;
  scope: WeaknessScope;
  severity: Severity;
  evidence: Record<string, unknown>;
  proposal: string | null;
  dependencyCheck: Record<string, unknown> | null;
  researchGoalId: string | null;
  changeRequestId: string | null;
  campaignId: string | null;
  deliveredAt: string | null;
  deliveredRef: string | null;
  baseline: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  decision: Decision | null;
  decisionReason: string | null;
  combinedIntoId: string | null;
  heldOn: string | null;
  attempt: number;
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
}

function map(row: ImprovementCandidateRow): ImprovementCandidate {
  return {
    id: row.id,
    weaknessKey: row.weakness_key,
    kind: row.kind,
    title: row.title,
    problem: row.problem,
    metric: row.metric_key as MetricKey,
    downstreamMetric: (row.downstream_metric as MetricKey | null) ?? null,
    ownerComponent: row.owner_component,
    frequency: Number(row.frequency),
    denominator: Number(row.denominator),
    scope: row.scope as WeaknessScope,
    severity: row.severity as Severity,
    evidence: parseJson<Record<string, unknown>>(row.evidence, {}),
    proposal: row.proposal,
    dependencyCheck: parseJson<Record<string, unknown> | null>(row.dependency_check, null),
    researchGoalId: row.research_goal_id,
    changeRequestId: row.change_request_id,
    campaignId: row.campaign_id,
    deliveredAt: row.delivered_at,
    deliveredRef: row.delivered_ref,
    baseline: parseJson<Record<string, unknown> | null>(row.baseline, null),
    result: parseJson<Record<string, unknown> | null>(row.result, null),
    decision: (row.decision as Decision | null) ?? null,
    decisionReason: row.decision_reason,
    combinedIntoId: row.combined_into_id,
    heldOn: row.held_on,
    attempt: Number(row.attempt),
    parentId: row.parent_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CandidateInput {
  weaknessKey: string;
  kind: string;
  title: string;
  problem: string;
  metric: MetricKey;
  downstreamMetric: MetricKey | null;
  ownerComponent: string;
  frequency: number;
  denominator: number;
  scope: WeaknessScope;
  severity: Severity;
  evidence: Record<string, unknown>;
  attempt?: number;
  parentId?: string | null;
}

/** Insert a candidate, or refresh the observation on the one that exists. Idempotent by weakness key. */
export async function upsertCandidate(input: CandidateInput): Promise<{ candidate: ImprovementCandidate; created: boolean }> {
  const at = nowIso();
  const id = newId('imp');
  await getDb().run(
    `INSERT INTO improvement_candidates
       (id, weakness_key, kind, title, problem, metric_key, downstream_metric, owner_component,
        frequency, denominator, scope, severity, evidence, attempt, parent_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (weakness_key) DO NOTHING`,
    [
      id,
      input.weaknessKey,
      input.kind,
      input.title,
      input.problem,
      input.metric,
      input.downstreamMetric,
      input.ownerComponent,
      input.frequency,
      input.denominator,
      input.scope,
      input.severity,
      toJson(input.evidence),
      input.attempt ?? 1,
      input.parentId ?? null,
      at,
      at,
    ],
  );
  const existing = await getCandidateByKey(input.weaknessKey);
  if (!existing) throw new Error('The improvement candidate disappeared immediately after being written.');
  const created = existing.id === id;
  if (!created && !existing.decision) {
    // A live candidate's observation is refreshed; a decided one keeps the record it was decided on.
    await getDb().run(
      `UPDATE improvement_candidates SET frequency = ?, denominator = ?, severity = ?, evidence = ?, updated_at = ?
        WHERE id = ? AND decision IS NULL`,
      [input.frequency, input.denominator, input.severity, toJson({ ...existing.evidence, ...input.evidence }), at, existing.id],
    );
  }
  return { candidate: (await getCandidate(existing.id))!, created };
}

export async function getCandidate(id: string): Promise<ImprovementCandidate | null> {
  const row = await getDb().get<ImprovementCandidateRow>('SELECT * FROM improvement_candidates WHERE id = ?', [id]);
  return row ? map(row) : null;
}

export async function getCandidateByKey(key: string): Promise<ImprovementCandidate | null> {
  const row = await getDb().get<ImprovementCandidateRow>('SELECT * FROM improvement_candidates WHERE weakness_key = ?', [key]);
  return row ? map(row) : null;
}

export async function listCandidates(options: { open?: boolean } = {}): Promise<ImprovementCandidate[]> {
  const rows = await getDb().all<ImprovementCandidateRow>(
    `SELECT * FROM improvement_candidates ${options.open ? 'WHERE decision IS NULL' : ''} ORDER BY created_at, id`,
    [],
  );
  return rows.map(map);
}

export type CandidatePatch = Partial<{
  proposal: string | null;
  dependencyCheck: Record<string, unknown> | null;
  researchGoalId: string | null;
  changeRequestId: string | null;
  campaignId: string | null;
  deliveredAt: string | null;
  deliveredRef: string | null;
  baseline: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  evidence: Record<string, unknown>;
}>;

const COLUMNS: Record<keyof CandidatePatch, string> = {
  proposal: 'proposal',
  dependencyCheck: 'dependency_check',
  researchGoalId: 'research_goal_id',
  changeRequestId: 'change_request_id',
  campaignId: 'campaign_id',
  deliveredAt: 'delivered_at',
  deliveredRef: 'delivered_ref',
  baseline: 'baseline',
  result: 'result',
  evidence: 'evidence',
};
const JSON_COLUMNS = new Set<keyof CandidatePatch>(['dependencyCheck', 'baseline', 'result', 'evidence']);

/** Patch a live candidate. A decided candidate is never edited (its record is history). */
export async function patchCandidate(id: string, patch: CandidatePatch): Promise<boolean> {
  const sets: string[] = [];
  const values: SqlParam[] = [];
  for (const [key, value] of Object.entries(patch) as [keyof CandidatePatch, unknown][]) {
    if (value === undefined) continue;
    sets.push(`${COLUMNS[key]} = ?`);
    values.push((JSON_COLUMNS.has(key) && value !== null ? toJson(value) : value) as SqlParam);
  }
  if (sets.length === 0) return false;
  sets.push('updated_at = ?');
  values.push(nowIso(), id);
  const result = await getDb().run(
    `UPDATE improvement_candidates SET ${sets.join(', ')} WHERE id = ? AND decision IS NULL`,
    values,
  );
  return Number(result.changes ?? 0) > 0;
}

/** Decide a candidate, once: the guard is in the statement. */
export async function decideCandidate(
  id: string,
  decision: Decision,
  reason: string,
  extra: { combinedIntoId?: string | null; heldOn?: string | null; result?: Record<string, unknown> | null } = {},
): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE improvement_candidates
        SET decision = ?, decision_reason = ?, combined_into_id = ?, held_on = ?, result = COALESCE(?, result), updated_at = ?
      WHERE id = ? AND decision IS NULL`,
    [decision, reason, extra.combinedIntoId ?? null, extra.heldOn ?? null, extra.result ? toJson(extra.result) : null, nowIso(), id],
  );
  return Number(result.changes ?? 0) > 0;
}

export async function recordImprovementEvent(input: {
  candidateId: string | null;
  kind: string;
  detail?: Record<string, unknown>;
  at?: string;
}): Promise<void> {
  await getDb().run(
    'INSERT INTO improvement_events (id, candidate_id, kind, detail, at) VALUES (?, ?, ?, ?, ?)',
    [newId('ime'), input.candidateId, input.kind, toJson(input.detail ?? {}), input.at ?? nowIso()],
  );
}

export interface ImprovementEvent {
  id: string;
  candidateId: string | null;
  kind: string;
  detail: Record<string, unknown>;
  at: string;
}

export async function listImprovementEvents(options: { candidateId?: string; kinds?: string[]; since?: string; limit?: number } = {}): Promise<ImprovementEvent[]> {
  const where: string[] = [];
  const params: SqlParam[] = [];
  if (options.candidateId) {
    where.push('candidate_id = ?');
    params.push(options.candidateId);
  }
  if (options.kinds && options.kinds.length > 0) {
    where.push(`kind IN (${options.kinds.map(() => '?').join(', ')})`);
    params.push(...options.kinds);
  }
  if (options.since) {
    where.push('at >= ?');
    params.push(options.since);
  }
  params.push(options.limit ?? 200);
  const rows = await getDb().all<ImprovementEventRow>(
    `SELECT * FROM improvement_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC, id DESC LIMIT ?`,
    params,
  );
  return rows.map((row) => ({ id: row.id, candidateId: row.candidate_id, kind: row.kind, detail: parseJson(row.detail, {}), at: row.at }));
}
