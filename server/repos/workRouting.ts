/**
 * The routing-decision ledger, routing baselines and free-provider capacity.
 * Every ledger and baseline read is scoped to one project.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';

export const ROUTING_RESOURCES = ['CODE', 'CHEAP', 'STRONG'] as const;
export type RoutingResource = (typeof ROUTING_RESOURCES)[number];
export const ROUTING_FAILURE_CLASSES = [
  'TRANSIENT_PROVIDER', 'RATE_LIMITED', 'PROVIDER_DOWN', 'SOURCE_UNAVAILABLE',
  'MALFORMED_OUTPUT', 'MISSING_INPUT', 'CAPABILITY_GAP', 'UNSOLVABLE',
] as const;
export type RoutingFailureClass = (typeof ROUTING_FAILURE_CLASSES)[number];
export type RoutingOutcome = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'REUSED' | 'PREVENTED';
export type RoutingValidation = 'PASSED' | 'FAILED' | 'NOT_RUN';

export interface RoutingDecision {
  id: string;
  projectId: string;
  workKind: string;
  workRef: string;
  resource: RoutingResource;
  reasons: string[];
  alternatives: Array<{ resource: RoutingResource; why: string }>;
  reusedResultId: string | null;
  failureClass: RoutingFailureClass | null;
  escalatedFrom: RoutingResource | null;
  outcome: RoutingOutcome;
  validationResult: RoutingValidation | null;
  decidedAt: string;
  settledAt: string | null;
}

interface DecisionRow {
  id: string; project_id: string; work_kind: string; work_ref: string; resource: RoutingResource;
  reasons: string; alternatives: string; reused_result_id: string | null;
  failure_class: RoutingFailureClass | null; escalated_from: RoutingResource | null;
  outcome: RoutingOutcome; validation_result: RoutingValidation | null; decided_at: string; settled_at: string | null;
}
const toDecision = (r: DecisionRow): RoutingDecision => ({
  id: r.id, projectId: r.project_id, workKind: r.work_kind, workRef: r.work_ref, resource: r.resource,
  reasons: parseJson<string[]>(r.reasons, []),
  alternatives: parseJson<Array<{ resource: RoutingResource; why: string }>>(r.alternatives, []),
  reusedResultId: r.reused_result_id, failureClass: r.failure_class, escalatedFrom: r.escalated_from,
  outcome: r.outcome, validationResult: r.validation_result, decidedAt: r.decided_at, settledAt: r.settled_at,
});

export async function recordRoutingDecision(input: {
  projectId: string;
  workKind: string;
  workRef: string;
  resource: RoutingResource;
  reasons: string[];
  alternatives?: Array<{ resource: RoutingResource; why: string }>;
  reusedResultId?: string | null;
  escalatedFrom?: RoutingResource | null;
  /** REUSED and PREVENTED are decided at the moment of routing; the rest start PENDING. */
  outcome?: 'PENDING' | 'REUSED' | 'PREVENTED';
  decidedAt?: string;
}): Promise<RoutingDecision> {
  const id = newId('wrd');
  const at = input.decidedAt ?? nowIso();
  const outcome = input.outcome ?? 'PENDING';
  await getDb().run(
    `INSERT INTO work_routing_decisions
       (id, project_id, work_kind, work_ref, resource, reasons, alternatives, reused_result_id,
        escalated_from, outcome, decided_at, settled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.projectId, input.workKind, input.workRef, input.resource, toJson(input.reasons),
      toJson(input.alternatives ?? []), input.reusedResultId ?? null, input.escalatedFrom ?? null,
      outcome, at, outcome === 'PENDING' ? null : at],
  );
  return toDecision((await getDb().get<DecisionRow>('SELECT * FROM work_routing_decisions WHERE id = ?', [id]))!);
}

/** Record how a decision ended. Settles once; a second call matches nothing. */
export async function settleRoutingDecision(
  id: string,
  result: { outcome: 'SUCCEEDED' | 'FAILED'; failureClass?: RoutingFailureClass | null; validation?: RoutingValidation },
): Promise<boolean> {
  const r = await getDb().run(
    `UPDATE work_routing_decisions SET outcome = ?, failure_class = ?, validation_result = ?, settled_at = ?
      WHERE id = ? AND outcome = 'PENDING'`,
    [result.outcome, result.failureClass ?? null, result.validation ?? 'NOT_RUN', nowIso(), id],
  );
  return (r.changes ?? 0) > 0;
}

export async function listRoutingDecisions(
  projectId: string,
  opts: { since?: string; resource?: RoutingResource; limit?: number } = {},
): Promise<RoutingDecision[]> {
  const params: Array<string | number> = [projectId];
  let where = 'project_id = ?';
  if (opts.since) { where += ' AND decided_at >= ?'; params.push(opts.since); }
  if (opts.resource) { where += ' AND resource = ?'; params.push(opts.resource); }
  params.push(opts.limit ?? 500);
  const rows = await getDb().all<DecisionRow>(
    `SELECT * FROM work_routing_decisions WHERE ${where} ORDER BY decided_at DESC, id DESC LIMIT ?`,
    params,
  );
  return rows.map(toDecision);
}

/** Counts by resource and outcome; a figure that cannot be counted is not invented. */
export async function routingCounts(
  projectId: string,
  since?: string,
): Promise<Array<{ resource: RoutingResource; outcome: RoutingOutcome; count: number }>> {
  const rows = await getDb().all<{ resource: RoutingResource; outcome: RoutingOutcome; n: number | string }>(
    `SELECT resource, outcome, COUNT(*) AS n FROM work_routing_decisions
      WHERE project_id = ?${since ? ' AND decided_at >= ?' : ''} GROUP BY resource, outcome ORDER BY resource, outcome`,
    since ? [projectId, since] : [projectId],
  );
  return rows.map((r) => ({ resource: r.resource, outcome: r.outcome, count: Number(r.n) }));
}

// -------------------------------------------------------------- baselines

export interface RoutingBaseline {
  id: string; projectId: string; label: string; windowFrom: string; windowTo: string;
  measurements: Record<string, unknown>; recordedAt: string;
}
interface BaselineRow {
  id: string; project_id: string; label: string; window_from: string; window_to: string; measurements: string; recorded_at: string;
}

export async function recordRoutingBaseline(input: {
  projectId: string; label: string; windowFrom: string; windowTo: string; measurements: Record<string, unknown>;
}): Promise<RoutingBaseline> {
  const id = newId('rbl');
  await getDb().run(
    `INSERT INTO routing_baselines (id, project_id, label, window_from, window_to, measurements, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, input.projectId, input.label, input.windowFrom, input.windowTo, toJson(input.measurements), nowIso()],
  );
  return (await listRoutingBaselines(input.projectId)).find((b) => b.id === id)!;
}

export async function listRoutingBaselines(projectId: string): Promise<RoutingBaseline[]> {
  const rows = await getDb().all<BaselineRow>(
    'SELECT * FROM routing_baselines WHERE project_id = ? ORDER BY recorded_at DESC, id DESC',
    [projectId],
  );
  return rows.map((r) => ({
    id: r.id, projectId: r.project_id, label: r.label, windowFrom: r.window_from, windowTo: r.window_to,
    measurements: parseJson<Record<string, unknown>>(r.measurements, {}), recordedAt: r.recorded_at,
  }));
}

// ------------------------------------------------------ provider capacity

export interface ProviderCapacity {
  provider: string; model: string; limitValue: number | null; limitUnit: string | null;
  windowSeconds: number | null; cooldownUntil: string | null; lastFailureAt: string | null;
  lastFailureNote: string | null; updatedAt: string;
}
interface CapacityRow {
  provider: string; model: string; limit_value: number | string | null; limit_unit: string | null;
  window_seconds: number | string | null; cooldown_until: string | null; last_failure_at: string | null;
  last_failure_note: string | null; updated_at: string;
}
const toCapacity = (r: CapacityRow): ProviderCapacity => ({
  provider: r.provider, model: r.model,
  limitValue: r.limit_value === null ? null : Number(r.limit_value), limitUnit: r.limit_unit,
  windowSeconds: r.window_seconds === null ? null : Number(r.window_seconds),
  cooldownUntil: r.cooldown_until, lastFailureAt: r.last_failure_at, lastFailureNote: r.last_failure_note,
  updatedAt: r.updated_at,
});

/** Record a refusal or outage and when to try again. Nothing here is inferred. */
export async function recordProviderFailure(input: {
  provider: string; model: string; note: string; cooldownUntil: string | null;
  limitValue?: number | null; limitUnit?: string | null; windowSeconds?: number | null;
}): Promise<void> {
  const at = nowIso();
  await getDb().run(
    `INSERT INTO provider_capacity
       (id, provider, model, limit_value, limit_unit, window_seconds, cooldown_until, last_failure_at, last_failure_note, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (provider, model) DO UPDATE SET
       cooldown_until = excluded.cooldown_until, last_failure_at = excluded.last_failure_at,
       last_failure_note = excluded.last_failure_note, updated_at = excluded.updated_at,
       limit_value = COALESCE(excluded.limit_value, provider_capacity.limit_value),
       limit_unit = COALESCE(excluded.limit_unit, provider_capacity.limit_unit),
       window_seconds = COALESCE(excluded.window_seconds, provider_capacity.window_seconds)`,
    [newId('pcp'), input.provider, input.model, input.limitValue ?? null, input.limitUnit ?? null,
      input.windowSeconds ?? null, input.cooldownUntil, at, input.note.slice(0, 500), at],
  );
}

export async function getProviderCapacity(provider: string, model: string): Promise<ProviderCapacity | null> {
  const row = await getDb().get<CapacityRow>('SELECT * FROM provider_capacity WHERE provider = ? AND model = ?', [provider, model]);
  return row ? toCapacity(row) : null;
}

export async function listProviderCapacity(): Promise<ProviderCapacity[]> {
  return (await getDb().all<CapacityRow>('SELECT * FROM provider_capacity ORDER BY provider, model')).map(toCapacity);
}

/** True while a recorded cooldown is still ahead of `now`. Unknown is not down. */
export async function providerCoolingDown(provider: string, model: string, now: string = nowIso()): Promise<boolean> {
  const c = await getProviderCapacity(provider, model);
  return c?.cooldownUntil != null && c.cooldownUntil > now;
}
