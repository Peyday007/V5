/**
 * What the operator reads and what it may do (§106).
 *
 * Every function here is a thin view onto, or a bounded call into, a mechanism
 * Brain already owns: the goal model (`goals/model.ts`), the Russell request
 * records, the utilization watchdog (§98), Factory's submission and the
 * owner's standing improvement order (§87). Nothing here is a second planner,
 * queue or authority. The operator decides *which* of these to call and when;
 * each call re-checks its own rule, so a wrong decision is refused rather than
 * performed.
 */
import { assembleGoals, type GoalView } from '../goals/model.ts';
import { getHumanRequest, getMission, listOpenRequests, withdrawRequest } from '../../repos/russellMissions.ts';
import { getOrchestration } from '../../repos/research.ts';
import { recordEvent } from '../../repos/events.ts';
import { getDb } from '../../db/database.ts';
import { listOperatorLearnings, recentOperatorRuns, recordOperatorLearning } from '../../repos/operator.ts';
import { moot, type MootReading } from '../../domain/operator.ts';

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface GoalSummary {
  id: string;
  title: string;
  projectId: string | null;
  state: string;
  stateEvidence: string;
  lifecycle: string;
  target: string | null;
  dueAt: string | null;
  waiting: string;
  next: string;
  openDecisions: number;
  blockers: number;
  /** The goal's rank among its owner's goals (1 is first), or null when unranked. */
  priority: number | null;
}

function targetLine(goal: GoalView): string | null {
  const t = goal.target;
  if (!t) return null;
  const money = (cents: number) => `${(cents / 100).toFixed(0)} ${t.currency}`;
  return `${t.metricLabel}: ${money(t.achievedCents)} of ${money(t.targetCents)}, ${money(t.remainingCents)} to go` +
    (t.daysLeft === null ? '' : `, ${t.daysLeft} day(s) left`);
}

export function summarizeGoal(goal: GoalView): GoalSummary {
  return {
    id: goal.id,
    title: goal.title.slice(0, 200),
    projectId: goal.projectId,
    state: goal.state,
    stateEvidence: goal.stateEvidence.slice(0, 300),
    lifecycle: goal.lifecycle,
    target: targetLine(goal),
    dueAt: goal.dueAt,
    waiting: `${goal.waiting.kind}: ${goal.waiting.detail}`.slice(0, 300),
    next: `[${goal.next.by}] ${goal.next.action}`.slice(0, 300),
    openDecisions: goal.decisions.length,
    blockers: goal.blockers.length,
    priority: goal.priority?.rank ?? null,
  };
}

/** Every live goal in the projects the caller may read, most urgent first. */
export async function operatorGoals(projectIds: string[]): Promise<GoalView[]> {
  const snapshot = await assembleGoals({ projectIds });
  return snapshot.goals.filter((goal) => goal.lifecycle === 'ACTIVE' || goal.lifecycle === 'PAUSED');
}

export interface RequestReading extends MootReading {
  requestId: string;
  question: string;
  recommendation: string | null;
  since: string;
}

/** A goal's open person-requests, each with what its mission and packet are doing now. */
export async function readRequests(projectId: string): Promise<RequestReading[]> {
  const out: RequestReading[] = [];
  for (const request of await listOpenRequests(projectId)) {
    const mission = request.missionId ? await getMission(request.missionId) : null;
    const packet = mission?.orchestrationId ? await getOrchestration(mission.orchestrationId) : null;
    out.push({
      requestId: request.id,
      question: request.authorityNeeded.slice(0, 300),
      recommendation: request.recommendation?.slice(0, 300) ?? null,
      since: request.createdAt,
      ...moot({
        resumeKey: request.resumeKey,
        missionId: request.missionId,
        missionState: mission?.state ?? null,
        packetStatus: packet?.status ?? null,
      }),
    });
  }
  return out;
}

/** What the operator has done before, and what it learned: the record that stops a failure being rediscovered. */
export async function operatorHistory(goalId: string | null): Promise<Record<string, unknown>> {
  const runs = await recentOperatorRuns(5);
  const learnings = await listOperatorLearnings({ goalId, limit: 15 });
  const events = await getDb().all<{ event_type: string; payload: string; created_at: string }>(
    `SELECT event_type, payload, created_at FROM project_events
      WHERE event_type IN ('OPERATOR_WITHDREW_MOOT_REQUEST', 'OPERATOR_FIX_SUBMITTED', 'OPERATOR_FIX_NOT_STARTED', 'OPERATOR_RUN_FINISHED') ORDER BY created_at DESC LIMIT 20`,
    [],
  );
  return {
    runs: runs.map((run) => ({
      id: run.id,
      state: run.state,
      startedAt: run.startedAt,
      summary: run.summary?.slice(0, 600) ?? null,
      tools: run.toolCalls.map((call) => `${call.tool}${call.ok ? '' : ' (failed)'}`),
      error: run.error,
    })),
    learnings: learnings.map((one) => ({ goalId: one.goalId, lesson: one.lesson, evidence: one.evidence, at: one.recordedAt })),
    actions: events.map((event) => ({ type: event.event_type, at: event.created_at, payload: event.payload.slice(0, 400) })),
  };
}

/**
 * The goal's quantitative plan as Brain last read it (§77, §95, §99, §102): the
 * verdict, the chosen strategy, every strategy's sweep and conservative settled
 * figure, and the next test. Read from the stored reading — the operator does
 * not re-run the engine; the goal pass does that on its own cadence.
 */
export async function readGoalPlanSummary(goalId: string): Promise<Record<string, unknown>> {
  const { latestReading } = await import('../goals/plan.ts');
  const row = await latestReading(goalId);
  if (!row) {
    // A goal with no cash target is planned by `goals/objectivePlan.ts` (G-1).
    const { latestObjectiveReading } = await import('../../repos/objectiveReadings.ts');
    const objective = await latestObjectiveReading(goalId);
    if (objective) return { goalId, kind: 'OBJECTIVE', readAt: objective.createdAt, verdict: objective.verdict, chosenStrategy: objective.chosenStrategy, decision: objective.decision, interpretation: objective.interpretation, strategies: objective.strategies.slice(0, 8), error: objective.error };
    return { goalId, reading: null, note: 'Brain has no plan reading for this goal yet.' };
  }
  const parse = (text: string | null): unknown => {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(0, 600);
    }
  };
  const strategies = parse(row.strategies);
  return {
    goalId,
    readAt: row.created_at,
    verdict: row.verdict,
    chosenStrategy: row.chosen_strategy,
    strategies: Array.isArray(strategies)
      ? strategies.slice(0, 8).map((one: Record<string, unknown>) => ({
          key: one['key'], label: one['label'], verdict: one['verdict'],
          constraintsFailed: one['constraintsFailed'], sweep: one['sweep'], conservativeSettled: one['conservativeSettled'],
        }))
      : strategies,
    nextTest: parse(row.next_test),
    forecast: parse(row.forecast),
  };
}

/** Every integration Brain declares (§103) with its latest health reading: what the operator can rely on. */
export async function readIntegrations(): Promise<Record<string, unknown>[]> {
  const { INTEGRATIONS } = await import('../integrations/registry.ts');
  const { latestIntegrationEvent } = await import('../../repos/integrationEvents.ts');
  const out: Record<string, unknown>[] = [];
  for (const one of INTEGRATIONS) {
    const check = await latestIntegrationEvent(one.id, 'CHECK');
    out.push({
      id: one.id,
      name: one.name,
      capabilities: one.capabilities,
      health: check ? { state: check.state, at: check.recordedAt, detail: check.detail.slice(0, 200) } : null,
      ownerAction: one.ownerAction,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Acting
// ---------------------------------------------------------------------------

/**
 * Withdraw a person-request its mission no longer waits on.
 *
 * Production, 2026-11-12: the $10K goal read BLOCKED on four "accept a report
 * with unresolved questions" cards since 11-08. Each had been answered by
 * Brain's routine decision (§80), and each answer failed to apply because the
 * mission was no longer at NEEDS_HUMAN — and the failure *reopened* the card,
 * which the next tick answered again: a loop that can never settle, holding a
 * goal blocked on a person who has nothing to decide. A card whose mission has
 * moved on is moot; withdrawing it keeps the row (`WITHDRAWN`, with why) and
 * leaves a packet still parked to the passes that own it (`answerUnaskedParks`,
 * `concludeUnworkablePackets`), which act on a park no open card covers.
 *
 * Refused unless `moot` says so, re-read here rather than trusted from the
 * caller, and only on an OPEN card: an answer somebody gave is never reached
 * back through.
 */
export async function withdrawMootRequest(input: { requestId: string; runId: string | null; projectIds: string[] }): Promise<{ ok: boolean; reason: string }> {
  const request = await getHumanRequest(input.requestId);
  if (!request || !input.projectIds.includes(request.projectId)) return { ok: false, reason: 'no such open request in a project the operator directs' };
  if (request.state !== 'OPEN') return { ok: false, reason: `the request is ${request.state}, not OPEN` };
  const mission = request.missionId ? await getMission(request.missionId) : null;
  const packet = mission?.orchestrationId ? await getOrchestration(mission.orchestrationId) : null;
  const reading = moot({
    resumeKey: request.resumeKey,
    missionId: request.missionId,
    missionState: mission?.state ?? null,
    packetStatus: packet?.status ?? null,
  });
  if (!reading.moot) return { ok: false, reason: `not moot: ${reading.why}` };
  const reason = `Withdrawn by Brain's operator: ${reading.why}.`;
  const done = await withdrawRequest({ requestId: request.id, reason });
  if (!done) return { ok: false, reason: 'the request changed state before it could be withdrawn' };
  await recordEvent({
    projectId: request.projectId,
    entityType: 'PROJECT',
    entityId: request.projectId,
    eventType: 'OPERATOR_WITHDREW_MOOT_REQUEST',
    payload: { requestId: request.id, missionId: request.missionId, missionState: mission?.state ?? null, packetStatus: packet?.status ?? null, runId: input.runId, reason },
  });
  return { ok: true, reason };
}

type ContinuationPass = () => Promise<{ pools: { pool: string; waiting: number; running: number; capacity: number; idle: boolean; because: string }[]; recorded: string[]; continued: string[] }>;

/** The continuation pass now under way in this process, if any: a second call never starts another. */
let continuation: { startedAt: string; runId: string | null; promise: Promise<unknown> } | null = null;
/** How the last pass this process started ended: the next call reports it. */
let lastContinuation: { startedAt: string; finishedAt: string; runId: string | null; continued: string[]; recordedIdle: string[]; error: string | null } | null = null;

/**
 * How long the operator's call waits on the pass before returning what it
 * started. Production, 2026-11-13: `brain_operator_continue_idle` read every
 * pool live and then ran a dispatch pass inside the 180 s MCP call, during
 * event-loop stalls, and failed on the limit — the operator could not tell
 * whether anything moved.
 */
export const CONTINUE_WAIT_MS = 15_000;

/** Tests. */
export function forgetContinuation(): void {
  continuation = null;
  lastContinuation = null;
}

const poolView = (pool: { pool: string; waiting: number; running: number; capacity: number; idle: boolean; because: string }) => ({
  pool: pool.pool, waiting: pool.waiting, running: pool.running, capacity: pool.capacity, idle: pool.idle, because: pool.because,
});

/**
 * Continue every idle pool through its own scheduler (§98): the watchdog's own
 * pass (`watchUtilization`) — one guarded dispatch pass for routines and the
 * Factory line, the free lane controller's step — started in the background.
 * Returns within `waitMs` with what it started: the pass's result when it
 * finished in that time, otherwise that it is running, the last reading of the
 * pools with its age, and how the previous pass ended. Never a second pass
 * while one runs.
 */
export async function continueIdleCapacity(runId: string | null, options: { waitMs?: number; pass?: ContinuationPass } = {}): Promise<Record<string, unknown>> {
  const previous = lastContinuation;
  if (continuation) {
    return {
      runId,
      started: false,
      running: true,
      runningSince: continuation.startedAt,
      reason: `a continuation pass started at ${continuation.startedAt} is still running; a second was not started`,
      previous,
    };
  }
  const pass: ContinuationPass = options.pass ?? (async () => (await import('../engineering/watchdog.ts')).watchUtilization({ continueWork: true }));
  const startedAt = new Date().toISOString();
  const promise = pass()
    .then((result) => {
      lastContinuation = { startedAt, finishedAt: new Date().toISOString(), runId, continued: result.continued, recordedIdle: result.recorded, error: null };
      return result;
    })
    .catch((error: unknown) => {
      lastContinuation = { startedAt, finishedAt: new Date().toISOString(), runId, continued: [], recordedIdle: [], error: String((error as Error)?.message ?? error).slice(0, 300) };
      return null;
    })
    .finally(() => {
      if (continuation?.promise === promise) continuation = null;
    });
  continuation = { startedAt, runId, promise };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<'RUNNING'>((resolve) => {
    timer = setTimeout(() => resolve('RUNNING'), Math.max(0, options.waitMs ?? CONTINUE_WAIT_MS));
    (timer as { unref?: () => void }).unref?.();
  });
  const outcome = await Promise.race([promise, waited]);
  if (timer) clearTimeout(timer);
  const started = 'one continuation pass: every pool read, each idle one recorded, one guarded dispatch pass for ROUTINES/FACTORY and the free lane controller step for FREE_LANE';
  if (outcome === null) {
    return { runId, started, finished: true, failed: true, error: lastContinuation?.error ?? null, continued: [], previous };
  }
  if (outcome !== 'RUNNING') {
    return {
      runId,
      started,
      finished: true,
      pools: outcome.pools.map(poolView),
      recordedIdle: outcome.recorded,
      continued: outcome.continued,
      previous,
    };
  }
  const { cachedUtilization } = await import('../engineering/watchdog.ts');
  // The reading already held, never a second live read beside the pass that is making one.
  const held = cachedUtilization();
  return {
    runId,
    started,
    finished: false,
    running: true,
    startedAt,
    note: `the pass is still running after ${Math.round((options.waitMs ?? CONTINUE_WAIT_MS) / 1000)} s and continues in the background; nothing is reported as continued until it finishes — read brain_operator_capacity (or call this again for how it ended) in a minute`,
    lastReading: held?.pools ? { readAt: held.readAt, ageSeconds: held.ageSeconds, pools: held.pools.map(poolView) } : null,
    previous,
  };
}

export async function operatorRecordLearning(input: { goalId: string | null; runId: string | null; lesson: string; evidence: string }): Promise<{ id: string }> {
  const learning = await recordOperatorLearning(input);
  return { id: learning.id };
}
