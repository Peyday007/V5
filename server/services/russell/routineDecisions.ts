/**
 * Research parks Brain answers itself, under the standing authority a person
 * already granted (§80).
 *
 * A packet that stops for a person raises a Needs You card with at most three
 * answers: authorize a plan the envelope refused, file the audited report with
 * its unresolved questions named, or stop. Production, 2026-11-01: 293 packets
 * sat at NEEDS_HUMAN and the owner was asked about each one. Two of the three
 * answers stay inside what the standing research grant already authorizes:
 *
 *   - **RECORD_GAPS** files what the evidence gate already accepted, with what
 *     it could not settle named beside it. It spends nothing beyond the grant's
 *     own concurrency, lowers no bar and claims nothing was answered that was
 *     not.
 *   - **STOP** declines further work. It keeps every row and every accepted
 *     claim.
 *
 * The third, **APPROVE_PLAN**, is authorization the grant does not hold, and
 * Brain never gives it. For research Brain compiled for itself (a packet with
 * an approval envelope) the plan the envelope refused is declined instead —
 * stopping is within authority, widening it is not. A packet a person's own
 * research goal started keeps its card, because whether to widen it is theirs.
 *
 * What is never answered here: a card about something other than a mission
 * (a capability authority, a stopped opportunity to reconsider), a project
 * with no live standing grant, and a judge park Brain is about to correct by
 * itself (`assessJudgeRound` RESUME). A card younger than
 * `ROUTINE_DECISION_GRACE_MS` waits too, so the passes that repair a park
 * (a corrected round, an envelope asked again) act first.
 *
 * The answer is recorded against the grant's owner — whose authority it
 * carries — with the reason saying in words that Brain decided it and under
 * which grant. The existing `answered-requests` pass then carries it out
 * through the same guarded transitions a person's answer takes.
 */
import { getDb } from '../../db/database.ts';
import { recordEvent } from '../../repos/events.ts';
import { getOrchestration } from '../../repos/research.ts';
import { listGoals } from '../../repos/russellAuthority.ts';
import { answerHumanRequest, getHumanRequest, getMission } from '../../repos/russellMissions.ts';
import type { RussellHumanRequest, ResearchOrchestration } from '../../domain/types.ts';
import { NEEDS_HUMAN_CHOICES } from './needsHuman.ts';

/** How long a card waits before Brain answers it, so repair passes go first. */
export const ROUTINE_DECISION_GRACE_MS = 10 * 60_000;

const NOT_ABOUT_A_MISSION = ['capability-authority:', 'cash-reconsider:'];

export type RoutineChoice = 'RECORD_GAPS' | 'STOP';

/** The answer Brain gives a card, or null with why it is a person's. Pure. */
export function routineChoiceFor(input: {
  choiceKeys: readonly string[];
  /** The packet was compiled by Brain under an approval envelope. */
  brainCompiled: boolean;
}): { choice: RoutineChoice; why: string } | { choice: null; why: string } {
  const keys = new Set(input.choiceKeys);
  if (keys.has(NEEDS_HUMAN_CHOICES.RECORD_GAPS.key)) {
    return {
      choice: 'RECORD_GAPS',
      why:
        'the packet has accepted evidence and its repair ladder is spent, so its audited report is ' +
        'filed with the unresolved questions named rather than held open',
    };
  }
  if (keys.has(NEEDS_HUMAN_CHOICES.APPROVE_PLAN.key)) {
    if (!input.brainCompiled) {
      return { choice: null, why: 'widening a person’s own research goal is theirs to decide' };
    }
    if (!keys.has(NEEDS_HUMAN_CHOICES.STOP.key)) return { choice: null, why: 'no answer within authority is offered' };
    return {
      choice: 'STOP',
      why:
        'the plan falls outside the envelope Brain may approve itself, and widening an envelope is ' +
        'not within the standing grant — so this research is declined and its rows are kept',
    };
  }
  if (keys.has(NEEDS_HUMAN_CHOICES.STOP.key)) {
    return {
      choice: 'STOP',
      why: 'nothing in the packet cleared its evidence gate, so there is no report to file and the work is stopped',
    };
  }
  return { choice: null, why: 'no answer within authority is offered' };
}

export interface RoutineDecision {
  requestId: string;
  missionId: string | null;
  choice: RoutineChoice | null;
  reason: string;
}

/** Answer every routine research park old enough to answer. Idempotent by the request's own state. */
export async function answerRoutineParks(input: {
  limit?: number;
  nowMs?: number;
} = {}): Promise<RoutineDecision[]> {
  const nowMs = input.nowMs ?? Date.now();
  const cutoff = new Date(nowMs - ROUTINE_DECISION_GRACE_MS).toISOString();
  const rows = await getDb().all<{ id: string }>(
    `SELECT id FROM russell_human_requests
      WHERE state = 'OPEN' AND mission_id IS NOT NULL AND created_at <= ?
      ORDER BY created_at ASC, id ASC LIMIT ?`,
    [cutoff, input.limit ?? 200],
  );
  const owners = new Map<string, { goalId: string; name: string; ownerUserId: string } | null>();
  const out: RoutineDecision[] = [];
  for (const row of rows) {
    const request = await getHumanRequest(row.id);
    if (!request || request.state !== 'OPEN' || !request.missionId) continue;
    const decision = await decide(request, owners, nowMs);
    out.push(decision);
  }
  return out;
}

async function decide(
  request: RussellHumanRequest,
  owners: Map<string, { goalId: string; name: string; ownerUserId: string } | null>,
  nowMs: number,
): Promise<RoutineDecision> {
  const base = { requestId: request.id, missionId: request.missionId };
  if (NOT_ABOUT_A_MISSION.some((prefix) => request.resumeKey.startsWith(prefix))) {
    return { ...base, choice: null, reason: 'not a research park' };
  }
  if (!owners.has(request.projectId)) {
    const now = new Date(nowMs).toISOString();
    const live = (await listGoals(request.projectId)).find(
      (goal) => goal.state === 'ACTIVE' && (!goal.expiresAt || goal.expiresAt > now),
    );
    owners.set(request.projectId, live ? { goalId: live.id, name: live.name, ownerUserId: live.ownerUserId } : null);
  }
  const grant = owners.get(request.projectId) ?? null;
  if (!grant) return { ...base, choice: null, reason: 'the project has no live standing research grant' };

  const mission = await getMission(request.missionId!);
  const orchestration: ResearchOrchestration | null = mission?.orchestrationId
    ? await getOrchestration(mission.orchestrationId)
    : null;
  if (orchestration) {
    const { assessJudgeRound } = await import('../research/judgeRound.ts');
    const assessment = await assessJudgeRound(orchestration);
    if (assessment.kind === 'RESUME') {
      return { ...base, choice: null, reason: 'Brain is about to run a corrected round on it' };
    }
  }

  const picked = routineChoiceFor({
    choiceKeys: request.choices.map((choice) => choice.key),
    brainCompiled: orchestration?.approvalEnvelopeId != null,
  });
  if (picked.choice === null) return { ...base, choice: null, reason: picked.why };

  const reason = `Decided by Brain under the standing research grant “${grant.name}” (${grant.goalId}): ${picked.why}.`;
  const answered = await answerHumanRequest({
    requestId: request.id,
    actorUserId: grant.ownerUserId,
    choice: picked.choice,
    reason,
  });
  if (!answered.ok) return { ...base, choice: null, reason: answered.reason };
  await recordEvent({
    projectId: request.projectId,
    entityType: 'PROJECT',
    entityId: request.projectId,
    eventType: 'RUSSELL_ROUTINE_DECISION',
    payload: {
      requestId: request.id,
      missionId: request.missionId,
      orchestrationId: orchestration?.id ?? null,
      choice: picked.choice,
      grantId: grant.goalId,
      decidedBy: 'BRAIN_UNDER_STANDING_AUTHORITY',
      reason,
    },
  });
  return { ...base, choice: picked.choice, reason };
}
