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

/**
 * Record a decision made at a live routing seam, settled with its outcome when
 * the seam already knows it. Advisory: a ledger failure is swallowed and
 * answers null, so writing down why work ran where it did never stops the work
 * itself. Seams that route real work (research fragments, the cheap lane, the
 * feed shortlist) call this, so production rows say which resource ran each unit.
 */
export async function recordRoutedWork(input: Parameters<typeof recordDecision>[0] & {
  outcome?: string | null;
  validationResult?: string | null;
}): Promise<string | null> {
  try {
    const { outcome, validationResult, ...decision } = input;
    const recorded = await recordDecision(decision);
    if (outcome) {
      await settleDecision({ projectId: input.projectId, id: recorded.id, outcome, validationResult: validationResult ?? null });
    }
    return recorded.id;
  } catch {
    return null;
  }
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

/** The provider answered again: its cooldown ends now. The last failure stays on the row as history. */
export async function clearProviderCooldown(provider: string, model: string): Promise<void> {
  await getDb().run(
    'UPDATE provider_capacity SET cooldown_until = NULL, updated_at = ? WHERE provider = ? AND model = ? AND cooldown_until IS NOT NULL',
    [nowIso(), provider, model],
  );
}

/** Whether a provider/model is cooling down at `now`. A provider Brain has no row for is not. */
export async function isCoolingDown(provider: string, model: string, now: Date = new Date()): Promise<boolean> {
  const c = await getProviderCapacity(provider, model);
  return !!c?.cooldownUntil && Date.parse(c.cooldownUntil) > now.getTime();
}

/* ------------------------------------------------------------------------- */
/* Research fragments: the resource is whoever claims the unit                */
/* ------------------------------------------------------------------------- */

/**
 * A research fragment is not routed when it is created. It is a work item in
 * the ordinary queue, and the resource that runs it is the worker that wins the
 * claim: the free research lane (§85) for much of production, a Claude worker
 * for the rest. A ledger row written at creation can only say what the
 * classifier would choose; it cannot say what ran. So the claim — the one
 * statement that decides who runs the unit — writes the decision, and every
 * claim attempt is settled with what happened, which is what the measured
 * per-resource success and error rates below are read from.
 *
 * Before this, every fragment was written STRONG at creation and the free lane
 * wrote nothing, so the ledger named Claude for work the free lane did.
 */
export const CLAIM_ROUTED_WORK_KIND = 'RESEARCH_FRAGMENT';

/** The `created_by_id` the free research lane writes on its own worker rows (`ensureFreeWorkers`). */
export const FREE_LANE_WORKER_CREATOR = 'free research lane (§85)';

/** Outcomes a claim attempt is settled with. Only these count as a measured attempt. */
export const CLAIM_OUTCOMES = { SUCCEEDED: 'SUCCEEDED', FAILED: 'FAILED' } as const;

/** The ledger's handle for one fragment: the same at creation and at every claim. */
export function fragmentWorkRef(orchestrationId: string, fragmentKey: string): string {
  return `${orchestrationId}:${fragmentKey}`;
}

/** Which resource a worker is. The free lane's own rows are CHEAP; every other worker is a Claude session. */
export async function resourceOfWorker(workerId: string): Promise<RoutingResource> {
  const row = await getDb().get<{ created_by_type: string; created_by_id: string }>(
    'SELECT created_by_type, created_by_id FROM workers WHERE id = ?', [workerId]);
  return row && row.created_by_type === 'SYSTEM' && row.created_by_id === FREE_LANE_WORKER_CREATOR ? 'CHEAP' : 'STRONG';
}

export interface MeasuredRecord { attempts: number; successes: number; consecutiveFailures: number }

/**
 * One resource's measured record for one kind of work in one project, read from
 * the settled ledger rows (newest first, bounded). Nothing is assumed: a
 * resource with no settled row has zero attempts.
 */
export async function measuredRecord(
  projectId: string, workKind: string, resource: RoutingResource, limit = 200,
): Promise<MeasuredRecord> {
  const rows = await getDb().all<{ outcome: string | null }>(
    `SELECT outcome FROM work_routing_decisions
      WHERE project_id = ? AND work_kind = ? AND resource = ? AND settled_at IS NOT NULL
      ORDER BY settled_at DESC, id LIMIT ?`,
    [projectId, workKind, resource, Math.min(1000, Math.max(1, limit))]);
  let attempts = 0;
  let successes = 0;
  let consecutiveFailures = 0;
  let streakOpen = true;
  for (const r of rows) {
    if (r.outcome !== CLAIM_OUTCOMES.SUCCEEDED && r.outcome !== CLAIM_OUTCOMES.FAILED) continue;
    attempts += 1;
    if (r.outcome === CLAIM_OUTCOMES.SUCCEEDED) { successes += 1; streakOpen = false; }
    else if (streakOpen) consecutiveFailures += 1;
  }
  return { attempts, successes, consecutiveFailures };
}

/** A measured record as a ledger reason. Unmeasured says so; it is never written as a rate. */
export function describeRecord(m: MeasuredRecord): string {
  if (m.attempts === 0) return 'UNMEASURED';
  return `MEASURED_RELIABILITY:${(m.successes / m.attempts).toFixed(2)} SAMPLE:${m.attempts} CONSECUTIVE_FAILURES:${m.consecutiveFailures}`;
}

interface ClaimItem { id: string; project_id: string; work_type: string; orchestration_id: string | null; fragment_id: string | null }

async function workRefFor(item: ClaimItem): Promise<string> {
  if (item.orchestration_id && item.fragment_id) {
    const f = await getDb().get<{ fragment_key: string }>(
      'SELECT fragment_key FROM research_fragments WHERE id = ?', [item.fragment_id]);
    if (f) return fragmentWorkRef(item.orchestration_id, f.fragment_key);
  }
  return `work_item:${item.id}`;
}

function isClaimed(d: RoutingDecision): boolean {
  return d.reasons.some((r) => r.startsWith('CLAIMED_BY:'));
}

/**
 * Record which resource a claimed research fragment runs on, at the claim.
 *
 * The open row for the fragment (the one written at creation, or one a released
 * or lapsed claim left open) is rewritten to the claimant — one unit, one row,
 * so a report counts it once and on the resource that actually holds it. When
 * the previous attempt was settled (it failed and the queue offered it again), a
 * new row is written for the new attempt, naming the resource it moved from.
 * The reasons and alternatives carry each resource's measured record.
 *
 * Advisory: answers null on any error, so recording never blocks a claim.
 */
export async function recordClaimRouting(item: ClaimItem, workerId: string): Promise<string | null> {
  if (item.work_type !== CLAIM_ROUTED_WORK_KIND) return null;
  try {
    const db = getDb();
    const ref = await workRefFor(item);
    const resource = await resourceOfWorker(workerId);
    const other: RoutingResource = resource === 'CHEAP' ? 'STRONG' : 'CHEAP';
    const mine = await measuredRecord(item.project_id, CLAIM_ROUTED_WORK_KIND, resource);
    const theirs = await measuredRecord(item.project_id, CLAIM_ROUTED_WORK_KIND, other);
    const reasons = [
      `CLAIMED_BY:${resource === 'CHEAP' ? 'FREE_LANE' : 'STRONG_WORKER'}`,
      `WORKER:${workerId}`,
      `WORK_ITEM:${item.id}`,
      describeRecord(mine),
    ];
    const alternatives = [
      `${other}: ${describeRecord(theirs)}`,
      'CODE: no algorithm or ACTIVE detector answers an open research question',
    ];

    const rows = await db.all<DecisionRow>(
      `SELECT * FROM work_routing_decisions
        WHERE project_id = ? AND work_kind = ? AND work_ref = ?
        ORDER BY created_at DESC, id LIMIT 1`,
      [item.project_id, CLAIM_ROUTED_WORK_KIND, ref]);
    const latest = rows[0] ? mapDecision(rows[0]) : null;

    if (latest && latest.settledAt === null) {
      const reclaimed = isClaimed(latest);
      if (reclaimed) reasons.push(`RECLAIMED_FROM:${latest.resource}`);
      const escalatedFrom = reclaimed && latest.resource !== resource ? latest.resource : latest.escalatedFrom;
      const r = await db.run(
        `UPDATE work_routing_decisions
            SET resource = ?, reasons = ?, alternatives = ?, escalated_from = ?
          WHERE id = ? AND project_id = ? AND settled_at IS NULL`,
        [resource, toJson(reasons), toJson(alternatives), escalatedFrom, latest.id, item.project_id]);
      if (r.changes === 1) return latest.id;
    }
    const escalatedFrom = latest && latest.resource !== resource && isClaimed(latest) ? latest.resource : null;
    if (latest && isClaimed(latest)) reasons.push(`RETRY_AFTER:${latest.outcome ?? 'UNSETTLED'}`);
    const recorded = await recordDecision({
      projectId: item.project_id, workKind: CLAIM_ROUTED_WORK_KIND, workRef: ref,
      resource, reasons, alternatives, escalatedFrom,
    });
    return recorded.id;
  } catch {
    return null;
  }
}

/**
 * Settle the claim attempt a research fragment's lease just ended with. Only a
 * row a claim wrote is settled — a creation row nobody claimed is never marked
 * as an outcome. Advisory: never throws.
 */
export async function settleClaimRouting(
  item: ClaimItem, outcome: (typeof CLAIM_OUTCOMES)[keyof typeof CLAIM_OUTCOMES], validationResult: string | null,
): Promise<boolean> {
  if (item.work_type !== CLAIM_ROUTED_WORK_KIND) return false;
  try {
    const ref = await workRefFor(item);
    const rows = await getDb().all<DecisionRow>(
      `SELECT * FROM work_routing_decisions
        WHERE project_id = ? AND work_kind = ? AND work_ref = ? AND settled_at IS NULL
        ORDER BY created_at DESC, id LIMIT 1`,
      [item.project_id, CLAIM_ROUTED_WORK_KIND, ref]);
    const open = rows[0] ? mapDecision(rows[0]) : null;
    if (!open || !open.reasons.includes(`WORK_ITEM:${item.id}`) || !isClaimed(open)) return false;
    return await settleDecision({ projectId: item.project_id, id: open.id, outcome, validationResult });
  } catch {
    return false;
  }
}
