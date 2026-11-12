/**
 * The goal reading an operator run works from, built once per run (§106).
 *
 * Production, 2026-11-12, in order:
 *   - opr_5334b9d8 (37 refused calls): deriving every goal from the register is
 *     heavy — `assembleGoals` reads every linked mission, candidate, campaign
 *     and bin — and asking it inside an MCP call ran past the 180 s limit.
 *   - 12:02: the run and its read tools keyed the cache differently, so a tool
 *     rebuilt the whole reading inside its call.
 *   - opr_8f2520b2: the build itself could not check out a connection (8/8 in
 *     use, 3 waiting) and the run ended before the agent started.
 *
 * So a run always gets a *light* reading first — the goal register and each
 * goal project's open requests with their moot reading, a handful of indexed
 * reads — retried while the pool is saturated. The full derivation (state,
 * blockers, next action) is then attempted once within a bound and, when it
 * finishes, replaces the light one. Either way the brief names every goal id
 * and every moot request id, which is what the action tools need. One reading
 * is shared by the run and its read tools and narrowed to what a caller may see.
 */
import type { GoalView } from '../goals/model.ts';
import { operatorGoals, readRequests, summarizeGoal, type GoalSummary, type RequestReading } from './actions.ts';

export interface OperatorSnapshot {
  takenAt: string;
  /** FULL when every goal was derived; LIGHT when only the register and the requests were read. */
  depth: 'FULL' | 'LIGHT';
  /** Derived views, present only at FULL depth. */
  goals: GoalView[];
  summaries: GoalSummary[];
  /** Open requests by project id, each with its moot reading. */
  requests: Map<string, RequestReading[]>;
}

/** How long one reading serves the read tools: a run's budget plus its slack. */
export const SNAPSHOT_TTL_MS = 25 * 60_000;
/** The full derivation's bound; past it the light reading stands. */
export const FULL_DERIVATION_BOUND_MS = 150_000;

let cached: { at: number; snapshot: OperatorSnapshot } | null = null;
let building: Promise<OperatorSnapshot> | null = null;

export async function operatorSnapshot(projectIds: string[], options: { fresh?: boolean; nowMs?: number } = {}): Promise<OperatorSnapshot> {
  const nowMs = options.nowMs ?? Date.now();
  const whole = !options.fresh && cached && nowMs - cached.at < SNAPSHOT_TTL_MS ? cached.snapshot : await build(nowMs);
  return narrow(whole, projectIds);
}

async function build(nowMs: number): Promise<OperatorSnapshot> {
  if (building) return building;
  building = (async () => {
    const light = await withPoolRetry(() => lightSnapshot(nowMs));
    cached = { at: nowMs, snapshot: light };
    const full = await bounded(fullSnapshot(nowMs, light.requests), FULL_DERIVATION_BOUND_MS).catch(() => null);
    if (full) cached = { at: nowMs, snapshot: full };
    return cached.snapshot;
  })().finally(() => {
    building = null;
  });
  return building;
}

/** The register and the requests: what the brief needs, in a handful of indexed reads. */
async function lightSnapshot(nowMs: number): Promise<OperatorSnapshot> {
  const { listWorkstreams } = await import('../../repos/register.ts');
  const live = (await listWorkstreams({ projectIds: null })).filter((w) => !w.cancelledAt && w.projectId);
  const requests = new Map<string, RequestReading[]>();
  for (const projectId of new Set(live.map((w) => w.projectId!))) requests.set(projectId, await readRequests(projectId));
  const summaries: GoalSummary[] = live.map((w) => {
    const target = w.target as { amountCents?: number; currency?: string; metric?: string } | null;
    return {
      id: w.id,
      title: w.title.slice(0, 200),
      projectId: w.projectId,
      state: 'NOT_DERIVED',
      stateEvidence: 'read from the register only; Brain was too busy to derive the goal this run',
      lifecycle: w.pausedAt ? 'PAUSED' : 'ACTIVE',
      target: target?.amountCents ? `${target.metric ?? 'target'} ${(target.amountCents / 100).toFixed(0)} ${target.currency ?? ''}`.trim() : null,
      dueAt: w.dueAt,
      waiting: (requests.get(w.projectId!) ?? []).length ? `PERSON: ${(requests.get(w.projectId!) ?? []).length} open request(s) in its project` : 'not derived',
      next: 'not derived',
      openDecisions: (requests.get(w.projectId!) ?? []).length,
      blockers: 0,
      priority: null,
    };
  });
  return { takenAt: new Date(nowMs).toISOString(), depth: 'LIGHT', goals: [], summaries, requests };
}

async function fullSnapshot(nowMs: number, requests: Map<string, RequestReading[]>): Promise<OperatorSnapshot> {
  const { listProjects } = await import('../../repos/projects.ts');
  const goals = await operatorGoals((await listProjects()).map((p) => p.id));
  return { takenAt: new Date(nowMs).toISOString(), depth: 'FULL', goals, summaries: goals.map(summarizeGoal), requests };
}

/** Retry a read while the pool is saturated (§61, §63): three tries, twenty seconds apart. */
export async function withPoolRetry<T>(work: () => Promise<T>, attempts = 3, spacingMs = 20_000): Promise<T> {
  let last: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      last = error;
      const { classifyInfraFailure } = await import('../../db/infra.ts');
      if (!classifyInfraFailure(error) || attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, spacingMs));
    }
  }
  throw last;
}

function bounded<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function narrow(snapshot: OperatorSnapshot, projectIds: string[]): OperatorSnapshot {
  const allowed = new Set(projectIds);
  const goals = snapshot.goals.filter((g) => g.projectId !== null && allowed.has(g.projectId));
  return {
    takenAt: snapshot.takenAt,
    depth: snapshot.depth,
    goals,
    summaries: snapshot.summaries.filter((s) => s.projectId !== null && allowed.has(s.projectId)),
    requests: new Map([...snapshot.requests].filter(([projectId]) => allowed.has(projectId))),
  };
}

/** The snapshot's goals in the order the operator should take them: blocked and active first, then by rank. */
export function urgencyOrder(summaries: GoalSummary[]): GoalSummary[] {
  const weight = (g: GoalSummary) => (g.lifecycle === 'ACTIVE' ? 0 : 1) * 10 + (g.state === 'BLOCKED' ? 0 : 1);
  return [...summaries].sort((a, b) => weight(a) - weight(b) || (a.priority ?? 99) - (b.priority ?? 99));
}

/** The goals as the brief states them: ids the agent can use, and what each is held on. */
export function snapshotForBrief(snapshot: OperatorSnapshot): string {
  const lines: string[] = [`Brain's goals as read at ${snapshot.takenAt} (${snapshot.depth === 'FULL' ? 'fully derived' : 'register and requests only — Brain is busy'}):`];
  for (const goal of urgencyOrder(snapshot.summaries)) {
    lines.push(`- ${goal.id} [${goal.lifecycle}/${goal.state}] ${goal.title}`);
    if (goal.target) lines.push(`    target: ${goal.target}`);
    lines.push(`    waiting: ${goal.waiting}`);
    lines.push(`    next: ${goal.next}`);
    const requests = goal.projectId ? snapshot.requests.get(goal.projectId) ?? [] : [];
    const moot = requests.filter((r) => r.moot);
    if (moot.length) lines.push(`    moot requests (no answer can apply; withdraw them): ${moot.map((r) => r.requestId).join(', ')}`);
    const live = requests.length - moot.length;
    if (live) lines.push(`    other open requests: ${live}`);
    lines.push(`    blockers: ${goal.blockers}, open decisions: ${goal.openDecisions}`);
  }
  if (snapshot.summaries.length === 0) lines.push('- (no live goals in the projects you direct)');
  return lines.join('\n');
}
