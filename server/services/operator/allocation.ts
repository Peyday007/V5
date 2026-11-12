/**
 * The allocation reading the operator decides from (§108): every live goal as
 * an activity, read from its own rows — the plan reading, the research it
 * consumed and what that bought — and ranked by the marginal value of the next
 * unit of capacity (`domain/allocation.ts`). It reads; it moves nothing. The
 * operator moves capacity through Brain's own levers: pausing or resuming a
 * goal (`goals/decide.ts`), continuing idle pools (§98), and the research
 * goal rounds that follow the plan's next test.
 */
import { getDb } from '../../db/database.ts';
import { listWorkstreams } from '../../repos/register.ts';
import { allocate, type Activity, type Allocation } from '../../domain/allocation.ts';

const LADDER = ['A_THEORETICAL', 'B_EVIDENCED', 'C_MARKET_TEST_READY', 'D_BUYER_VALIDATED', 'E_COMMITTED', 'F_COLLECTED'];

interface Reading {
  forecast: Record<string, unknown> | null;
  createdAt: string;
}

async function readings(goalId: string, sinceIso: string): Promise<{ latest: Reading | null; before: Reading | null }> {
  const rows = await getDb().all<{ forecast: string | null; created_at: string }>(
    'SELECT forecast, created_at FROM goal_plan_readings WHERE workstream_id = ? ORDER BY created_at DESC LIMIT 40',
    [goalId],
  );
  const parse = (r: { forecast: string | null; created_at: string } | undefined): Reading | null => {
    if (!r) return null;
    try {
      return { forecast: r.forecast ? (JSON.parse(r.forecast) as Record<string, unknown>) : null, createdAt: r.created_at };
    } catch {
      return { forecast: null, createdAt: r.created_at };
    }
  };
  return { latest: parse(rows[0]), before: parse(rows.find((r) => r.created_at <= sinceIso)) };
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function activityFrom(input: {
  goal: { id: string; title: string; commitment: string; pausedAt: string | null; dueAt: string | null; target: unknown };
  latest: Reading | null;
  before: Reading | null;
  jobs: number;
  productive: number;
  executable: boolean;
  nowMs: number;
}): Activity {
  const f = input.latest?.forecast ?? {};
  const acceptance = (f['acceptance'] ?? {}) as Record<string, unknown>;
  const candidate = (acceptance['candidate'] ?? {}) as Record<string, unknown>;
  const ladder = (f['ladder'] ?? {}) as Record<string, number>;
  const level = LADDER.reduce((best, key, i) => ((ladder[key] ?? 0) > 0 ? i : best), 0);
  const target = input.goal.target as { amountCents?: number } | null;
  const remaining = num(f['remainingCents']) ?? (target?.amountCents ?? null);
  const reach = num(f['reach']) ?? num(candidate['reach']);
  const beforeReach = num(input.before?.forecast?.['reach']);
  const daysLeft = num(f['daysLeft']) ?? (input.goal.dueAt ? Math.max(0, Math.round((Date.parse(input.goal.dueAt) - input.nowMs) / 86_400_000)) : null);
  return {
    id: input.goal.id,
    title: input.goal.title,
    stakeUsd: remaining === null ? null : remaining / 100,
    reach,
    reachIsProbability: String(candidate['reachBasis'] ?? 'COVERAGE') !== 'COVERAGE',
    evidenceLevel: level,
    daysToCash: null,
    daysLeft,
    unitsUsed: input.jobs,
    unitsProductive: input.productive,
    reachDelta: reach !== null && beforeReach !== null ? reach - beforeReach : null,
    executable: input.executable,
    committed: input.goal.commitment !== 'NONE',
    paused: !!input.goal.pausedAt,
  };
}

export async function readAllocation(projectIds: string[], windowHours = 24, nowMs = Date.now()): Promise<{ readAt: string; windowHours: number; allocations: Allocation[]; activities: Activity[] }> {
  const { goalResearchProgress } = await import('../goals/researchYield.ts');
  const since = new Date(nowMs - windowHours * 3_600_000).toISOString();
  const goals = (await listWorkstreams({ projectIds })).filter((w) => !w.cancelledAt && w.projectId && !w.archivedAt);
  const activities: Activity[] = [];
  for (const goal of goals) {
    const { latest, before } = await readings(goal.id, since);
    let jobs = 0;
    let productive = 0;
    try {
      const progress = await goalResearchProgress(goal.projectId!, goal.id, since);
      jobs = Object.values(progress.jobs).reduce((s, j) => s + j.submitted, 0);
      productive = Object.values(progress.claims).reduce((s, c) => s + c.sourced, 0) + progress.openings.length * 5;
    } catch {
      /* a goal with no research rows is read as having consumed none */
    }
    // Executable: research ran on it in the window, or its plan's next test is Brain's own to run.
    const next = await getDb().get<{ next_test: string | null }>(
      'SELECT next_test FROM goal_plan_readings WHERE workstream_id = ? ORDER BY created_at DESC LIMIT 1',
      [goal.id],
    );
    const brainsMove = /"by"\s*:\s*"BRAIN"/.test(next?.next_test ?? '');
    activities.push(
      activityFrom({
        goal: { id: goal.id, title: goal.title, commitment: goal.commitment, pausedAt: goal.pausedAt ?? null, dueAt: goal.dueAt, target: goal.target },
        latest,
        before,
        jobs,
        productive,
        executable: !goal.pausedAt && (jobs > 0 || brainsMove),
        nowMs,
      }),
    );
  }
  return { readAt: new Date(nowMs).toISOString(), windowHours, allocations: allocate(activities), activities };
}
