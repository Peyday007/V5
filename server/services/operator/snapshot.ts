/**
 * The goal reading an operator run works from, built once per run (§106).
 *
 * Production, 2026-11-12 (run opr_5334b9d8, 37 refused calls): deriving every
 * goal from the register is heavy — `assembleGoals` reads every linked mission,
 * candidate, campaign and bin — and asking it through an MCP call ran into the
 * 180 s call limit (`TIMEOUT_OUTCOME_UNKNOWN`) and, under load, a pool that
 * could not check out a connection (`POOL_CHECKOUT_TIMEOUT`). The one call that
 * finished did so after the agent had already given up, and a model without the
 * goal list then guessed goal ids for the rest of the run.
 *
 * So Brain reads the goals once, in its own process and outside the call limit,
 * when it starts the run: the reading goes into the brief (with every goal's id
 * and every open request's id and moot reading), and the read tools answer from
 * the same reading for as long as the run lasts. A run that wants fresher state
 * calls the action tools, each of which re-reads its own rows.
 */
import type { GoalView } from '../goals/model.ts';
import { operatorGoals, readRequests, summarizeGoal, type GoalSummary, type RequestReading } from './actions.ts';

export interface OperatorSnapshot {
  takenAt: string;
  goals: GoalView[];
  summaries: GoalSummary[];
  /** Open requests by project id, each with its moot reading. */
  requests: Map<string, RequestReading[]>;
}

/** How long one reading serves the read tools: a run's budget plus its slack. */
export const SNAPSHOT_TTL_MS = 25 * 60_000;

let cached: { projectKey: string; at: number; snapshot: OperatorSnapshot } | null = null;
let building: Promise<OperatorSnapshot> | null = null;

export async function operatorSnapshot(projectIds: string[], options: { fresh?: boolean; nowMs?: number } = {}): Promise<OperatorSnapshot> {
  const nowMs = options.nowMs ?? Date.now();
  const projectKey = [...projectIds].sort().join(',');
  if (!options.fresh && cached && cached.projectKey === projectKey && nowMs - cached.at < SNAPSHOT_TTL_MS) {
    return cached.snapshot;
  }
  if (building) return building;
  building = (async () => {
    const goals = await operatorGoals(projectIds);
    const requests = new Map<string, RequestReading[]>();
    for (const projectId of new Set(goals.map((g) => g.projectId).filter((id): id is string => Boolean(id)))) {
      requests.set(projectId, await readRequests(projectId));
    }
    const snapshot: OperatorSnapshot = {
      takenAt: new Date(nowMs).toISOString(),
      goals,
      summaries: goals.map(summarizeGoal),
      requests,
    };
    cached = { projectKey, at: nowMs, snapshot };
    return snapshot;
  })().finally(() => {
    building = null;
  });
  return building;
}

/** The snapshot's goals in the order the operator should take them: blocked and active first, then by rank. */
export function urgencyOrder(summaries: GoalSummary[]): GoalSummary[] {
  const weight = (g: GoalSummary) => (g.lifecycle === 'ACTIVE' ? 0 : 1) * 10 + (g.state === 'BLOCKED' ? 0 : 1);
  return [...summaries].sort((a, b) => weight(a) - weight(b) || (a.priority ?? 99) - (b.priority ?? 99));
}

/** The goals as the brief states them: ids the agent can use, and what each is held on. */
export function snapshotForBrief(snapshot: OperatorSnapshot): string {
  const lines: string[] = [`Brain's goals as read at ${snapshot.takenAt}:`];
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
