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
      WHERE event_type LIKE 'OPERATOR_%' ORDER BY created_at DESC LIMIT 20`,
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

/** Continue every idle pool through its own scheduler (§98), and say what moved. */
export async function continueIdleCapacity(runId: string | null): Promise<Record<string, unknown>> {
  const { watchUtilization } = await import('../engineering/watchdog.ts');
  const result = await watchUtilization({ continueWork: true });
  return {
    runId,
    pools: result.pools.map((pool) => ({ pool: pool.pool, waiting: pool.waiting, running: pool.running, capacity: pool.capacity, idle: pool.idle, because: pool.because })),
    recordedIdle: result.recorded,
    continued: result.continued,
  };
}

export async function operatorRecordLearning(input: { goalId: string | null; runId: string | null; lesson: string; evidence: string }): Promise<{ id: string }> {
  const learning = await recordOperatorLearning(input);
  return { id: learning.id };
}
