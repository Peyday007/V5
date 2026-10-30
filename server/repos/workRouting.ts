/**
 * The routing-decision ledger, the baseline taken before routing changed, and
 * per-provider capacity. Every read is project-scoped: a project's rows are
 * never returned for another's, except decisions explicitly marked `general`
 * (a method, not a private fact), which `listGeneralDecisions` reads and
 * nothing else does.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';

export const ROUTING_RESOURCES = ['CODE', 'CHEAP', 'STRONG'] as const;
export type RoutingResource = (typeof ROUTING_RESOURCES)[number];

export interface RoutingDecision {
  id: string;
  projectId: string;
  workKind: string;
  workRef: string | null;
  resource: RoutingResource;
  reasons: string[];
  alternatives: string[];
  reusedResultId: string | null;
  failureClass: string | null;
  escalatedFrom: RoutingResource | null;
  outcome: string | null;
  validationResult: string | null;
  general: boolean;
  createdAt: string;
  settledAt: string | null;
}

interface DecisionRow {
  id: string; project_id: string; work_kind: string; work_ref: string | null; resource: string;
  reasons: string; alternatives: string; reused_result_id: string | null; failure_class: string | null;
  escalated_from: string | null; outcome: string | null; validation_result: string | null;
  general: number; created_at: string; settled_at: string | null;
}

function mapDecision(r: DecisionRow): RoutingDecision {
  return {
    id: r.id, projectId: r.project_id, workKind: r.work_kind, workRef: r.work_ref,
    resource: r.resource as RoutingResource,
    reasons: parseJson<string[]>(r.reasons, []), alternatives: parseJson<string[]>(r.alternatives, []),
    reusedResultId: r.reused_result_id, failureClass: r.failure_class,
    escalatedFrom: (r.escalated_from as RoutingResource | null) ?? null,
    outcome: r.outcome, validationResult: r.validation_result, general: r.general === 1,
    createdAt: r.created_at, settledAt: r.settled_at,
  };
}

export async function recordDecision(input: {
  projectId: string;
  workKind: string;
  workRef?: string | null;
  resource: RoutingResource;
  reasons: string[];
  alternatives?: string[];
  reusedResultId?: string | null;
  failureClass?: string | null;
  escalatedFrom?: RoutingResource | null;
  general?: boolean;
}): Promise<RoutingDecision> {
  const id = newId('wrd');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO work_routing_decisions
       (id, project_id, work_kind, work_ref, resource, reasons, alternatives, reused_result_id,
        failure_class, escalated_from, general, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.projectId, input.workKind, input.workRef ?? null, input.resource, toJson(input.reasons),
     toJson(input.alternatives ?? []), input.reusedResultId ?? null, input.failureClass ?? null,
     input.escalatedFrom ?? null, input.general ? 1 : 0, at],
  );
  return (await getDecision(input.projectId, id))!;
}

export async function getDecision(projectId: string, id: string): Promise<RoutingDecision | null> {
  const row = await getDb().get<DecisionRow>(
    'SELECT * FROM work_routing_decisions WHERE id = ? AND project_id = ?', [id, projectId]);
  return row ? mapDecision(row) : null;
}

/** Settle a decision once: the first outcome stands. Returns whether this call settled it. */
export async function settleDecision(input: {
  projectId: string; id: string; outcome: string; validationResult?: string | null; failureClass?: string | null;
}): Promise<boolean> {
  const r = await getDb().run(
    `UPDATE work_routing_decisions
        SET outcome = ?, validation_result = ?, failure_class = COALESCE(?, failure_class), settled_at = ?
      WHERE id = ? AND project_id = ? AND settled_at IS NULL`,
    [input.outcome, input.validationResult ?? null, input.failureClass ?? null, nowIso(), input.id, input.projectId],
  );
  return r.changes === 1;
}

export async function listDecisions(projectId: string, opts: { workKind?: string; limit?: number } = {}): Promise<RoutingDecision[]> {
  const limit = Math.min(1000, Math.max(1, opts.limit ?? 200));
  const rows = opts.workKind
    ? await getDb().all<DecisionRow>(
        'SELECT * FROM work_routing_decisions WHERE project_id = ? AND work_kind = ? ORDER BY created_at DESC, id LIMIT ?',
        [projectId, opts.workKind, limit])
    : await getDb().all<DecisionRow>(
        'SELECT * FROM work_routing_decisions WHERE project_id = ? ORDER BY created_at DESC, id LIMIT ?',
        [projectId, limit]);
  return rows.map(mapDecision);
}

/** Decisions marked as general methods, readable across projects. Nothing else is. */
export async function listGeneralDecisions(limit = 200): Promise<RoutingDecision[]> {
  const rows = await getDb().all<DecisionRow>(
    'SELECT * FROM work_routing_decisions WHERE general = 1 ORDER BY created_at DESC, id LIMIT ?',
    [Math.min(1000, Math.max(1, limit))]);
  return rows.map(mapDecision);
}

export async function recordBaseline(input: { projectId: string; label: string; readings: Record<string, unknown> }): Promise<string> {
  const id = newId('rbl');
  await getDb().run(
    'INSERT INTO routing_baselines (id, project_id, label, readings, taken_at) VALUES (?, ?, ?, ?, ?)',
    [id, input.projectId, input.label, toJson(input.readings), nowIso()]);
  return id;
}

export async function listBaselines(projectId: string): Promise<{ id: string; label: string; readings: Record<string, unknown>; takenAt: string }[]> {
  const rows = await getDb().all<{ id: string; label: string; readings: string; taken_at: string }>(
    'SELECT * FROM routing_baselines WHERE project_id = ? ORDER BY taken_at DESC, id', [projectId]);
  return rows.map((r) => ({ id: r.id, label: r.label, readings: parseJson<Record<string, unknown>>(r.readings, {}), takenAt: r.taken_at }));
}

export interface ProviderCapacity {
  provider: string; model: string; limitValue: number | null; windowSeconds: number | null;
  cooldownUntil: string | null; lastFailure: string | null; lastFailureAt: string | null; updatedAt: string;
}

/** Record a failure and an optional cooldown. Never writes a limit the provider did not state. */
export async function recordProviderFailure(input: {
  provider: string; model: string; failure: string; cooldownUntil?: string | null;
  limitValue?: number | null; windowSeconds?: number | null;
}): Promise<void> {
  const at = nowIso();
  await getDb().run(
    `INSERT INTO provider_capacity (provider, model, limit_value, window_seconds, cooldown_until, last_failure, last_failure_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (provider, model) DO UPDATE SET
       limit_value = COALESCE(excluded.limit_value, provider_capacity.limit_value),
       window_seconds = COALESCE(excluded.window_seconds, provider_capacity.window_seconds),
       cooldown_until = excluded.cooldown_until,
       last_failure = excluded.last_failure, last_failure_at = excluded.last_failure_at, updated_at = excluded.updated_at`,
    [input.provider, input.model, input.limitValue ?? null, input.windowSeconds ?? null,
     input.cooldownUntil ?? null, input.failure.slice(0, 500), at, at]);
}

export async function getProviderCapacity(provider: string, model: string): Promise<ProviderCapacity | null> {
  const r = await getDb().get<{ provider: string; model: string; limit_value: number | null; window_seconds: number | null; cooldown_until: string | null; last_failure: string | null; last_failure_at: string | null; updated_at: string }>(
    'SELECT * FROM provider_capacity WHERE provider = ? AND model = ?', [provider, model]);
  return r ? { provider: r.provider, model: r.model, limitValue: r.limit_value, windowSeconds: r.window_seconds, cooldownUntil: r.cooldown_until, lastFailure: r.last_failure, lastFailureAt: r.last_failure_at, updatedAt: r.updated_at } : null;
}

/** Whether a provider/model is cooling down at `now`. A provider Brain has no row for is not. */
export async function isCoolingDown(provider: string, model: string, now: Date = new Date()): Promise<boolean> {
  const c = await getProviderCapacity(provider, model);
  return !!c?.cooldownUntil && Date.parse(c.cooldownUntil) > now.getTime();
}
